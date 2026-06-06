/**
 * P1 - Audio Capture (Offscreen API).
 *
 * Lifecycle:
 *   1. Background creates this document on `session.start` and immediately
 *      sends an `offscreen.start` message with { sessionId, liveStreamUrl, streamId }.
 *   2. We open a WebSocket to FastAPI's `/api/live-stream/{sessionId}`.
 *   3. We capture TWO audio sources and fan them into discrete channels:
 *        - channel 0: the local microphone (the person running the tool).
 *          Without this, the tool only ever "hears" the remote participant,
 *          because a meeting app never plays your own voice back into the tab.
 *        - channel 1: the meeting tab audio (the remote participant).
 *      Both run through an AudioContext at its NATIVE sample rate (we report
 *      that exact rate to the backend instead of forcing 16 kHz, which used to
 *      cause garbled / wrong-pitch audio), and through a ChannelMergerNode into
 *      an AudioWorklet PCM16 encoder that posts ~250 ms channel-interleaved
 *      ArrayBuffer chunks which we relay over the WebSocket as binary frames.
 *   4. We also keep the meeting audible (tab -> destination) and relay a periodic
 *      RMS level so the side panel can show a live capture meter.
 *   5. On `offscreen.stop` we tear everything down cleanly.
 *
 * If the microphone is unavailable (permission denied / no device) we degrade
 * gracefully to single-channel tab-only capture and tell the side panel.
 */

import type { RuntimeMessage } from "@/lib/messaging";

let socket: WebSocket | null = null;
let tabStream: MediaStream | null = null;
let micStream: MediaStream | null = null;
let audioContext: AudioContext | null = null;
let workletNode: AudioWorkletNode | null = null;
let tabSourceNode: MediaStreamAudioSourceNode | null = null;
let micSourceNode: MediaStreamAudioSourceNode | null = null;
let mergerNode: ChannelMergerNode | null = null;
let lastLevelSentAt = 0;
let lastMicError = "";

chrome.runtime.sendMessage({ kind: "offscreen.ready" } satisfies RuntimeMessage).catch(() => {
  /* background may not be listening yet - safe to ignore */
});

chrome.runtime.onMessage.addListener((raw: RuntimeMessage) => {
  if (raw.kind === "offscreen.start") {
    void startCapture(raw.sessionId, raw.liveStreamUrl, raw.streamId);
  } else if (raw.kind === "offscreen.stop") {
    void stopCapture();
  }
});

