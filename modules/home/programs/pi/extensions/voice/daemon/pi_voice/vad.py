"""Silero VAD v5 through onnxruntime (onnx-community/silero-vad), streaming 32 ms frames at 16 kHz.

As the silero-vad package's OnnxWrapper: each 512-sample frame goes in with
the last 64 samples of the previous one as context, and the recurrent state
carries over. No torch.
"""

import numpy as np

FRAME = 512
CONTEXT = 64


class Vad:
    def __init__(self, path: str | None = None):
        import onnxruntime as ort
        if path is None:
            from huggingface_hub import hf_hub_download
            path = hf_hub_download("onnx-community/silero-vad", "onnx/model.onnx")
        opts = ort.SessionOptions()
        opts.inter_op_num_threads = opts.intra_op_num_threads = 1
        self.session = ort.InferenceSession(path, opts, providers=["CPUExecutionProvider"])
        self.reset()

    def reset(self) -> None:
        self.state = np.zeros((2, 1, 128), np.float32)
        self.context = np.zeros(CONTEXT, np.float32)

    def __call__(self, frame: np.ndarray) -> float:
        """P(speech) for one 512-sample frame."""
        x = np.concatenate([self.context, frame.astype(np.float32)])[None]
        out, self.state = self.session.run(None, {"input": x, "state": self.state, "sr": np.array(16000, np.int64)})
        self.context = frame[-CONTEXT:].astype(np.float32)
        return float(out[0, 0])
