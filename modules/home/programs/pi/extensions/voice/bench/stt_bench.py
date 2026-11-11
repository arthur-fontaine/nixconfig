"""STT benchmark on the clips from clips.py. One model per process.

    python stt_bench.py <model-key> [clipdir] [resultdir]

Measures, per model:
- WER per language, and how many code words came out right (TERMS);
- decode time of each whole clip after warm-up (the delay between the end of
  turn and the final transcript when decoding at end of turn) and the RTF;
- for streaming models (mlx-audio `create_streaming_session`): compute per
  80 ms chunk fed in order, and when each word first appears in audio time
  (partial latency = appearance minus end of the word's audio, approximated
  by the time the transcript reaches it);
- RAM: process peak RSS above the pre-load baseline, and MLX peak memory.
"""

import json
import re
import resource
import statistics
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

MODELS = {
    # key: (runner, repo, kwargs)
    "parakeet-v3": ("mlx", "mlx-community/parakeet-tdt-0.6b-v3", {}),
    "parakeet-v3+boost": ("parakeet-boost", "mlx-community/parakeet-tdt-0.6b-v3", {"score": 3.0}),
    "parakeet-v3+boost5": ("parakeet-boost", "mlx-community/parakeet-tdt-0.6b-v3", {"score": 5.0}),
    "canary-1b-v2": ("mlx", "Mediform/canary-1b-v2-mlx-q8", {"source_lang": "LANG", "target_lang": "LANG"}),
    "kyutai-stt-1b": ("kyutai", "kyutai/stt-1b-en_fr-mlx", {}),
    "nemotron-3.5": ("mlx", "mlx-community/nemotron-3.5-asr-streaming-0.6b-8bit", {}),
    "qwen3-asr-0.6b": ("mlx", "mlx-community/Qwen3-ASR-0.6B-8bit", {}),
    "qwen3-asr-0.6b+hotwords": ("mlx", "mlx-community/Qwen3-ASR-0.6B-8bit", {"hotwords": "HOTWORDS"}),
    # French as the default language, as the daemon would set it for this person (English clips included).
    "qwen3-asr-0.6b+hotwords+fr": ("mlx", "mlx-community/Qwen3-ASR-0.6B-8bit", {"hotwords": "HOTWORDS", "language": "French"}),
    "whisper-turbo": ("mlx_whisper", "mlx-community/whisper-large-v3-turbo", {}),
    "whisper-turbo+prompt": ("mlx_whisper", "mlx-community/whisper-large-v3-turbo", {"initial_prompt": "PROMPT"}),
    "voxtral-rt-4b": ("mlx", "mlx-community/Voxtral-Mini-4B-Realtime-2602-4bit", {}),
    "audio8-0.1b": ("audio8", "Edge0/Audio8-ASR-0.1B-onnx-runtime", {}),
    "audio8-0.1b+hotwords": ("audio8", "Edge0/Audio8-ASR-0.1B-onnx-runtime", {"hotwords": "HOTWORDS"}),
    "ark-asr-0.6b": ("ark", "Edge0/ark-asr-0.6b-int8-onnx", {}),
}

TERMS = ["pnpm", "worktree", "nix build", "default", "commit", "rebase", "github", "launchd", "unix",
         "websocket", "typescript", "daemon", "footer", "rewind", "main"]

# Vocabulary a daemon would pass to models that take it (project words, not the test sentences).
HOTWORDS = ["pnpm", "worktree", "nix build", "default.nix", "commit", "rebase", "GitHub", "launchd", "Unix",
            "WebSocket", "TypeScript", "daemon", "footer", "rewind", "Pi", "Herdr"]

ALIASES = [(r"default\.nix", "default point nix"), (r"web socket", "websocket"), (r"type script", "typescript"),
           (r"work tree", "worktree"), (r"\bp ?n ?p ?m\b", "pnpm"), (r"\bnix-build\b", "nix build"), (r"git hub", "github")]


def rss_mb() -> float:
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6  # bytes on macOS


