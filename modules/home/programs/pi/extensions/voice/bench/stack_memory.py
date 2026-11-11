"""Memory of the recommended stack in one daemon process: every model loaded and warmed once.

    python stack_memory.py [clipdir]

Prints macOS `footprint` (physical footprint, what Activity Monitor calls Memory)
after each model, so the cost of each is visible. Uses the mlx venv (it has torch too).
"""

import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

clips = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/k12-clips")
audio, sr = sf.read(str(clips / "fr1.wav"), dtype="float32")


def footprint(label: str) -> None:
    out = subprocess.run(["footprint", "-p", str(__import__("os").getpid())], capture_output=True, text=True).stdout
    line = next((l for l in out.splitlines() if "phys_footprint:" in l), out.strip().splitlines()[-1] if out.strip() else "?")
    print(f"{label:34s} {line.strip()}")


footprint("python + numpy")

from mlx_audio.stt import load as load_stt
stt = load_stt("mlx-community/parakeet-tdt-0.6b-v3")
stt.generate(str(clips / "fr1.wav"))
footprint("+ Parakeet TDT v3 (warm)")

from mlx_audio.tts.utils import load_model
tts = load_model("mlx-community/ZONOS3-Mini")
for _ in tts.generate(text="D'accord, je regarde.", voice="gaspard", lang_code="fr", stream=True, streaming_interval=0.5):
    pass
footprint("+ ZONOS3-Mini (warm)")

import torch
from silero_vad import load_silero_vad
vad = load_silero_vad(onnx=True)
vad(torch.from_numpy(audio[:512]), 16000)
footprint("+ Silero VAD")

from huggingface_hub import snapshot_download
path = snapshot_download("AustinXiao/voxturn")
sys.path.insert(0, path)
from voxturn import VoxTurn
eot = VoxTurn.from_pretrained(path, device="mps")
eot.predict(audio, questions=["eot"], lang="en", sample_rate=16000)
footprint("+ VoxTurn v1 on MPS (warm)")

import mlx.core as mx
print(f"MLX active {mx.get_active_memory() / 1e9:.2f} GB, MLX cache {mx.get_cache_memory() / 1e9:.2f} GB")
mx.clear_cache()
footprint("after mx.clear_cache()")
