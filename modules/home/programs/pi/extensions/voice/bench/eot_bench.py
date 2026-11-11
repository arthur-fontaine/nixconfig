"""End-of-turn benchmark on the turn clips from clips.py. One detector per process.

    python eot_bench.py <detector> [clipdir] [resultdir]

Every detector runs under the same causal policy, the one VoxTurn's and
Pipecat's analyzers use: Silero VAD marks silence once speech has stopped for
VAD_STOP; the detector is asked then, and again every RECHECK while the silence
lasts; the turn ends when P(end) >= threshold, or at TIMEOUT after the silence
began. A detector only sees audio up to the moment it is asked.

Per clip and threshold:
- a *false cut-off* is a fire inside a hold (a pause that the speaker resumes);
- *end latency* is fire time minus the end of speech at the real end of turn.
The `silence-<ms>` detectors are the plain timeout baselines.
"""

import json
import statistics
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 16000
VAD_STOP = 0.2
RECHECK = 0.25
TIMEOUT = 3.0
FRAME = 512  # Silero's chunk at 16 kHz (32 ms)


def vad_silences(audio: np.ndarray) -> list[tuple[float, float]]:
    """(speech stop, speech restart or end of clip) for each silence after speech."""
    from silero_vad import load_silero_vad
    import torch

    vad = load_silero_vad(onnx=True)
    probs = []
    for i in range(0, len(audio) - FRAME + 1, FRAME):
        probs.append(vad(torch.from_numpy(audio[i:i + FRAME]), SR).item())
    speech = [p > 0.5 for p in probs]
    out, last_speech, in_sil, start = [], None, False, 0.0
    for i, s in enumerate(speech):
        t = i * FRAME / SR
        if s:
            if in_sil:
                out.append((start, t))
                in_sil = False
            last_speech = t + FRAME / SR
        elif last_speech is not None and not in_sil:
            in_sil, start = True, last_speech
    if in_sil:
        out.append((start, len(audio) / SR))
    return out


def words_so_far(cache: dict, t: float) -> str:
    """The clip's text up to time t: segments between the [[slnc]] holds, by the label's hold times."""
    import re
    lab = cache["label"]
    segments = [s.strip() for s in re.split(r"\[\[slnc \d+\]\]", lab["text"])]
    ends = lab["holds"] + [lab["eot"]]
    return " ".join(s for s, end in zip(segments, ends) if end <= t + 0.05)


