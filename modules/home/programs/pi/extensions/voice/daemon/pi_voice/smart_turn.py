"""Smart Turn v3.2 (pipecat-ai/smart-turn-v3, BSD-2), CPU int8 ONNX, 8 ms: the rescue for short answers.

Input as its reference inference.py: the last 8 s of the turn, left-padded with
silence, as an 80-bin Whisper log-mel.
"""

import numpy as np

from .mel import SR, log_mel


class SmartTurn:
    def __init__(self, path: str | None = None):
        import onnxruntime as ort
        if path is None:
            from huggingface_hub import hf_hub_download
            path = hf_hub_download("pipecat-ai/smart-turn-v3", "smart-turn-v3.2-cpu.onnx")
        opts = ort.SessionOptions()
        opts.inter_op_num_threads = opts.intra_op_num_threads = 1
        self.session = ort.InferenceSession(path, opts, providers=["CPUExecutionProvider"])

    def __call__(self, audio: np.ndarray) -> float:
        """P(the turn is complete)."""
        a = np.asarray(audio, np.float32)[-8 * SR:]
        a = np.pad(a, (8 * SR - len(a), 0))
        features = log_mel(a, 80)[None].astype(np.float32)
        return float(self.session.run(None, {"input_features": features})[0][0].item())
