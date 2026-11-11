"""Round-trip intelligibility of the TTS samples: transcribe each with Parakeet v3, WER against its text.

    python tts_roundtrip.py [sampledir]

A proxy only: it says whether the words come out understandable (French tech
words included), not whether the voice sounds good. That is for a human.
"""

import sys
from collections import defaultdict
from pathlib import Path

import jiwer
from mlx_audio.stt import load

from stt_bench import norm
from tts_bench import SENTENCES

samples = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/k12-samples")
model = load("mlx-community/parakeet-tdt-0.6b-v3")
by_model = defaultdict(list)
for wav in sorted(samples.glob("*.wav")):
    key, n, lang = wav.stem.rsplit("-", 2)
    gold = norm(SENTENCES[int(n) - 1][1])
    hyp = norm(model.generate(str(wav)).text)
    by_model[key].append((lang, gold, hyp))
    print(f"{wav.stem:28s} wer={jiwer.wer(gold, hyp):.2f}  {hyp}")
print()
for key, rows in by_model.items():
    fr = [(g, h) for lang, g, h in rows if lang == "fr"]
    en = [(g, h) for lang, g, h in rows if lang == "en"]
    print(f"{key:20s} FR WER {jiwer.wer([g for g, _ in fr], [h for _, h in fr]):.2f}   EN WER {jiwer.wer([g for g, _ in en], [h for _, h in en]):.2f}")
