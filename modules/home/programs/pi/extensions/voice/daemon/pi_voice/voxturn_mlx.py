"""VoxTurn v1 (AustinXiao/voxturn, CC-BY-NC-4.0) in MLX, on mlx-audio's Qwen3-ASR modules.

VoxTurn is Qwen3-ASR-0.6B (audio encoder -> projector -> Qwen3-0.6B) with a
trained projector, LoRA on every linear layer of the language model, and a
one-unit head that scores the hidden state at each answer option. Its own code
runs through PyTorch, which on this Mac needs fp32 on the GPU (5.7 GB) and
crashes in fp16/bf16; this port runs the same computation in MLX:

- `convert()` builds MLX weights once from the two snapshots in the HF cache:
  the base at VoxTurn's pinned revision, the LoRA merged in (W + 2·B·A, alpha =
  2r), VoxTurn's projector in place of the base one. Saved under
  ~/.cache/pi-voice/voxturn-mlx/.
- `VoxTurn.predict()` builds the prompt VoxTurn's `logits()` builds for one
  question (chat header, audio, optional transcript, the speaking-state marker,
  the question and its options) and returns the softmax over the options.

Parity with the PyTorch model is checked by tests/test_voxturn_parity.py.
"""

import json
from pathlib import Path

import mlx.core as mx
import numpy as np

from .mel import SR, log_mel

BASE = "Qwen/Qwen3-ASR-0.6B-hf"
BASE_REVISION = "7f1569a48a89f3e3f4dc3a5c9d28bddd903bc76c"
REPO = "AustinXiao/voxturn"
N_SAMPLES = 8 * SR
MAX_AUDIO_CONTEXT = 64  # transcript tokens kept with audio, as VoxTurn
LORA_SCALE = 2.0  # lora_alpha / r = 32 / 16
CACHE = Path.home() / ".cache/pi-voice/voxturn-mlx"


def _snapshots():
    from huggingface_hub import snapshot_download
    return Path(snapshot_download(BASE, revision=BASE_REVISION)), Path(snapshot_download(REPO))


def convert(out: Path = CACHE) -> Path:
    """MLX weights for VoxTurn, built once from the HF cache (downloading the snapshots on first use)."""
    if (out / "model.safetensors").exists():
        return out
    base_dir, vox_dir = _snapshots()
    base = mx.load(str(base_dir / "model.safetensors"))
    vox = mx.load(str(vox_dir / "voxturn-v1.safetensors"))
    weights: dict[str, mx.array] = {}
    for k, v in base.items():
        if k.startswith("model.multi_modal_projector."):
            continue  # replaced by VoxTurn's trained projector below
        if k.startswith("model.audio_tower."):
            name = "audio_tower." + k[len("model.audio_tower."):]
            if "conv2d" in name and name.endswith("weight") and v.ndim == 4:
                v = v.transpose(0, 2, 3, 1)  # PyTorch OIHW -> MLX OHWI
        elif k.startswith("model.language_model."):
            name = "model." + k[len("model.language_model."):]
            lora = "llm.base_model.model." + k[len("model.language_model."):]
            if lora.endswith(".weight") and lora[:-7] + ".lora_A.default.weight" in vox:
                a = vox[lora[:-7] + ".lora_A.default.weight"].astype(mx.float32)
                b = vox[lora[:-7] + ".lora_B.default.weight"].astype(mx.float32)
                v = (v.astype(mx.float32) + LORA_SCALE * (b @ a)).astype(mx.bfloat16)
        else:
            continue
        weights[name] = v
    for i in (1, 2):
        weights[f"audio_tower.proj{i}.weight"] = vox[f"adapter.linear_{i}.weight"].astype(mx.float32)
        weights[f"audio_tower.proj{i}.bias"] = vox[f"adapter.linear_{i}.bias"].astype(mx.float32)
    weights["head.weight"] = vox["head.weight"].astype(mx.float32)
    weights["head.bias"] = vox["head.bias"].astype(mx.float32)
    out.mkdir(parents=True, exist_ok=True)
    mx.save_safetensors(str(out / "model.safetensors"), weights)
    for name in ("config.json", "tokenizer.json"):
        (out / name).write_bytes((base_dir / name).read_bytes())
    (out / "questions.json").write_bytes((vox_dir / "questions.json").read_bytes())
    return out


