"""One call: the mic in, turns out, Pi's speech back. The state machine of DESIGN.md, in the daemon.

The call listens all the time. What it does with the person's speech depends on
where Pi's answer is (`answer`):

- "none": no answer pending (first turn, or the last answer was spoken to the
  end): a turn ends -> `turn` with phase "after_answer" (a new message);
- "pending": a voice message was sent and Pi hasn't started speaking: speech
  here is an addition -> `turn` with phase "before_speech";
- "speaking": Pi's voice is playing: speech ducks it at once, and once it is
  confirmed as an interruption (not a backchannel, not 300 ms of noise) the
  voice stops -> `turn` with phase "while_speaking".

The extension turns the phase into rewind or steer (voice/addition.ts), since
only it knows which tools ran. Every model call goes through the injected
`run(fn) -> Future`, every message out through `emit`, `helper`; time through
`now`, so tests drive it with fakes.
"""

import math
import time
from dataclasses import dataclass, field
from typing import Callable

import numpy as np

from . import framing
from .echo import is_echo

FRAME = 512  # VAD frame, 32 ms
SPEECH_ON = 0.5
SPEECH_OFF = 0.35
ONSET_S = 0.15  # speech this long starts a turn
PAUSE_S = 0.2  # silence this long is a pause: ask whether the turn ended
RECHECK_S = 0.25
FALLBACK_S = 1.5  # silence this long ends the turn whatever the models say
PREROLL_S = 0.5  # audio kept from before the onset: 0.3 s clipped the first word ("Compte") in the e2e run
BARGE_S = 0.3  # speech over Pi's voice this long, judged an interruption, stops it
BARGE_LONG_S = 0.6  # speech over Pi's voice this long stops it whatever VoxTurn says: a backchannel is shorter
# What people say to show they listen, not to take the turn. Measured: VoxTurn's "intent" question took
# "Arrête-toi à cinq" for a backchannel (P(interrupt) 0.01-0.13), so the words decide in the end.
BACKCHANNELS = {"mm", "mmh", "hm", "hmm", "mhm", "ok", "okay", "oui", "ouais", "d'accord", "daccord", "ah", "oh", "euh",
                "yeah", "yes", "yep", "right", "uh-huh", "uh", "huh", "sure", "bien", "voilà", "exactement", "super", "cool"}
DUCK_GAIN = 0.15
SPOKEN_GRACE_S = 0.4  # after the last word is played, still "speaking" for this long
IDLE_END_S = 600.0


@dataclass
class Turn:
    started: float
    phase: str  # "after_answer" | "before_speech" | "while_speaking"
    audio: list[np.ndarray] = field(default_factory=list)
    pause_started: float | None = None
    next_check: float = 0.0
    speech_s: float = 0.0
    transcript: object = None  # the latest Transcript (speculative decode)
    transcript_len: int = 0  # samples it covered
    decoding: bool = False
    decode_len: int = 0  # samples the decode in flight covers
    ending: str | None = None  # the turn ended while that decode was running: finish when it lands
    n: int = 0  # samples so far
    last_speech_n: int = 0  # samples up to the last speech frame
    checking: bool = False
    confirmed: bool = False  # barge-in judged an interruption

    def samples(self) -> np.ndarray:
        return np.concatenate(self.audio) if self.audio else np.zeros(0, np.float32)


def is_backchannel(text: str) -> bool:
    """A few words that only show the person is listening ("ok", "mm", "oui oui")."""
    from .echo import words
    w = words(text)
    return 0 < len(w) <= 3 and all(x in BACKCHANNELS for x in w)


