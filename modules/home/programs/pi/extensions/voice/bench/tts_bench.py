"""TTS benchmark: time to first audio, RTF, RAM, and samples to listen to. One model per process.

    python tts_bench.py <model-key> [sampledir] [resultdir]

Each sentence is generated after one warm-up call. Time to first audio (TTFA) is
the delay from the call to the first chunk of audio the model yields: a
streaming model yields early, others yield the whole sentence (the daemon feeds
TTS one sentence at a time, so that is the TTFA it would see too).
"""

import json
import resource
import statistics
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

SENTENCES = [
    ("fr", "D'accord, je lance le build tout de suite."),
    ("fr", "J'ai modifié le fichier default point nix et relancé pnpm test dans le worktree : les douze tests passent."),
    ("fr", "Le problème venait du footer, qui lisait l'ancienne clé de configuration. Je l'ai corrigé. Tu veux que je fasse un commit ?"),
    ("en", "Done. The daemon now listens on a Unix socket, and the extension reconnects on its own."),
]

# key: (runner, repo, per-language generate kwargs)
MODELS = {
    "kokoro": ("mlx", "mlx-community/Kokoro-82M-bf16",
               {"fr": {"voice": "ff_siwis", "lang_code": "f"}, "en": {"voice": "af_heart", "lang_code": "a"}}),
    "zonos3-mini": ("mlx", "mlx-community/ZONOS3-Mini",
                    {"fr": {"voice": "gaspard", "lang_code": "fr", "stream": True, "streaming_interval": 0.5},
                     "en": {"voice": "wyatt", "lang_code": "en", "stream": True, "streaming_interval": 0.5}}),
    "qwen3-tts-0.6b": ("mlx", "mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit",
                       {"fr": {"voice": "Ryan", "lang_code": "french", "stream": True, "streaming_interval": 0.5},
                        "en": {"voice": "Ryan", "lang_code": "english", "stream": True, "streaming_interval": 0.5}}),
    "voxtral-tts-4b": ("mlx", "mlx-community/Voxtral-4B-TTS-2603-mlx-4bit",
                       {"fr": {"voice": "fr_male", "stream": True, "streaming_interval": 0.5},
                        "en": {"voice": "casual_male", "stream": True, "streaming_interval": 0.5}}),
    "audio8-tts-0.6b": ("mlx", "nativ-community/Audio8-TTS-Realistic-0.6b-4bit", {"fr": {}, "en": {}}),
    "pocket-tts-fr": ("pocket", "french", {"fr": {"voice": "alba"}, "en": {"voice": "alba"}}),
    "pocket-tts-fr-24l": ("pocket", "french_24l", {"fr": {"voice": "alba"}, "en": {"voice": "alba"}}),
}


def rss_mb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6


def loader(key: str):
    runner, repo, kw = MODELS[key]
    if runner == "mlx":
        from mlx_audio.tts.utils import load_model
        model = load_model(repo)

        def run(text, lang):
            """Yields (seconds since call, audio chunk, sample rate)."""
            t0 = time.perf_counter()
            for r in model.generate(text=text, **kw[lang]):
                yield time.perf_counter() - t0, np.asarray(r.audio, dtype=np.float32), r.sample_rate
        return run
    if runner == "pocket":
        from pocket_tts import TTSModel  # Kyutai's package; French weights under languages/<repo>
        model = TTSModel.load_model(language=repo)

        def run(text, lang):
            t0 = time.perf_counter()
            state = model.get_state_for_audio_prompt(kw[lang]["voice"])
            for chunk in model.generate_audio_stream(state, text):
                yield time.perf_counter() - t0, chunk.numpy().astype(np.float32), model.sample_rate
        return run
    raise SystemExit(runner)


def main() -> None:
    key = sys.argv[1]
    samples = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/k12-samples")
    results = Path(sys.argv[3] if len(sys.argv) > 3 else "/tmp/k12-results")
    samples.mkdir(parents=True, exist_ok=True)
    results.mkdir(parents=True, exist_ok=True)
    base = rss_mb()
    t0 = time.perf_counter()
    run = loader(key)
    load_s = time.perf_counter() - t0
    for _ in run("Bonjour, ceci est un essai.", "fr"):
        pass

    rows = []
    for i, (lang, text) in enumerate(SENTENCES, 1):
        chunks, first, sr, total = [], None, 24000, 0.0
        for t, audio, sr in run(text, lang):
            first = t if first is None else first
            chunks.append(audio.reshape(-1))
            total = t
        audio = np.concatenate(chunks)
        sf.write(str(samples / f"{key}-{i}-{lang}.wav"), audio, sr)
        dur = len(audio) / sr
        rows.append({"n": i, "lang": lang, "ttfa_s": first, "total_s": total, "audio_s": dur, "chunks": len(chunks)})

    try:
        import mlx.core as mx
        mlx_peak = mx.get_peak_memory() / 1e6
    except Exception:
        mlx_peak = None
    summary = {
        "model": key,
        "repo": MODELS[key][1],
        "load_s": load_s,
        "ttfa_ms_median": 1000 * statistics.median(r["ttfa_s"] for r in rows),
        "ttfa_ms_max": 1000 * max(r["ttfa_s"] for r in rows),
        "rtf": sum(r["total_s"] for r in rows) / sum(r["audio_s"] for r in rows),
        "streams": any(r["chunks"] > 1 for r in rows),
        "rss_peak_mb_above_base": rss_mb() - base,
        "mlx_peak_mb": mlx_peak,
        "rows": rows,
    }
    (results / f"tts-{key}.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps(summary, indent=1))


if __name__ == "__main__":
    main()