def fit_window(audio: np.ndarray, n: int = N_SAMPLES) -> np.ndarray:
    """The last n samples, left-padded with silence."""
    y = np.asarray(audio, dtype=np.float32)[-n:]
    w = np.zeros(n, np.float32)
    w[n - len(y):] = y
    return w


class VoxTurn:
    def __init__(self, path: Path | None = None):
        import mlx.nn as nn
        from mlx_audio.stt.models.qwen3_asr.config import ModelConfig
        from mlx_audio.stt.models.qwen3_asr.qwen3_asr import Qwen3ASRModel
        from tokenizers import Tokenizer

        path = path or convert()
        config = json.loads((path / "config.json").read_text())
        self.model = Qwen3ASRModel(ModelConfig(audio_config=config["audio_config"], text_config=config["text_config"]))
        self.model.head = nn.Linear(config["text_config"]["hidden_size"], 1)
        self.model.load_weights(str(path / "model.safetensors"), strict=False)
        mx.eval(self.model.parameters())
        self.questions = json.loads((path / "questions.json").read_text())
        self.tok = Tokenizer.from_file(str(path / "tokenizer.json"))
        self.seq_head = self._ids("<|im_start|>system\n<|im_end|>\n<|im_start|>user\n")
        self.audio_open, self.audio_close = self._ids("<|audio_start|>"), self._ids("<|audio_end|>")
        self._prompts: dict = {}

    def _ids(self, text: str) -> list[int]:
        return self.tok.encode(text, add_special_tokens=False).ids

    def _question(self, task: str) -> tuple[list[int], list[int]]:
        """The question's token ids (English prompt, phrasing 0) and each option's last-token index."""
        if task not in self._prompts:
            q = self.questions[task]
            ids = self._ids("\nQuestion: {}\nOptions:".format(q["phrasings"]["en"][0]))
            pos = []
            for label in q["labels"]:
                ids += self._ids(f" {q['options']['en'][label]}")
                pos.append(len(ids) - 1)
            self._prompts[task] = (ids, pos)
        return self._prompts[task]

    def _context(self, text: str | None, speaker: str) -> list[int]:
        ids = self._ids("\n" + text)[-MAX_AUDIO_CONTEXT:] if text else []
        return ids + self._ids({"user": "\n[User is speaking]", "agent": "\n[Agent is speaking]"}[speaker])

    def predict(self, audio: np.ndarray, question: str = "eot", text: str | None = None, speaker: str = "user") -> dict[str, float]:
        """P(option) for one question about the last 8 s of 16 kHz audio, e.g. {"yes": 0.93, "no": 0.07}."""
        m = self.model
        mel = mx.array(log_mel(fit_window(audio), 128))[None]  # (1, 128, 800)
        audio_emb = m.audio_tower(mel).astype(mx.bfloat16)  # (104, 1024)
        embed = m.model.embed_tokens
        q_ids, q_pos = self._question(question)
        before = self.seq_head + self.audio_open
        after = self.audio_close + self._context(text, speaker) + q_ids
        x = mx.concatenate([embed(mx.array(before)), audio_emb, embed(mx.array(after))], axis=0)[None]
        hidden = m.model(inputs_embeds=x)[0]
        start = len(before) + audio_emb.shape[0] + len(after) - len(q_ids)
        logits = m.head(hidden[mx.array([start + p for p in q_pos])].astype(mx.float32))[:, 0]
        p = np.array(mx.softmax(logits))
        return {label: float(p[i]) for i, label in enumerate(self.questions[question]["labels"])}
