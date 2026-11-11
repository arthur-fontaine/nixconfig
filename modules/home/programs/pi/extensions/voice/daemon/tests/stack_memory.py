"""The call stack's memory, as the daemon loads it: `footprint` after each model and after real work.

    uv run python tests/stack_memory.py [clipdir]

Also times each step on a real clip: the end-of-turn check, the transcription,
and Voxtral's time to first audio.
"""

import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

clips = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/k12-clips")


def footprint(label: str) -> None:
    out = subprocess.run(["footprint", "-p", str(os.getpid())], capture_output=True, text=True).stdout
    line = next((l for l in out.splitlines() if "phys_footprint:" in l), "?")
    print(f"{label:40s} {line.strip()}", flush=True)


footprint("python")
import mlx.core as mx  # noqa: E402

from pi_voice.models import EndOfTurn, Stt, Tts  # noqa: E402
from pi_voice.vad import Vad  # noqa: E402

audio, _ = sf.read(str(clips / "fr1.wav"), dtype="float32")
vad = Vad()
footprint("+ Silero VAD")
eot = EndOfTurn()
footprint("+ VoxTurn (MLX) + Smart Turn")
stt = Stt()
footprint("+ Whisper large-v3-turbo")
tts = Tts()
footprint("+ Voxtral 4B TTS (4-bit)")

t0 = time.perf_counter()
for _ in range(5):
    eot(audio, "tu peux lancer pnpm install")
print(f"end-of-turn check: {1000 * (time.perf_counter() - t0) / 5:.0f} ms")
t0 = time.perf_counter()
print(stt(audio).text, f"({1000 * (time.perf_counter() - t0):.0f} ms)")
t0 = time.perf_counter()
first = None
for chunk in tts.stream("J'ai trouvé la cause : le footer lisait l'ancienne clé de configuration. Tu veux que je fasse le commit ?", "fr"):
    first = first or time.perf_counter() - t0
print(f"Voxtral: first audio {1000 * first:.0f} ms, whole sentence {1000 * (time.perf_counter() - t0):.0f} ms")
footprint("after a turn (warm)")
print(f"MLX active {mx.get_active_memory() / 1e9:.2f} GB, cache {mx.get_cache_memory() / 1e9:.2f} GB, peak {mx.get_peak_memory() / 1e9:.2f} GB")
mx.clear_cache()
footprint("after mx.clear_cache()")
