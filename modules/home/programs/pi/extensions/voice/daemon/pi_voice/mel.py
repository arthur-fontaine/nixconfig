"""Whisper-style log-mel in numpy, as VoxTurn (128 bins) and Smart Turn (80 bins) expect it.

Same as transformers' WhisperFeatureExtractor and VoxTurn's LogMel: 25 ms Hann
window (400), 10 ms hop (160), power spectrum without the last frame, Slaney
mel filters up to 8 kHz, log10 floored at 1e-10, clamped to max - 8, then
(x + 4) / 4. Kept here so the daemon needs neither torch nor transformers.
"""

from functools import lru_cache

import numpy as np

SR = 16000
N_FFT = 400
HOP = 160


def _hz_to_mel(f):
    f = np.asarray(f, dtype=np.float64)
    mel = 3.0 * f / 200.0
    log = f >= 1000.0
    return np.where(log, 15.0 + np.log(np.maximum(f, 1e-10) / 1000.0) / (np.log(6.4) / 27.0), mel)


def _mel_to_hz(m):
    m = np.asarray(m, dtype=np.float64)
    f = 200.0 * m / 3.0
    log = m >= 15.0
    return np.where(log, 1000.0 * np.exp((np.log(6.4) / 27.0) * (m - 15.0)), f)


@lru_cache(maxsize=4)
def mel_filters(n_mels: int) -> np.ndarray:
    """(n_mels, 201) Slaney-normalized triangular filters, as librosa and transformers build them."""
    freqs = np.linspace(0, SR / 2, N_FFT // 2 + 1)
    mels = np.linspace(_hz_to_mel(0.0), _hz_to_mel(SR / 2), n_mels + 2)
    pts = _mel_to_hz(mels)
    fdiff = np.diff(pts)
    ramps = pts[:, None] - freqs[None, :]
    lower = -ramps[:-2] / fdiff[:-1, None]
    upper = ramps[2:] / fdiff[1:, None]
    w = np.maximum(0, np.minimum(lower, upper))
    w *= (2.0 / (pts[2:n_mels + 2] - pts[:n_mels]))[:, None]
    return w.astype(np.float32)


def log_mel(audio: np.ndarray, n_mels: int) -> np.ndarray:
    """(n_mels, frames) for 16 kHz mono float audio; frames = len(audio) // 160."""
    x = np.asarray(audio, dtype=np.float32)
    pad = N_FFT // 2
    x = np.pad(x, (pad, pad), mode="reflect")
    window = np.hanning(N_FFT + 1)[:-1].astype(np.float32)  # periodic Hann, as torch.hann_window
    n = 1 + (len(x) - N_FFT) // HOP
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(n)[:, None]
    spec = np.abs(np.fft.rfft(x[idx] * window, axis=-1)) ** 2  # (frames, 201)
    spec = spec[:-1].T  # drop the last frame, as Whisper does
    mel = np.log10(np.maximum(mel_filters(n_mels) @ spec, 1e-10))
    mel = np.maximum(mel, mel.max() - 8.0)
    return ((mel + 4.0) / 4.0).astype(np.float32)
