"""The models of a call, and the one thread that runs them.

MLX work stays on one thread (its streams are thread-bound). Speech synthesis
runs for seconds, and an end-of-turn check during a barge-in can't wait for it,
so the worker interleaves: urgent jobs (end of turn, transcription) run between
two chunks of the speech being generated (a Voxtral chunk is ~0.5 s of audio,
~175 ms of compute).
"""

import queue
import re
import threading
import time
from concurrent.futures import Future
from dataclasses import dataclass, field
from typing import Callable, Iterator

import numpy as np

WHISPER = "mlx-community/whisper-large-v3-turbo"
VOXTRAL = "mlx-community/Voxtral-4B-TTS-2603-mlx-4bit"
VOICES = {"fr": "fr_male", "en": "casual_male"}

# Words Whisper should spell this person's way (the prompt halves French errors on code words, RESEARCH.md).
VOCABULARY = ["Pi", "pnpm", "worktree", "nix build", "default.nix", "commit", "rebase", "GitHub", "launchd",
              "WebSocket", "TypeScript", "daemon", "footer", "rewind", "Herdr"]

# Whisper's well-known inventions on silence or noise.
HALLUCINATIONS = re.compile(r"sous-titr|amara\.org|merci d'avoir regardé|thanks for watching|subtitles by", re.I)


@dataclass
class Transcript:
    text: str
    language: str
    no_speech: float


class Stt:
    """Whisper large-v3-turbo with a vocabulary prompt, the language detected on every turn."""

    def __init__(self):
        import mlx_whisper  # noqa: F401  (imported here so the daemon starts without it)
        self.vocabulary = list(VOCABULARY)
        self(np.zeros(16000, np.float32))  # loads and warms the model

    def __call__(self, audio: np.ndarray) -> Transcript:
        import mlx_whisper
        out = mlx_whisper.transcribe(
            audio.astype(np.float32), path_or_hf_repo=WHISPER, initial_prompt=", ".join(self.vocabulary) + ".",
            condition_on_previous_text=False, temperature=0.0, verbose=None)
        segments = out.get("segments") or []
        no_speech = max((s.get("no_speech_prob", 0.0) for s in segments), default=1.0)
        text = out.get("text", "").strip()
        if HALLUCINATIONS.search(text):
            text = ""
        return Transcript(text, out.get("language") or "fr", no_speech)


class Tts:
    """Voxtral 4B TTS (4-bit), streamed in ~0.5 s chunks of 24 kHz audio."""

    def __init__(self):
        from mlx_audio.tts.utils import load_model
        self.model = load_model(VOXTRAL)
        for _ in self.stream("Bonjour.", "fr"):
            pass

    def stream(self, text: str, language: str) -> Iterator[np.ndarray]:
        voice = VOICES.get(language, VOICES["en"])
        for r in self.model.generate(text=text, voice=voice, stream=True, streaming_interval=0.5):
            yield np.asarray(r.audio, dtype=np.float32).reshape(-1)


class EndOfTurn:
    """VoxTurn (MLX port) given the transcript so far, with Smart Turn rescuing short answers (RESEARCH.md §2)."""

    def __init__(self):
        from .smart_turn import SmartTurn
        from .voxturn_mlx import VoxTurn
        self.voxturn = VoxTurn()
        self.smart = SmartTurn()
        self.voxturn.predict(np.zeros(16000, np.float32))

    def __call__(self, audio: np.ndarray, text: str | None) -> tuple[bool, float, float]:
        vox = self.voxturn.predict(audio, "eot", text=text or None)["yes"]
        smart = self.smart(audio) if vox < 0.5 else 0.0
        return ended(vox, smart), vox, smart

    def invalid(self, audio: np.ndarray) -> float:
        """P(this is not speech: a cough, a laugh, a noise)."""
        return self.voxturn.predict(audio, "invalid")["yes"]

    def interrupts(self, audio: np.ndarray, text: str | None = None) -> float:
        """While Pi speaks: P(the person is interrupting) rather than backchanneling ("mm", "ok")."""
        return self.voxturn.predict(audio, "intent", text=text, speaker="agent")["interrupt"]


def ended(vox: float, smart: float) -> bool:
    """The fused end-of-turn rule measured in bench/eot_fuse.py: 1/18 false cut-offs, 260 ms median."""
    return vox >= 0.5 or (smart >= 0.9 and vox >= 0.1)


@dataclass(order=True)
class _Job:
    priority: int
    order: int
    fn: Callable = field(compare=False)
    future: Future = field(compare=False)


class Worker:
    """Runs every model call on one thread: jobs first, then one chunk of each speech being generated."""

    def __init__(self):
        self.jobs: queue.PriorityQueue[_Job] = queue.PriorityQueue()
        self.streams: list[tuple[Iterator, Callable, Callable]] = []
        self._order = 0
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self.thread = threading.Thread(target=self._run, name="pi-voice-models", daemon=True)
        self.thread.start()

    def submit(self, fn: Callable, priority: int = 1) -> Future:
        f: Future = Future()
        with self._lock:
            self._order += 1
            self.jobs.put(_Job(priority, self._order, fn, f))
        self._wake.set()
        return f

    def stream(self, make: Callable[[], Iterator], on_chunk: Callable, on_done: Callable) -> Callable[[], None]:
        """Generates `make()` chunk by chunk between jobs; returns a cancel function."""
        state = {"it": None, "cancelled": False}

        def cancel():
            state["cancelled"] = True
        with self._lock:
            self.streams.append((state, make, (on_chunk, on_done)))
        self._wake.set()
        return cancel

    def _run(self):
        while True:
            try:
                job = self.jobs.get_nowait()
            except queue.Empty:
                job = None
            if job is not None:
                if job.future.set_running_or_notify_cancel():
                    try:
                        job.future.set_result(job.fn())
                    except BaseException as e:  # reported to whoever waits on it
                        job.future.set_exception(e)
                continue
            with self._lock:
                active = self.streams[0] if self.streams else None
            if active is None:
                self._wake.wait(0.5)
                self._wake.clear()
                continue
            state, make, (on_chunk, on_done) = active
            finished = state["cancelled"]
            if not finished:
                try:
                    if state["it"] is None:
                        state["it"] = iter(make())
                    on_chunk(next(state["it"]))
                except StopIteration:
                    finished = True
                except BaseException as e:
                    finished = True
                    print(f"pi-voice: speech failed: {e!r}", flush=True)
            if finished:
                with self._lock:
                    self.streams.remove(active)
                on_done(state["cancelled"])


class Models:
    """Loads the models on the worker when a call starts; unloads them after a while without a call."""

    def __init__(self, worker: Worker):
        self.worker = worker
        self.stt: Stt | None = None
        self.tts: Tts | None = None
        self.eot: EndOfTurn | None = None
        self.loaded_at = 0.0

    def load(self) -> Future:
        def run():
            t0 = time.time()
            self.eot = self.eot or EndOfTurn()
            self.stt = self.stt or Stt()
            self.tts = self.tts or Tts()
            self.loaded_at = time.time()
            return time.time() - t0
        return self.worker.submit(run, priority=0)

    def unload(self) -> Future:
        def run():
            import gc

            import mlx.core as mx
            self.stt = self.tts = self.eot = None
            gc.collect()
            mx.clear_cache()
        return self.worker.submit(run, priority=0)

    @property
    def ready(self) -> bool:
        return self.stt is not None and self.tts is not None and self.eot is not None