def detector(name: str):
    """Returns (score(audio_prefix, lang) -> P(end of turn), thresholds)."""
    if name.startswith("silence-"):
        return None, [float(name.split("-")[1]) / 1000]
    if name == "smart-turn-3.2":
        import onnxruntime as ort
        from huggingface_hub import hf_hub_download
        from transformers import WhisperFeatureExtractor

        sess = ort.InferenceSession(hf_hub_download("pipecat-ai/smart-turn-v3", "smart-turn-v3.2-cpu.onnx"))
        fe = WhisperFeatureExtractor(chunk_length=8)

        def score(a, lang):
            a = a[-8 * SR:]
            a = np.pad(a, (8 * SR - len(a), 0))
            f = fe(a, sampling_rate=SR, return_tensors="np", padding="max_length", max_length=8 * SR,
                   truncation=True, do_normalize=True).input_features.astype(np.float32)
            return float(sess.run(None, {"input_features": f})[0][0].item())
        return score, [0.5, 0.7, 0.9]
    if name == "turn-1-mini":
        from p99turn.onnx_stream import Turn1MiniOnnx

        cache: dict = {}

        def score(a, lang):
            # Streaming and causal: one pass over the whole clip (main() puts it in cache["full"]),
            # then read the 20 ms frame that ends at the query time.
            if "probs" not in cache:
                m = Turn1MiniOnnx.from_pretrained()
                full = cache["full"]
                cache["probs"] = np.concatenate([np.atleast_1d(m.push(full[i:i + 2560])) for i in range(0, len(full), 2560)])
            frame = min(len(a) // 320, len(cache["probs"])) - 1
            return float(cache["probs"][frame])
        score.cache = cache  # type: ignore[attr-defined]
        return score, [0.5, 0.7, 0.9]
    if name.startswith("voxturn"):
        import torch
        from huggingface_hub import snapshot_download

        path = snapshot_download("AustinXiao/voxturn")
        sys.path.insert(0, path)
        from voxturn import VoxTurn

        dev = "mps" if torch.backends.mps.is_available() else "cpu"
        model = VoxTurn.from_pretrained(path, device=dev)

        with_text = name == "voxturn+text"

        def score(a, lang):
            # +text: the words said so far, as the daemon's STT would have them at that moment.
            text = words_so_far(score.cache, len(a) / SR) if with_text else None
            return float(model.predict(a, questions=["eot"], lang="en", text=text, sample_rate=SR)["eot"]["yes"])
        score.cache = {}  # type: ignore[attr-defined]
        return score, [0.5, 0.8, 0.9]
    raise SystemExit(f"unknown detector {name}")


def main() -> None:
    name = sys.argv[1]
    clips = Path(sys.argv[2] if len(sys.argv) > 2 else "/tmp/k12-clips")
    results = Path(sys.argv[3] if len(sys.argv) > 3 else "/tmp/k12-results")
    labels = json.loads((clips / "turn_labels.json").read_text())

    import resource
    base = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6
    score, thresholds = detector(name)
    calls: list[float] = []

    # Scores are computed once per query time and reused across thresholds.
    per_clip = {}
    for cid, lab in labels.items():
        audio, _ = sf.read(str(clips / f"{cid}.wav"), dtype="float32")
        if score is not None and hasattr(score, "cache"):
            score.cache.clear()
            score.cache["full"] = audio
            score.cache["label"] = lab
        sils = vad_silences(audio)
        eot = lab["eot"]
        queries = []
        for start, end in sils:
            is_end = abs(start - eot) < 0.35 or start > eot
            t, pts = start + VAD_STOP, []
            while t < min(end, start + TIMEOUT) and score is not None:
                t0 = time.perf_counter()
                p = score(audio[: int(t * SR)], lab["lang"])
                calls.append(time.perf_counter() - t0)
                pts.append((t, p))
                t += RECHECK
            queries.append({"start": start, "end": end, "is_end": is_end, "points": pts})
        per_clip[cid] = {"eot": eot, "silences": queries}

    report = {}
    for th in thresholds:
        cut_pauses = holds = cut_clips = 0
        lat, fallbacks = [], 0
        for cid, c in per_clip.items():
            clip_cut = False
            for s in c["silences"]:
                if score is None:
                    fire = s["start"] + th if s["start"] + th < s["end"] else None
                else:
                    fire = next((t for t, p in s["points"] if p >= th), None)
                    if fire is None and s["end"] >= s["start"] + TIMEOUT:
                        fire = s["start"] + TIMEOUT
                if s["is_end"]:
                    if fire is None:
                        fire = s["start"] + TIMEOUT
                    if score is not None and fire == s["start"] + TIMEOUT:
                        fallbacks += 1
                    lat.append(fire - c["eot"])
                    break
                holds += 1
                if fire is not None:
                    cut_pauses += 1
                    clip_cut = True
            cut_clips += clip_cut
        report[str(th)] = {
            "false_cutoff_pauses": f"{cut_pauses}/{holds}",
            "clips_cut": f"{cut_clips}/{len(per_clip)}",
            "end_latency_ms_median": 1000 * statistics.median(lat),
            "end_latency_ms_max": 1000 * max(lat),
            "timeouts_at_end": fallbacks,
        }
    summary = {
        "detector": name,
        "policy": {"vad_stop_s": VAD_STOP, "recheck_s": RECHECK, "timeout_s": TIMEOUT},
        "call_ms_median": 1000 * statistics.median(calls) if calls else None,
        "rss_peak_mb_above_base": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6 - base,
        "by_threshold": report,
        "clips": per_clip,
    }
    results.mkdir(parents=True, exist_ok=True)
    (results / f"eot-{name}.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps({k: v for k, v in summary.items() if k != "clips"}, indent=1))


if __name__ == "__main__":
    main()
