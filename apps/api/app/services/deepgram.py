"""P4 - Streaming transcription via Deepgram Nova-2.

Uses the Deepgram Python SDK's async WebSocket client. Audio chunks (16-bit PCM,
16 kHz, mono) arrive from the Chrome extension's offscreen capture, are
forwarded to Deepgram, and Deepgram's transcript callbacks push events onto
an internal queue that `routers/live_stream.py` consumes.

If `DEEPGRAM_API_KEY` is not set we fall back to a tiny synthetic stream so
the rest of the pipeline still works for dev/demo without credentials.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any

import structlog

from app.config import get_settings
from app.models.transcript import Speaker

log = structlog.get_logger(__name__)


class TranscriptEvent:
    __slots__ = ("session_id", "speaker", "text", "start_ms", "end_ms", "is_final", "ts")

    def __init__(
        self,
        *,
        session_id: uuid.UUID,
        speaker: Speaker,
        text: str,
        start_ms: int,
        end_ms: int,
        is_final: bool,
    ) -> None:
        self.session_id = session_id
        self.speaker = speaker
        self.text = text
        self.start_ms = start_ms
        self.end_ms = end_ms
        self.is_final = is_final
        self.ts = datetime.utcnow()


class DeepgramStream:
    """Async wrapper around a Deepgram live transcription session."""

    def __init__(
        self,
        *,
        session_id: uuid.UUID,
        sample_rate: int = 16000,
        channels: int = 1,
        keywords: list[str] | None = None,
        channel_speakers: dict[int, Speaker] | None = None,
    ) -> None:
        self.session_id = session_id
        self.sample_rate = sample_rate
        self.channels = max(1, channels)
        self.keywords = keywords or []
        # When we capture two channels, channel 0 is the local microphone (the
        # person running the tool, typically the interviewer) and channel 1 is
        # the meeting tab audio (the remote participant, typically the
        # candidate). This gives us reliable speaker labels without diarization.
        self.channel_speakers = channel_speakers or {
            0: Speaker.INTERVIEWER,
            1: Speaker.CANDIDATE,
        }
        self._queue: asyncio.Queue[TranscriptEvent] = asyncio.Queue()
        self._closed = False
        self._settings = get_settings()
        self._connection: Any | None = None
        self._fake_task: asyncio.Task[None] | None = None
        self._loop = asyncio.get_event_loop()

    async def start(self) -> None:
        if not self._settings.deepgram_api_key:
            log.warning(
                "deepgram_key_missing",
                msg="DEEPGRAM_API_KEY not set - emitting synthetic transcripts.",
                session_id=str(self.session_id),
            )
            self._fake_task = asyncio.create_task(self._fake_loop())
            return

        try:
            await self._start_real()
        except Exception as exc:  # noqa: BLE001
            log.exception(
                "deepgram_start_failed_falling_back_to_fake",
                session_id=str(self.session_id),
                error=str(exc),
            )
            self._fake_task = asyncio.create_task(self._fake_loop())

    async def _start_real(self) -> None:
        # Imports are local so the module still imports cleanly when the
        # SDK isn't installed (e.g. during type-checking).
        from deepgram import DeepgramClient, LiveOptions, LiveTranscriptionEvents

        try:
            from deepgram import DeepgramClientOptions
        except ImportError:
            DeepgramClientOptions = None

        if DeepgramClientOptions is None:
            client = DeepgramClient(self._settings.deepgram_api_key)
        else:
            client = DeepgramClient(
                self._settings.deepgram_api_key,
                DeepgramClientOptions(options={"keepalive": "true"}),
            )

        # SDK v3 surfaces async websocket under either `asyncwebsocket` or
        # `asynclive` depending on minor version. Try newer first.
        listen = client.listen
        if hasattr(listen, "asyncwebsocket"):
            connection = listen.asyncwebsocket.v("1")
        elif hasattr(listen, "asynclive"):
            connection = listen.asynclive.v("1")
        else:
            raise RuntimeError("deepgram-sdk does not expose an async live client")

        self._connection = connection

        async def _on_transcript(_self: Any, result: Any, **_kwargs: Any) -> None:
            try:
                alt = result.channel.alternatives[0]
                text = (alt.transcript or "").strip()
                if not text:
                    return
                start = float(getattr(result, "start", 0.0) or 0.0)
                duration = float(getattr(result, "duration", 0.0) or 0.0)
                is_final = bool(getattr(result, "is_final", False))
                speaker = self._resolve_speaker(result)
                await self._queue.put(
                    TranscriptEvent(
                        session_id=self.session_id,
                        speaker=speaker,
                        text=text,
                        start_ms=int(start * 1000),
                        end_ms=int((start + duration) * 1000),
                        is_final=is_final,
                    )
                )
            except Exception as exc:  # noqa: BLE001
                log.exception(
                    "deepgram_on_transcript_error",
                    session_id=str(self.session_id),
                    error=str(exc),
                )

        async def _on_error(_self: Any, error: Any, **_kwargs: Any) -> None:
            log.error(
                "deepgram_error",
                session_id=str(self.session_id),
                error=str(error),
            )

        async def _on_close(_self: Any, *_args: Any, **_kwargs: Any) -> None:
            log.info("deepgram_closed", session_id=str(self.session_id))

        connection.on(LiveTranscriptionEvents.Transcript, _on_transcript)
        connection.on(LiveTranscriptionEvents.Error, _on_error)
        connection.on(LiveTranscriptionEvents.Close, _on_close)

        option_kwargs: dict[str, Any] = dict(
            model=self._settings.deepgram_model,
            language="en-US",
            smart_format=True,
            punctuate=True,
            interim_results=True,
            encoding="linear16",
            sample_rate=self.sample_rate,
            channels=self.channels,
            vad_events=True,
            # Longer endpointing avoids chopping speakers mid-sentence, and
            # utterance_end_ms gives us a clean end-of-turn signal so finals
            # aren't fragmented into half-thoughts.
            endpointing=400,
            utterance_end_ms=1000,
            keywords=self.keywords,
        )
        if self.channels > 1:
            # Each channel is transcribed independently and tagged with a
            # channel index, which we map back to a speaker.
            option_kwargs["multichannel"] = True
        options = LiveOptions(**option_kwargs)
        started = await connection.start(options)
        if not started:
            raise RuntimeError("Deepgram connection.start() returned False")
        log.info(
            "deepgram_started",
            session_id=str(self.session_id),
            model=self._settings.deepgram_model,
            sample_rate=self.sample_rate,
            channels=self.channels,
            multichannel=self.channels > 1,
            keywords=len(self.keywords),
        )

    def _resolve_speaker(self, result: Any) -> Speaker:
        """Map a multichannel result's channel index back to a speaker.

        Single-channel sessions can't be attributed, so they stay UNKNOWN.
        """
        if self.channels <= 1:
            return Speaker.UNKNOWN
        channel_index = getattr(result, "channel_index", None)
        index = 0
        try:
            if isinstance(channel_index, (list, tuple)) and channel_index:
                index = int(channel_index[0])
            elif channel_index is not None:
                index = int(channel_index)
        except (TypeError, ValueError):
            index = 0
        return self.channel_speakers.get(index, Speaker.UNKNOWN)

    async def send_audio(self, chunk: bytes) -> None:
        if self._closed:
            return
        if self._connection is not None:
            try:
                await self._connection.send(chunk)
            except Exception as exc:  # noqa: BLE001
                log.warning(
                    "deepgram_send_failed",
                    session_id=str(self.session_id),
                    error=str(exc),
                )

    async def events(self) -> AsyncIterator[TranscriptEvent]:
        while not self._closed:
            try:
                event = await asyncio.wait_for(self._queue.get(), timeout=1.0)
            except asyncio.TimeoutError:
                if self._closed:
                    break
                continue
            yield event

    async def aclose(self) -> None:
        self._closed = True
        if self._fake_task is not None:
            self._fake_task.cancel()
            try:
                await self._fake_task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        if self._connection is not None:
            try:
                await self._connection.finish()
            except Exception as exc:  # noqa: BLE001
                log.warning(
                    "deepgram_finish_failed",
                    session_id=str(self.session_id),
                    error=str(exc),
                )
            self._connection = None

    async def _fake_loop(self) -> None:
        counter = 0
        try:
            while not self._closed:
                await asyncio.sleep(1.0)
                counter += 1
                await self._queue.put(
                    TranscriptEvent(
                        session_id=self.session_id,
                        speaker=Speaker.CANDIDATE if counter % 2 else Speaker.INTERVIEWER,
                        text=f"[skeleton transcript chunk #{counter}]",
                        start_ms=(counter - 1) * 1000,
                        end_ms=counter * 1000,
                        is_final=counter % 3 == 0,
                    )
                )
        except asyncio.CancelledError:
            pass
