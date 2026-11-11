"""Kyutai STT 1B en/fr (MLX), from kyutai-labs/delayed-streams-modeling scripts/stt_from_file_mlx.py.

Streaming by design: 80 ms steps (1920 samples at 24 kHz), the text 0.5 s behind
the audio. `transcribe` runs a whole file through the stream with 2 s of
trailing silence so the delayed text comes out, and records the per-step
compute in `self.steps`.
"""

import json
import time

import mlx.core as mx
import mlx.nn as nn
import numpy as np
import sentencepiece
import soundfile as sf
from huggingface_hub import hf_hub_download
from moshi_mlx import models, utils


class KyutaiSTT:
    def __init__(self, repo: str = "kyutai/stt-1b-en_fr-mlx"):
        config = json.loads(open(hf_hub_download(repo, "config.json")).read())
        mimi = hf_hub_download(repo, config["mimi_name"])
        weights = hf_hub_download(repo, config.get("moshi_name", "model.safetensors"))
        tok = hf_hub_download(repo, config["tokenizer_name"])
        lm_config = models.LmConfig.from_config_dict(config)
        self.model = models.Lm(lm_config)
        self.model.set_dtype(mx.bfloat16)
        if weights.endswith(".q8.safetensors"):
            nn.quantize(self.model, bits=8, group_size=64)
        self.model.load_weights(weights, strict=True)
        self.tokenizer = sentencepiece.SentencePieceProcessor(tok)
        self.mimi = models.mimi.Mimi(models.mimi_202407(32))
        self.mimi.load_pytorch_weights(str(mimi), strict=True)
        self.model.warmup()
        self.steps: list[float] = []

    def transcribe(self, path: str) -> str:
        audio, sr = sf.read(path, dtype="float32")
        if sr != 24000:
            import librosa
            audio = librosa.resample(audio, orig_sr=sr, target_sr=24000)
        audio = mx.array(np.concatenate([audio, np.zeros(48000, np.float32)]))[None]
        gen = models.LmGen(model=self.model, max_steps=4096, text_sampler=utils.Sampler(top_k=25, temp=0),
                           audio_sampler=utils.Sampler(top_k=250, temp=0.8), check=False)
        self.mimi.reset_state()
        text = []
        for start in range(0, audio.shape[-1] // 1920 * 1920, 1920):
            t0 = time.perf_counter()
            tokens = self.mimi.encode_step(audio[:, None, start:start + 1920]).transpose(0, 2, 1)
            token = gen.step(tokens[0])[0].item()
            self.steps.append(time.perf_counter() - t0)
            if token not in (0, 3):
                text.append(self.tokenizer.id_to_piece(token).replace("▁", " "))
        return "".join(text).strip()