def norm(text: str) -> str:
    t = text.lower().replace("’", "'")
    for a, b in ALIASES:
        t = re.sub(a, b, t)
    t = re.sub(r"[^\w' ]+", " ", t)
    return re.sub(r"\s+", " ", t).strip()


def materialize(repo: str, sub: str) -> Path:
    """The snapshot as real files (hard links to the hub's blobs, no extra disk), under <root>/<sub>.

    ONNX Runtime refuses external data that resolves outside the model's directory, which the
    hub's symlinked blobs do; ARK's runtime also expects its files under <root>/model."""
    import os
    from huggingface_hub import snapshot_download
    snap = Path(snapshot_download(repo))
    root = Path.home() / ".cache/k12-voice/edge0" / repo.split("/")[1]
    for src in snap.rglob("*"):
        if src.is_dir():
            continue
        dst = root / sub / src.relative_to(snap)
        if not dst.exists():
            dst.parent.mkdir(parents=True, exist_ok=True)
            os.link(src.resolve(), dst)
    return root


def load(key: str):
    runner, repo, kw = MODELS[key]
    if kw.get("hotwords") == "HOTWORDS":
        kw = {**kw, "hotwords": HOTWORDS}
    if kw.get("initial_prompt") == "PROMPT":
        kw = {**kw, "initial_prompt": "Pi, pnpm, worktree, nix build, default.nix, commit, rebase, GitHub, launchd, WebSocket, TypeScript, daemon, footer, rewind."}
    if runner == "mlx_whisper":
        import mlx_whisper
        return (lambda path, lang: mlx_whisper.transcribe(path, path_or_hf_repo=repo, **kw)["text"]), None
    if runner == "mlx":
        from mlx_audio.stt import load as mlx_load
        model = mlx_load(repo)

        def run(path, lang):
            # "LANG": the clip's language, for models with no auto-detection (Canary).
            args = {k: (lang if v == "LANG" else v) for k, v in kw.items()}
            return model.generate(path, **args).text
        return run, model
    if runner == "parakeet-boost":
        from mlx_audio.stt import load as mlx_load
        from parakeet_boost import PhraseBoost
        boost = PhraseBoost(mlx_load(repo), HOTWORDS, score=kw["score"])
        return (lambda path, lang: boost.transcribe(path)), None
    if runner == "kyutai":
        from kyutai_stt import KyutaiSTT
        stt = KyutaiSTT(repo)
        return (lambda path, lang: stt.transcribe(path)), None
    if runner in ("audio8", "ark"):
        # Edge0's own ONNX runtimes, imported from their snapshot directory (CPU).
        root = materialize(repo, "model" if runner == "ark" else "")
        if runner == "ark":
            materialize(repo, "build")  # its runtime reads the decoder's JSON from build/
        sys.path.insert(0, str(root / ("model" if runner == "ark" else "")))
        if runner == "audio8":
            from asr_onnx_runtime import OnnxCacheAsrEngine
            engine = OnnxCacheAsrEngine(str(root / "model_bundle"), cache_precision="int8", audio_precision="int8")
            hot = ",".join(HOTWORDS) if kw.get("hotwords") else None
            return (lambda path, lang: engine.transcribe(Path(path).read_bytes(), language=None, max_new_tokens=128,
                                                         hotwords=hot)["text"]), None
        from infer_ark_audio_onnx import ArkAsrOnnxRuntime
        rt = ArkAsrOnnxRuntime(root)
        return (lambda path, lang: rt.transcribe(audio_path=path, max_new_tokens=128, max_audio_seconds=30,
                                                 precision="int8", asr_block_token_id_from=151670)), None
    raise SystemExit(f"unknown runner {runner}")


