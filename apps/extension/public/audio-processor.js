// PCM16 encoder running inside an AudioWorklet.
//
// Input:  Float32 audio frames at the AudioContext's *native* sample rate.
//         We no longer pin the context to 16 kHz on the offscreen side, because
//         forcing the context to 16 kHz produced low-quality (and sometimes
//         wrong-rate) audio. We instead capture at the native rate and tell
//         Deepgram exactly what that rate is.
//
// Channels: the offscreen document connects up to 2 discrete channels through a
//         ChannelMergerNode:
//           channel 0 = local microphone (the person running the tool)
//           channel 1 = meeting tab audio (the remote participant)
//         When the microphone is unavailable we fall back to 1 channel (tab).
//
// Output: Int16 PCM, channel-interleaved, posted as `{ type: "audio", buffer }`
//         roughly every 250 ms, plus a periodic `{ type: "level", rms }` so the
//         side panel can show a live "is audio flowing" meter.

const FRAME_MS = 250;

class PCM16Encoder extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this._channels = Math.max(1, opts.channels || 1);
    // `sampleRate` is a global available inside AudioWorkletGlobalScope.
    this._frameSamples = Math.max(1, Math.round((sampleRate * FRAME_MS) / 1000));
    this._buffers = [];
    for (let c = 0; c < this._channels; c++) {
      this._buffers.push(new Float32Array(this._frameSamples));
    }
    this._idx = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0]) return true;

    const frames = input[0].length;
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < this._channels; c++) {
        // If a channel is momentarily absent, fall back to channel 0 so we
        // never write `undefined` into the buffer.
        const chData = input[c] || input[0];
        this._buffers[c][this._idx] = chData[i];
      }
      this._idx++;

      if (this._idx >= this._frameSamples) {
        const out = new Int16Array(this._frameSamples * this._channels);
        let sumSq = 0;
        for (let s = 0; s < this._frameSamples; s++) {
          for (let c = 0; c < this._channels; c++) {
            let v = this._buffers[c][s];
            if (v > 1) v = 1;
            else if (v < -1) v = -1;
            out[s * this._channels + c] = v < 0 ? v * 0x8000 : v * 0x7fff;
            sumSq += v * v;
          }
        }
        const rms = Math.sqrt(sumSq / (this._frameSamples * this._channels));
        this.port.postMessage({ type: "audio", buffer: out.buffer, rms }, [out.buffer]);
        this._idx = 0;
      }
    }
    return true;
  }
}

registerProcessor("pcm16-encoder", PCM16Encoder);
