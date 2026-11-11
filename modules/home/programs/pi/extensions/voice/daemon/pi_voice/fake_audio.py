"""A stand-in for the Swift audio helper, for tests: WAV files instead of the mic, a file instead of the speakers.

Same stdio protocol as the real helper (framing.py). The mic streams in real
time: silence, or a WAV the harness asked for. What the daemon plays is
"played" on a clock at real speed, so `played` and `drained` come when a
speaker would have finished, and written to --out (24 kHz WAV).

A control socket (--control) lets the harness drive it, one JSON per line:
  harness -> {"cmd": "play", "path": wav} | {"cmd": "loopback", "db": -10}
  helper  -> {"event": "mic_open" | "mic_closed" | "played" (path, start, end) |
              "tts_start" | "tts_end" | "tts_stop", "t": time.time(), ...}
With loopback on, what it plays is mixed back into the mic (resampled to
16 kHz, attenuated), as speakers heard by the mic would be without echo
cancellation.
"""

import argparse
import asyncio
import json
import sys
import time
import wave

import numpy as np

from . import framing

MIC_CHUNK = 320  # 20 ms at 16 kHz


class FakeAudio:
    def __init__(self, control: str, out: str | None):
        self.control_path, self.out_path = control, out
        self.watchers: list[asyncio.StreamWriter] = []
        self.mic_on = False
        self.playing_mic: tuple[np.ndarray, int, str] | None = None
        self.speaker: list[tuple[int, int, np.ndarray]] = []  # seq, kind, samples (24 kHz float)
        self.speaker_pos = 0
        self.tts_active = False
        self.loopback_gain = 0.0
        self.echo = np.zeros(0, np.float32)
        self.out = None
        if out:
            self.out = wave.open(out, "wb")
            self.out.setnchannels(1)
            self.out.setsampwidth(2)
            self.out.setframerate(framing.SPEAKER_RATE)

    def notify(self, obj: dict) -> None:
        line = (json.dumps({**obj, "t": time.time()}) + "\n").encode()
        for w in list(self.watchers):
            try:
                w.write(line)
            except Exception:
                self.watchers.remove(w)

    def send(self, data: bytes) -> None:
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()

    async def control(self, reader, writer):
        self.watchers.append(writer)
        while line := await reader.readline():
            cmd = json.loads(line)
            if cmd.get("cmd") == "play":
                import soundfile as sf
                audio, sr = sf.read(cmd["path"], dtype="float32")
                assert sr == framing.MIC_RATE, f"{cmd['path']}: {sr} Hz, want 16 kHz"
                self.playing_mic = (audio, 0, cmd["path"])
                self.notify({"event": "playing", "path": cmd["path"]})
            elif cmd.get("cmd") == "loopback":
                self.loopback_gain = 10 ** (cmd.get("db", -10) / 20) if cmd.get("on", True) else 0.0

    async def daemon_input(self):
        reader = asyncio.StreamReader()
        await asyncio.get_running_loop().connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
        while (got := await framing.read_frame(reader)) is not None:
            kind, payload = got
            if kind == framing.SPEAKER:
                seq, k, pcm = framing.parse_speaker(payload)
                samples = np.frombuffer(pcm, "<i2").astype(np.float32) / 32768
                self.speaker.append((seq, k, samples))
                if self.out:
                    self.out.writeframes(pcm)
                if k == framing.SPEECH and not self.tts_active:
                    self.tts_active = True
                    self.notify({"event": "tts_start"})
            elif kind == framing.CONTROL:
                cmd = json.loads(payload)
                if cmd.get("cmd") == "mic":
                    self.mic_on = bool(cmd.get("on"))
                    self.notify({"event": "mic_open" if self.mic_on else "mic_closed"})
                elif cmd.get("cmd") == "stop":
                    self.speaker.clear()
                    self.speaker_pos = 0
                    if self.tts_active:
                        self.tts_active = False
                        self.notify({"event": "tts_stop"})
                    self.send(framing.json_frame(framing.EVENT, {"event": "drained"}))
                elif cmd.get("cmd") == "gain":
                    self.notify({"event": "gain", "value": cmd.get("value")})
        asyncio.get_running_loop().stop()

    def _speaker_tick(self, seconds: float) -> np.ndarray:
        """Advances playback by `seconds`; returns what played (24 kHz) for the loopback."""
        n = int(seconds * framing.SPEAKER_RATE)
        played = []
        while n > 0 and self.speaker:
            seq, kind, samples = self.speaker[0]
            take = min(n, len(samples) - self.speaker_pos)
            played.append(samples[self.speaker_pos:self.speaker_pos + take])
            self.speaker_pos += take
            n -= take
            if self.speaker_pos >= len(samples):
                self.speaker.pop(0)
                self.speaker_pos = 0
                self.send(framing.json_frame(framing.EVENT, {"event": "played", "seq": seq}))
                if not self.speaker:
                    self.send(framing.json_frame(framing.EVENT, {"event": "drained"}))
                    if self.tts_active:
                        self.tts_active = False
                        self.notify({"event": "tts_end"})
        return np.concatenate(played) if played else np.zeros(0, np.float32)

    async def clock(self):
        step = MIC_CHUNK / framing.MIC_RATE
        next_t = time.monotonic()
        while True:
            next_t += step
            await asyncio.sleep(max(0.0, next_t - time.monotonic()))
            played = self._speaker_tick(step)
            if self.loopback_gain and len(played):
                idx = np.arange(0, len(played), framing.SPEAKER_RATE / framing.MIC_RATE).astype(int)
                self.echo = np.concatenate([self.echo, played[idx] * self.loopback_gain])
            chunk = np.zeros(MIC_CHUNK, np.float32)
            if self.playing_mic:
                audio, pos, path = self.playing_mic
                part = audio[pos:pos + MIC_CHUNK]
                chunk[:len(part)] = part
                if pos + MIC_CHUNK >= len(audio):
                    self.playing_mic = None
                    self.notify({"event": "played", "path": path, "end": time.time()})
                else:
                    self.playing_mic = (audio, pos + MIC_CHUNK, path)
            if len(self.echo):
                e = self.echo[:MIC_CHUNK]
                chunk[:len(e)] += e
                self.echo = self.echo[MIC_CHUNK:]
            if self.mic_on:
                self.send(framing.frame(framing.MIC, (np.clip(chunk, -1, 1) * 32767).astype("<i2").tobytes()))

    async def main(self):
        await asyncio.start_unix_server(self.control, path=self.control_path)
        self.send(framing.json_frame(framing.EVENT, {"event": "ready"}))
        await asyncio.gather(self.daemon_input(), self.clock())


def main() -> None:
    p = argparse.ArgumentParser(prog="pi-voice-fake-audio")
    p.add_argument("--control", required=True)
    p.add_argument("--out")
    args = p.parse_args()
    try:
        asyncio.run(FakeAudio(args.control, args.out).main())
    except RuntimeError:  # the loop stopped: the daemon closed our stdin
        pass


if __name__ == "__main__":
    main()