async function startCapture(
  sessionId: string,
  liveStreamUrl: string,
  streamId: string,
): Promise<void> {
  await stopCapture(); // safety - clean any previous run

  try {
    // 1) Tab audio (the remote participant). Chrome's tab-capture flow uses a
    // non-standard `mandatory` shape the standard types don't model.
    const tabConstraints = {
      audio: {
        mandatory: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    } as unknown as MediaStreamConstraints;

    tabStream = await navigator.mediaDevices.getUserMedia(tabConstraints);

    // 2) Local microphone (the person running the tool). This is best-effort:
    // if it fails we still transcribe the remote side. The side panel triggers
    // the permission prompt before we get here so this usually succeeds.
    micStream = await captureMicrophone();
    const channels = micStream ? 2 : 1;

    // 3) Use the NATIVE sample rate. Forcing 16 kHz previously produced garbled
    // audio when the device couldn't honor the request. We report the real rate.
    audioContext = new AudioContext();
    const sampleRate = audioContext.sampleRate;

    tabSourceNode = audioContext.createMediaStreamSource(tabStream);
    // Keep the meeting audible to the user - tab capture otherwise mutes it.
    // NOTE: we deliberately do NOT route the mic to the destination, otherwise
    // the user would hear themselves echo back.
    tabSourceNode.connect(audioContext.destination);

    const workletUrl = chrome.runtime.getURL("audio-processor.js");
    await audioContext.audioWorklet.addModule(workletUrl);

    workletNode = new AudioWorkletNode(audioContext, "pcm16-encoder", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: channels,
      channelCountMode: "explicit",
      channelInterpretation: "discrete",
      processorOptions: { channels },
    });
    workletNode.port.onmessage = (
      event: MessageEvent<{ type: "audio"; buffer: ArrayBuffer; rms: number }>,
    ) => {
      const data = event.data;
      if (!data || data.type !== "audio") return;
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(data.buffer);
      }
      relayLevel(data.rms);
    };

    if (channels === 2 && micStream) {
      micSourceNode = audioContext.createMediaStreamSource(micStream);
      mergerNode = audioContext.createChannelMerger(2);
      // mic -> channel 0, tab -> channel 1
      micSourceNode.connect(mergerNode, 0, 0);
      tabSourceNode.connect(mergerNode, 0, 1);
      mergerNode.connect(workletNode);
    } else {
      tabSourceNode.connect(workletNode);
    }

    // 4) Open the socket last, so onopen can report the real rate/channels.
    socket = new WebSocket(liveStreamUrl);
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      socket?.send(
        JSON.stringify({
          type: "session.start",
          session_id: sessionId,
          sample_rate: sampleRate,
          channels,
          multichannel: channels > 1,
        }),
      );
    };
    socket.onerror = (event) => {
      console.error("[offscreen] websocket error", event);
      void notify({ kind: "offscreen.error", message: "WebSocket error" });
    };
    socket.onclose = () => {
      console.info("[offscreen] websocket closed");
    };

    await notify({ kind: "offscreen.started" });
    if (!micStream) {
      await notify({
        kind: "offscreen.error",
        message:
          "Microphone unavailable - only the remote (tab) audio will be transcribed. " +
          (lastMicError ? `Reason: ${lastMicError}. ` : "") +
          "Grant mic access and restart to capture your own voice.",
      });
    }
    console.info("[offscreen] capture started", { sessionId, sampleRate, channels });
  } catch (err) {
    console.error("[offscreen] startCapture failed", err);
    await notify({
      kind: "offscreen.error",
      message: err instanceof Error ? err.message : String(err),
    });
    await stopCapture();
  }
}

async function captureMicrophone(): Promise<MediaStream | null> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });
    lastMicError = "";
    return stream;
  } catch (err) {
    // Record the DOMException name/message so the side panel can show the real
    // cause (e.g. NotAllowedError vs NotReadableError) instead of "unavailable".
    lastMicError =
      err instanceof DOMException
        ? `${err.name}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    console.warn("[offscreen] microphone capture failed - falling back to tab-only", err);
    return null;
  }
}

function relayLevel(rms: number): void {
  const now = Date.now();
  // Throttle to ~5 Hz; the meter doesn't need every 250 ms frame.
  if (now - lastLevelSentAt < 200) return;
  lastLevelSentAt = now;
  void notify({ kind: "offscreen.audio-level", rms });
}

async function stopCapture(): Promise<void> {
  try {
    if (workletNode) {
      try {
        workletNode.port.onmessage = null;
        workletNode.disconnect();
      } catch {
        /* ignore */
      }
      workletNode = null;
    }
    if (mergerNode) {
      try {
        mergerNode.disconnect();
      } catch {
        /* ignore */
      }
      mergerNode = null;
    }
    if (tabSourceNode) {
      try {
        tabSourceNode.disconnect();
      } catch {
        /* ignore */
      }
      tabSourceNode = null;
    }
    if (micSourceNode) {
      try {
        micSourceNode.disconnect();
      } catch {
        /* ignore */
      }
      micSourceNode = null;
    }
    if (tabStream) {
      tabStream.getTracks().forEach((track) => track.stop());
      tabStream = null;
    }
    if (micStream) {
      micStream.getTracks().forEach((track) => track.stop());
      micStream = null;
    }
    if (audioContext) {
      try {
        await audioContext.close();
      } catch {
        /* ignore */
      }
      audioContext = null;
    }
    if (socket) {
      try {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.close();
        }
      } catch {
        /* ignore */
      }
      socket = null;
    }
  } catch (err) {
    console.warn("[offscreen] stopCapture cleanup error", err);
  }
}

async function notify(message: RuntimeMessage): Promise<void> {
  try {
    await chrome.runtime.sendMessage(message);
  } catch {
    /* background may have torn down already */
  }
}
