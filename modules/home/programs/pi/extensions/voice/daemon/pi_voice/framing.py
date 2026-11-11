"""The byte protocol between the daemon and its audio helper (the Swift one, or the fake one in tests).

One frame = 1 byte kind, 4 bytes little-endian payload length, the payload.

Helper -> daemon:
- b"M": microphone audio, int16 LE mono 16 kHz (any length, typically 20 ms);
- b"E": a JSON event: {"event": "ready" | "mic_open" | "mic_closed" | "played" | "drained" | "error", ...}.
  "played" carries the `seq` of a speaker buffer that finished playing; "drained": nothing left to play.

Daemon -> helper:
- b"S": speaker audio: 4 bytes LE `seq`, 1 byte kind (0 speech, 1 earcon), int16 LE mono 24 kHz;
- b"C": a JSON command: {"cmd": "mic", "on": bool} | {"cmd": "stop"} (drop all queued audio) |
  {"cmd": "gain", "value": 0..1} (duck the speech while the person may be interrupting).
"""

import asyncio
import json
import struct

MIC, EVENT, SPEAKER, CONTROL = b"M", b"E", b"S", b"C"
SPEECH, EARCON = 0, 1
MIC_RATE, SPEAKER_RATE = 16000, 24000


def frame(kind: bytes, payload: bytes) -> bytes:
    return kind + struct.pack("<I", len(payload)) + payload


def json_frame(kind: bytes, obj: dict) -> bytes:
    return frame(kind, json.dumps(obj).encode())


def speaker_frame(seq: int, kind: int, pcm16: bytes) -> bytes:
    return frame(SPEAKER, struct.pack("<IB", seq, kind) + pcm16)


def parse_speaker(payload: bytes) -> tuple[int, int, bytes]:
    seq, kind = struct.unpack("<IB", payload[:5])
    return seq, kind, payload[5:]


async def read_frame(reader: asyncio.StreamReader) -> tuple[bytes, bytes] | None:
    try:
        head = await reader.readexactly(5)
        return head[:1], await reader.readexactly(struct.unpack("<I", head[1:])[0])
    except asyncio.IncompleteReadError:
        return None
