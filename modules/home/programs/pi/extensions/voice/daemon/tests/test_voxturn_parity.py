"""The MLX port of VoxTurn against VoxTurn's own PyTorch code (CPU, fp32), on the bench's turn clips.

Slow (loads both models): `uv run pytest -m models`. Needs the clips from
../bench/clips.py in /tmp/k12-clips (or PI_VOICE_CLIPS).
"""

import json
import os
import sys
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from pi_voice.mel import log_mel

CLIPS = Path(os.environ.get("PI_VOICE_CLIPS", "/tmp/k12-clips"))
pytestmark = pytest.mark.models


def test_log_mel_matches_whisper_feature_extractor():
    from transformers import WhisperFeatureExtractor

    audio, _ = sf.read(str(CLIPS / "fr1.wav"), dtype="float32")
    audio = audio[: 8 * 16000]
    for n_mels in (80, 128):
        fe = WhisperFeatureExtractor(feature_size=n_mels, chunk_length=8)
        ref = fe(audio, sampling_rate=16000, return_tensors="np", padding="max_length", max_length=8 * 16000,
                 truncation=True).input_features[0]
        ours = log_mel(np.pad(audio, (0, 8 * 16000 - len(audio))), n_mels)
        assert ours.shape == ref.shape
        assert np.abs(ours - ref).max() < 1e-3


def test_eot_probabilities_match_pytorch():
    import torch
    from huggingface_hub import snapshot_download

    from pi_voice.voxturn_mlx import REPO, VoxTurn

    path = snapshot_download(REPO)
    sys.path.insert(0, path)
    from voxturn import VoxTurn as Reference

    ours = VoxTurn()
    labels = json.loads((CLIPS / "turn_labels.json").read_text())
    pairs = []
    with torch.inference_mode():
        ref = Reference.from_pretrained(path, device="cpu")
        for cid in ("t_fr_euh", "t_fr_et", "t_en_um", "t_fr_non"):
            audio, _ = sf.read(str(CLIPS / f"{cid}.wav"), dtype="float32")
            moments = [h + 0.45 for h in labels[cid]["holds"]] + [labels[cid]["eot"] + 0.45]
            for t in moments:
                a = audio[: int(t * 16000)]
                for text in (None, "je voudrais que tu regardes"):
                    r = ref.predict(a, questions=["eot"], lang="en", text=text)["eot"]["yes"]
                    o = ours.predict(a, "eot", text=text)["yes"]
                    pairs.append((cid, t, text is not None, r, o))
    for cid, t, with_text, r, o in pairs:
        print(f"{cid:10s} t={t:.2f} text={with_text!s:5s} torch={r:.3f} mlx={o:.3f}")
    # VoxTurn's own note: merging the LoRA in bf16 moves probabilities by up to ~0.02.
    assert max(abs(r - o) for *_, r, o in pairs) < 0.05
