# Voice benchmarks

The scripts behind [RESEARCH.md](../RESEARCH.md). Files only: no microphone,
no speakers. Models come from the shared Hugging Face cache; nothing here
goes into git but code and the JSON results.

## Setup

Three venvs outside the repo (the measurements used `~/.cache/k12-voice/`),
Python 3.12:

```sh
V=~/.cache/k12-voice
uv venv --python 3.12 $V/mlx
uv pip install --python $V/mlx/bin/python numpy jiwer soundfile psutil \
  "git+https://github.com/Blaizzy/mlx-audio.git@3e2368ef96e686ad6c2c8791272bd25617d3e71e" \
  parakeet-mlx mlx-whisper silero-vad onnxruntime peft \
  "misaki[en]" "mistral-common[audio]" espeakng_loader phonemizer-fork \
  "en_core_web_sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl"

uv venv --python 3.12 $V/torch
uv pip install --python $V/torch/bin/python torch "transformers>=5.19" peft safetensors huggingface_hub \
  scipy soundfile numpy onnxruntime silero-vad jiwer librosa psutil \
  "p99turn[onnx] @ https://huggingface.co/p99lab/turn-1-mini/resolve/main/dist/p99turn-1.2.3-py3-none-any.whl"

uv venv --python 3.12 $V/pocket
uv pip install --python $V/pocket/bin/python pocket-tts soundfile numpy
```

## Run

From this directory; clips go to `/tmp/k12-clips`, results to
`/tmp/k12-results`, samples to `/tmp/k12-samples`.

```sh
$V/mlx/bin/python clips.py                         # STT and turn clips, with macOS `say`

# STT: one model per process (keys in stt_bench.py MODELS)
$V/mlx/bin/python stt_bench.py parakeet-v3
$V/mlx/bin/python stt_bench.py whisper-turbo+prompt
$V/torch/bin/python stt_bench.py ark-asr-0.6b      # Edge0 ONNX runtimes run in the torch venv

# End of turn: one detector per process, then the fusions
for d in silence-300 silence-500 silence-800 silence-1200 smart-turn-3.2 turn-1-mini voxturn voxturn+text; do
  $V/torch/bin/python eot_bench.py $d
done
python3 eot_fuse.py

# TTS, then the intelligibility round trip
$V/mlx/bin/python tts_bench.py zonos3-mini
$V/pocket/bin/python tts_bench.py pocket-tts-fr
$V/mlx/bin/python tts_roundtrip.py

$V/mlx/bin/python lfm3_bench.py                    # LFM3-Audio as STT and TTS
$V/torch/bin/python voice_pass_bench.py            # Haiku through `pi`, and local LLMs in llama-server
$V/mlx/bin/python stack_memory.py                  # footprint of the stack in one process
```

`results/` holds the JSON each script wrote on 2026-11-10 (M4 Pro, 24 GB,
macOS 27.0), transcripts and per-pause scores included.