class Call:
    def __init__(self, models, run: Callable, emit: Callable[[dict], None], helper: Callable[[bytes], None],
                 now: Callable[[], float] = time.time, vad=None):
        self.models, self.run, self.emit, self.helper, self.now = models, run, emit, helper, now
        from .vad import Vad
        self.vad = vad or Vad()
        self.buffer = np.zeros(0, np.float32)
        self.preroll: list[np.ndarray] = []
        self.speech_run = 0.0
        self.silence_run = 0.0
        self.in_speech = False
        self.turn: Turn | None = None
        self.answer = "none"
        self.language = "fr"
        self.muted = False
        self.last_speech = now()
        # Pi's speech: queue of (answer id, sentence); what was played, for the row and the echo filter.
        self.say_queue: list[tuple[str, str, bool]] = []
        self.saying: dict | None = None
        self.seq = 0
        self.unplayed: set[int] = set()
        self.spoken: dict[str, list[str]] = {}
        self.final_ids: set[str] = set()
        self.last_played = 0.0
        self.recent_speech = ""
        self.cancel_stream: Callable | None = None
        self.dropped: set[str] = set()  # answers interrupted or rewound: their late sentences are ignored
        self.held: list[bytes] = []  # Pi's audio kept back while the person adds to their turn
        self.state = "listening"
        self._emit_state()

    # ------------------------------------------------------------------ state for the footer
    def _emit_state(self):
        name = ("user_speaking" if self.turn and self.turn.pause_started is None else
                "paused" if self.turn else
                "pi_speaking" if self.answer == "speaking" else
                "pi_working" if self.answer == "pending" else "listening")
        if self.muted:
            name = "muted"
        if name != self.state:
            self.state = name
            self.emit({"type": "state", "name": name})

    # ------------------------------------------------------------------ mic
    def mic(self, pcm16: bytes) -> None:
        samples = np.frombuffer(pcm16, dtype="<i2").astype(np.float32) / 32768.0
        self.buffer = np.concatenate([self.buffer, samples])
        while len(self.buffer) >= FRAME:
            frame, self.buffer = self.buffer[:FRAME], self.buffer[FRAME:]
            self._frame(frame)
        self.tick()

    def _frame(self, frame: np.ndarray) -> None:
        if self.muted:
            return
        p = self.vad(frame)
        dt = FRAME / framing.MIC_RATE
        if p >= SPEECH_ON or (self.in_speech and p >= SPEECH_OFF):
            self.speech_run += dt
            self.silence_run = 0.0
        else:
            self.silence_run += dt
            self.speech_run = 0.0
        speaking = self.speech_run > 0 and (self.in_speech or self.speech_run >= ONSET_S)
        t = self.now()
        if self.turn is None:
            self.preroll = (self.preroll + [frame])[-int(PREROLL_S * framing.MIC_RATE / FRAME):]
            if speaking:
                self._start_turn(t)
        else:
            self.turn.audio.append(frame)
            self.turn.n += len(frame)
            if speaking:
                self.turn.last_speech_n = self.turn.n
                self.turn.speech_s += dt
                if self.turn.pause_started is not None:
                    self.turn.pause_started = None  # the person goes on: the pause was a hesitation
                    self.emit({"type": "partial_resumed"})
                if self.turn.phase == "while_speaking" and not self.turn.confirmed:
                    self._judge_barge(t)
            elif self.turn.pause_started is None and self.silence_run >= PAUSE_S:
                self.turn.pause_started = t - self.silence_run
                self.turn.next_check = t
                self._decode()
        self.in_speech = speaking
        if speaking:
            self.last_speech = t
        self._emit_state()

    def _start_turn(self, t: float) -> None:
        phase = {"none": "after_answer", "pending": "before_speech", "speaking": "while_speaking"}[self.answer]
        self.turn = Turn(started=t, phase=phase, audio=list(self.preroll))
        self.turn.n = sum(len(f) for f in self.turn.audio)
        self.preroll = []
        if phase == "while_speaking":
            self.helper(framing.json_frame(framing.CONTROL, {"cmd": "gain", "value": DUCK_GAIN}))
            self.emit({"type": "barge", "phase": "start"})

    # ------------------------------------------------------------------ barge-in
    def _judge_barge(self, t: float) -> None:
        turn = self.turn
        if turn.speech_s >= BARGE_LONG_S:
            turn.confirmed = True
            self._stop_speech(interrupted=True)
            self.emit({"type": "barge", "phase": "confirmed"})
            return
        if turn.speech_s < BARGE_S or turn.checking:
            return
        turn.checking = True
        audio = turn.samples()
        fut = self.run(lambda: self.models.eot.interrupts(audio))

        def done(f):
            turn.checking = False
            try:
                p = f.result()
            except Exception:
                p = 1.0
            print(f"pi-voice: barge-in P(interrupt)={p:.2f} after {turn.speech_s:.2f}s of speech", flush=True)
            if self.turn is not turn or turn.confirmed:
                return
            if p >= 0.5:
                turn.confirmed = True
                self._stop_speech(interrupted=True)
                self.emit({"type": "barge", "phase": "confirmed"})
            # A backchannel ("mm", "ok") leaves Pi talking: un-duck when the turn ends.
        fut.add_done_callback(done)

    # ------------------------------------------------------------------ end of turn
    def _decode(self) -> None:
        """Transcribes the turn so far (speculatively, while the pause lasts)."""
        turn = self.turn
        if turn is None or turn.decoding:
            return
        turn.decoding = True
        audio = turn.samples()
        turn.decode_len = len(audio)
        fut = self.run(lambda: self.models.stt(audio))

        def done(f):
            turn.decoding = False
            try:
                turn.transcript, turn.transcript_len = f.result(), len(audio)
            except Exception as e:
                self.emit({"type": "error", "message": f"transcription failed: {e}"})
                return
            if turn.ending is not None:
                self._end_turn(turn, turn.ending, finishing=True)
            elif self.turn is turn and turn.transcript.text:
                self.emit({"type": "partial", "text": turn.transcript.text})
        fut.add_done_callback(done)

    def tick(self) -> None:
        """Called on every mic frame and by the server's timer: end-of-turn checks, idle end."""
        t = self.now()
        turn = self.turn
        if turn is not None and turn.pause_started is not None:
            silent = t - turn.pause_started
            if silent >= FALLBACK_S:
                self._end_turn(turn, "timeout")
            elif t >= turn.next_check and not turn.checking:
                turn.next_check = t + RECHECK_S
                turn.checking = True
                audio = turn.samples()
                text = turn.transcript.text if turn.transcript else None
                fut = self.run(lambda: self.models.eot(audio, text))

                def done(f, turn=turn):
                    turn.checking = False
                    try:
                        ended, *_ = f.result()
                    except Exception:
                        ended = False
                    if ended and self.turn is turn and turn.pause_started is not None:
                        self._end_turn(turn, "model")
                fut.add_done_callback(done)
        if self.answer == "speaking" and not self.unplayed and self.saying is None and not self.say_queue \
                and self._answer_final() and t - self.last_played >= SPOKEN_GRACE_S:
            self._answer_done()
        if self.turn is None and not self.muted and t - self.last_speech >= IDLE_END_S:
            self.last_speech = t
            self.emit({"type": "idle_end"})

    def _end_turn(self, turn: Turn, why: str, finishing: bool = False) -> None:
        if not finishing:
            if self.turn is not turn:
                return
            self.turn = None
            self.preroll = []
        audio = turn.samples()
        covered = lambda n: n >= turn.last_speech_n  # noqa: E731
        # The speculative decode heard all the speech: it is the transcript.
        if turn.transcript is not None and covered(turn.transcript_len):
            self._finish(turn, turn.transcript, audio)
            return
        # One is running that will: wait for it rather than decoding twice.
        if turn.decoding and covered(turn.decode_len):
            turn.ending = why
            return
        fut = self.run(lambda: self.models.stt(audio))
        fut.add_done_callback(lambda f: self._finish(turn, f.result(), audio) if not f.exception() else
                              self.emit({"type": "error", "message": f"transcription failed: {f.exception()}"}))

    def _finish(self, turn: Turn, transcript, audio: np.ndarray) -> None:
        text = transcript.text.strip()
        recent = self.recent_speech if self.now() - self.last_played < 3.0 or self.answer == "speaking" else ""
        reason = ("empty" if not text else
                  "no speech" if transcript.no_speech > 0.8 and len(text) < 12 else
                  "echo" if recent and is_echo(text, recent) else None)
        if reason is None and len(audio) < framing.MIC_RATE:
            try:
                if self.models.eot.invalid(audio) >= 0.8:
                    reason = "not speech"
            except Exception:
                pass
        if reason is None and turn.phase == "while_speaking" and not turn.confirmed and is_backchannel(text):
            reason = "backchannel"
        if reason is not None:
            print(f"pi-voice: dropped a {turn.phase} turn ({reason}): {text!r}", flush=True)
            if turn.phase == "before_speech":
                self._release_held()
            if turn.phase == "while_speaking":
                self.helper(framing.json_frame(framing.CONTROL, {"cmd": "gain", "value": 1.0}))
                self.emit({"type": "barge", "phase": "dropped", "reason": reason})
            self._emit_state()
            return
        self.language = transcript.language if transcript.language in ("fr", "en") else self.language
        if turn.phase == "while_speaking" and self.answer == "speaking":
            self._stop_speech(interrupted=True)
        self.emit({"type": "turn", "text": text, "phase": turn.phase, "language": self.language,
                   "audio_ms": round(1000 * len(audio) / framing.MIC_RATE)})
        self.answer = "pending"
        self._earcon()
        self._emit_state()

    # ------------------------------------------------------------------ Pi's voice
    def speak(self, answer_id: str, text: str, final: bool) -> None:
        if answer_id in self.dropped:
            return
        if text.strip():
            self.say_queue.append((answer_id, text.strip(), final))
        if final:
            self.final_ids.add(answer_id)
        self._next_sentence()
        self._emit_state()

    def _answer_final(self) -> bool:
        return bool(self.final_ids)

    def _next_sentence(self) -> None:
        if self.saying is not None or not self.say_queue or self.models.tts is None:
            return
        answer_id, text, _ = self.say_queue.pop(0)
        self.saying = {"id": answer_id, "text": text}
        language = self.language
        tts = self.models.tts

        def on_chunk(chunk: np.ndarray):
            if self.saying is None:
                return
            pcm = (np.clip(chunk, -1, 1) * 32767).astype("<i2").tobytes()
            if self.turn is not None and self.turn.phase == "before_speech":
                self.held.append(pcm)  # not over the person: after their addition, or dropped by a rewind
                return
            self._play(answer_id, pcm)

        def on_done(cancelled: bool):
            said = self.saying
            self.saying = None
            if said and not cancelled:
                self.spoken.setdefault(said["id"], []).append(said["text"])
                self.recent_speech = (self.recent_speech + " " + said["text"])[-600:]
            self._next_sentence()

        self.cancel_stream = self.run_stream(lambda: tts.stream(text, language), on_chunk, on_done)

    run_stream: Callable = None  # set by the server: Worker.stream

    def _play(self, answer_id: str, pcm: bytes) -> None:
        if answer_id in self.dropped:
            return
        if self.answer != "speaking":
            self.answer = "speaking"
            self.emit({"type": "speaking", "id": answer_id})
        self.seq += 1
        self.unplayed.add(self.seq)
        self.helper(framing.speaker_frame(self.seq, framing.SPEECH, pcm))

    def _release_held(self) -> None:
        held, self.held = self.held, []
        for pcm in held:
            self._play(self.saying["id"] if self.saying else "held", pcm)

    def played(self, seq: int) -> None:
        self.unplayed.discard(seq)
        self.last_played = self.now()

    def drained(self) -> None:
        self.unplayed.clear()
        self.last_played = self.now()

    def _stop_speech(self, interrupted: bool) -> None:
        if self.cancel_stream:
            self.cancel_stream()
        said = self.saying
        self.saying = None
        self.say_queue.clear()
        self.unplayed.clear()
        self.helper(framing.json_frame(framing.CONTROL, {"cmd": "stop"}))
        self.helper(framing.json_frame(framing.CONTROL, {"cmd": "gain", "value": 1.0}))
        ids = {said["id"]} if said else set()
        ids |= set(self.spoken) | self.final_ids
        self.dropped |= ids
        for answer_id in ids:
            parts = self.spoken.pop(answer_id, [])
            if said and said["id"] == answer_id:
                parts.append(said["text"] + " …")
            self.emit({"type": "spoken", "id": answer_id, "text": " ".join(parts), "interrupted": interrupted})
        self.final_ids.clear()
        self.answer = "none"

    def _answer_done(self) -> None:
        for answer_id in sorted(set(self.spoken) | self.final_ids):
            self.emit({"type": "spoken", "id": answer_id, "text": " ".join(self.spoken.pop(answer_id, [])),
                       "interrupted": False})
        self.final_ids.clear()
        self.answer = "none"
        self._emit_state()

    def answer_finished_silent(self) -> None:
        """Pi's run ended with nothing to say (or it was aborted): back to listening."""
        if self.answer == "pending" and not self.say_queue and self.saying is None:
            self.answer = "none"
            self._emit_state()

    def cancel_answer(self) -> None:
        """The extension aborted Pi's run (rewind): drop whatever was going to be said."""
        self.held = []
        if self.answer == "speaking" or self.saying or self.say_queue:
            self._stop_speech(interrupted=True)
        self.answer = "pending"
        self._emit_state()

    def continue_answer(self) -> None:
        """The extension keeps Pi's answer (a steer, not a rewind): play what was held back."""
        self._release_held()

    def set_mute(self, on: bool) -> None:
        self.muted = on
        if on:
            self.turn = None
        self._emit_state()

    def _earcon(self) -> None:
        """Two short rising tones: "heard you, sent"."""
        sr = framing.SPEAKER_RATE
        tones = []
        for f in (660, 880):
            n = int(0.07 * sr)
            t = np.arange(n) / sr
            env = np.sin(np.pi * np.arange(n) / n) ** 2
            tones.append(0.2 * env * np.sin(2 * math.pi * f * t))
        pcm = (np.concatenate(tones) * 32767).astype("<i2").tobytes()
        self.seq += 1
        self.helper(framing.speaker_frame(self.seq, framing.EARCON, pcm))