def streaming(model, audio: np.ndarray, sr: int, chunk_s: float = 0.08):
    """Feed chunks in order; return per-chunk compute (s) and (audio_time, text_so_far) events."""
    session = model.create_streaming_session()
    n = int(chunk_s * sr)
    steps, events, text = [], [], ""
    for i in range(0, len(audio), n):
        t0 = time.perf_counter()
        session.feed(audio[i:i + n])
        deltas = session.step(max_decode_tokens=16)
        steps.append(time.perf_counter() - t0)
        if deltas:
            text += "".join(deltas)
            events.append((min(i + n, len(audio)) / sr, text))
    session.close()
    t0 = time.perf_counter()
    while not session.done:
        deltas = session.step(max_decode_tokens=64)
        text += "".join(deltas)
    flush = time.perf_counter() - t0
    events.append((len(audio) / sr, text))
    return steps, events, flush, text


def main() -> None:
    key = sys.argv[1]
    clips = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/k12-clips")
    results = Path(sys.argv[3] if len(sys.argv) > 3 else "/tmp/k12-results")
    results.mkdir(parents=True, exist_ok=True)
    refs = json.loads((clips / "stt_refs.json").read_text())

    base = rss_mb()
    t0 = time.perf_counter()
    transcribe, model = load(key)
    load_s = time.perf_counter() - t0
    transcribe(str(clips / "en1.wav"), "en")  # warm-up

    import jiwer
    rows, by_lang = [], {}
    for cid, ref in refs.items():
        path = str(clips / f"{cid}.wav")
        dur = sf.info(path).duration
        t0 = time.perf_counter()
        out = transcribe(path, ref["lang"])
        dt = time.perf_counter() - t0
        hyp, gold = norm(out), norm(ref["ref"])
        wer = jiwer.wer(gold, hyp)
        terms = [t for t in TERMS if t in gold]
        hit = [t for t in terms if t in hyp]
        rows.append({"id": cid, "out": out, "wer": wer, "decode_s": dt, "dur_s": dur, "terms": len(terms), "hits": len(hit)})
        by_lang.setdefault(ref["lang"], []).append((gold, hyp))

    stream = None
    if hasattr(model, "create_streaming_session"):
        audio, sr = sf.read(str(clips / "fr1.wav"), dtype="float32")
        streaming(model, audio, sr)  # warm-up
        all_steps, flushes, firsts = [], [], []
        for cid in refs:
            audio, sr = sf.read(str(clips / f"{cid}.wav"), dtype="float32")
            steps, events, flush, _ = streaming(model, audio, sr)
            all_steps += steps
            flushes.append(flush)
            onset = next(i for i, v in enumerate(np.abs(audio) > 0.01) if v) / sr
            firsts.append(events[0][0] - onset)
        all_steps.sort()
        stream = {
            "chunk_ms": 80,
            "step_ms_median": 1000 * statistics.median(all_steps),
            "step_ms_p95": 1000 * all_steps[int(0.95 * len(all_steps))],
            "flush_ms_median": 1000 * statistics.median(flushes),
            "first_text_after_onset_s_median": statistics.median(firsts),
        }

    try:
        import mlx.core as mx
        mlx_peak = mx.get_peak_memory() / 1e6
    except Exception:
        mlx_peak = None
    summary = {
        "model": key,
        "repo": MODELS[key][1],
        "load_s": load_s,
        "wer": {lang: jiwer.wer([g for g, _ in p], [h for _, h in p]) for lang, p in by_lang.items()},
        "terms": f"{sum(r['hits'] for r in rows)}/{sum(r['terms'] for r in rows)}",
        "decode_ms_median": 1000 * statistics.median(r["decode_s"] for r in rows),
        "rtf": sum(r["decode_s"] for r in rows) / sum(r["dur_s"] for r in rows),
        "rss_peak_mb_above_base": rss_mb() - base,
        "mlx_peak_mb": mlx_peak,
        "stream": stream,
        "rows": rows,
    }
    (results / f"stt-{key}.json").write_text(json.dumps(summary, ensure_ascii=False, indent=1))
    print(json.dumps({k: v for k, v in summary.items() if k != "rows"}, ensure_ascii=False, indent=1))
    for r in rows:
        print(f"  {r['id']}: wer={r['wer']:.2f} {r['out']}")


if __name__ == "__main__":
    main()
