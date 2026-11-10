"""LFM3-Audio-2B as the whole voice layer: its ASR on the STT clips, its TTS on the TTS sentences.

    python lfm3_bench.py [repo] [clipdir] [sampledir] [resultdir]

Claude stays the brain, so the omni model would only transcribe and speak.
mlx-audio's runtime has no waveform streaming for it (README: "LiveASR,
streaming waveform input/output ... are not supported"), so time to first
audio is the time to the first speech frame from `stream_slots`, which a
phase-2 runtime would have to decode and play itself, and total time is
reported too.
"""

import json
import resource
import statistics
import sys
import time
from pathlib import Path

import jiwer
import numpy as np
import soundfile as sf
from mlx_audio.sts import load

from stt_bench import TERMS, norm
from tts_bench import SENTENCES

repo = sys.argv[1] if len(sys.argv) > 1 else "LiquidAI/LFM3-Audio-2B-MLX-4bit"
clips = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/k12-clips")
samples = Path(sys.argv[3] if len(sys.argv) > 3 else "/tmp/k12-samples")
results = Path(sys.argv[4] if len(sys.argv) > 4 else "/tmp/k12-results")
LANG = {"fr": "French", "en": "English"}
VOICE_LANG = {"fr": "French", "en": "American English"}

base = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6
model = load(repo)
model.generate(str(clips / "en1.wav"), task="asr", language="English")

refs = json.loads((clips / "stt_refs.json").read_text())
asr, by_lang, hits, terms = [], {}, 0, 0
for cid, ref in refs.items():
    t0 = time.perf_counter()
    out = model.generate(str(clips / f"{cid}.wav"), task="asr", language=LANG[ref["lang"]]).text
    asr.append(time.perf_counter() - t0)
    gold, hyp = norm(ref["ref"]), norm(out)
    by_lang.setdefault(ref["lang"], []).append((gold, hyp))
    terms += sum(t in gold for t in TERMS)
    hits += sum(t in gold and t in hyp for t in TERMS)
    print(f"  {cid}: wer={jiwer.wer(gold, hyp):.2f} {out}")

tts = []
model.generate(text="Bonjour.", task="tts", language="French", voice="female")
for i, (lang, text) in enumerate(SENTENCES, 1):
    t0 = time.perf_counter()
    first = None
    try:
        # The prompt generate() builds for task="tts" (model.py), then the first speech frame.
        inputs = model.processor.prepare([{"role": "system", "content": f"Perform TTS in {VOICE_LANG[lang]} using a female voice."},
                                          {"role": "user", "content": text}])
        for _token, codes in model.stream_slots(**inputs, generation_mode="audio"):
            if codes is not None:
                first = time.perf_counter() - t0
                break
    except Exception as e:  # the low-level API may differ; total time still holds
        print("  stream_slots:", type(e).__name__, e)
    t1 = time.perf_counter()
    r = model.generate(text=text, task="tts", language=VOICE_LANG[lang], voice="female")
    total = time.perf_counter() - t1
    audio = np.asarray(r.audio, dtype=np.float32).reshape(-1)
    sf.write(str(samples / f"lfm3-audio-{i}-{lang}.wav"), audio, r.sample_rate)
    tts.append({"n": i, "first_frame_s": first, "total_s": total, "audio_s": len(audio) / r.sample_rate})

import mlx.core as mx
summary = {
    "model": repo,
    "asr_wer": {k: jiwer.wer([g for g, _ in v], [h for _, h in v]) for k, v in by_lang.items()},
    "asr_terms": f"{hits}/{terms}",
    "asr_decode_ms_median": 1000 * statistics.median(asr),
    "tts_total_ms_median": 1000 * statistics.median(t["total_s"] for t in tts),
    "tts_first_frame_ms": [None if t["first_frame_s"] is None else round(1000 * t["first_frame_s"]) for t in tts],
    "tts_rtf": sum(t["total_s"] for t in tts) / sum(t["audio_s"] for t in tts),
    "rss_peak_mb_above_base": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6 - base,
    "mlx_peak_mb": mx.get_peak_memory() / 1e6,
}
(results / "lfm3-audio.json").write_text(json.dumps(summary, indent=1))
print(json.dumps(summary, indent=1))
