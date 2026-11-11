"""The call's state machine with fake models, a fake VAD and a fake clock: no weights, no audio device."""

import json
from concurrent.futures import Future

import numpy as np
import pytest

from pi_voice import framing
from pi_voice.call import FRAME, Call, is_backchannel
from pi_voice.echo import is_echo
from pi_voice.models import Transcript, ended


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


class FakeVad:
    """Speech when the frame is loud: tests send 1.0 for speech and 0.0 for silence."""

    def __call__(self, frame):
        return 1.0 if np.abs(frame).max() > 0.5 else 0.0


class FakeEot:
    def __init__(self):
        self.p = 0.0  # P(end of turn)
        self.p_interrupt = 1.0

    def __call__(self, audio, text):
        return ended(self.p, 0.0), self.p, 0.0

    def invalid(self, audio):
        return 0.0

    def interrupts(self, audio, text=None):
        return self.p_interrupt


class FakeTts:
    def stream(self, text, language):
        yield np.zeros(2400, np.float32)


class FakeModels:
    def __init__(self):
        self.eot = FakeEot()
        self.text = "fais un commit"
        self.tts = FakeTts()
        self.decodes = 0

    def stt(self, audio):
        self.decodes += 1
        return Transcript(self.text, "fr", 0.0)


def done(value) -> Future:
    f: Future = Future()
    f.set_result(value)
    return f


class Harness:
    def __init__(self):
        self.clock = Clock()
        self.models = FakeModels()
        self.events: list[dict] = []
        self.to_helper: list[bytes] = []
        self.call = Call(self.models, lambda fn: done(fn()), self.events.append, self.to_helper.append,
                         now=self.clock, vad=FakeVad())
        self.call.run_stream = self._stream

    def _stream(self, make, on_chunk, on_done):
        for chunk in make():
            on_chunk(chunk)
        on_done(False)
        return lambda: None

    def audio(self, seconds: float, loud: bool):
        n = int(seconds * framing.MIC_RATE / FRAME)
        for _ in range(n):
            self.clock.t += FRAME / framing.MIC_RATE
            frame = np.full(FRAME, 0.9 if loud else 0.0, np.float32)
            self.call.mic((frame * 32767).astype("<i2").tobytes())

    def wait(self, seconds: float):
        """Silence with ticks, as the server's timer does."""
        self.audio(seconds, loud=False)

    def turns(self):
        return [e for e in self.events if e["type"] == "turn"]

    def controls(self):
        return [json.loads(f[5:]) for f in self.to_helper if f[:1] == framing.CONTROL]


def test_a_turn_ends_when_the_model_says_so():
    h = Harness()
    h.audio(1.0, True)
    h.models.eot.p = 0.9
    h.wait(0.5)
    assert [t["text"] for t in h.turns()] == ["fais un commit"]
    assert h.turns()[0]["phase"] == "after_answer"


def test_a_hesitation_is_not_an_end():
    h = Harness()
    h.audio(1.0, True)
    h.models.eot.p = 0.1  # "euh…": not finished
    h.wait(1.2)
    assert h.turns() == []
    h.audio(1.0, True)  # he goes on
    h.models.eot.p = 0.9
    h.wait(0.5)
    assert len(h.turns()) == 1


def test_a_long_silence_ends_the_turn_whatever_the_model_says():
    h = Harness()
    h.audio(1.0, True)
    h.models.eot.p = 0.0
    h.wait(1.8)
    assert len(h.turns()) == 1


def test_the_speculative_decode_is_reused():
    h = Harness()
    h.audio(1.0, True)
    h.models.eot.p = 0.9
    h.wait(0.6)
    assert len(h.turns()) == 1
    assert h.models.decodes == 1, "the transcript decoded at the pause is the one sent"


def test_speech_after_sending_and_before_pi_speaks_is_an_addition():
    h = Harness()
    h.audio(1.0, True)
    h.models.eot.p = 0.9
    h.wait(0.5)
    h.audio(1.0, True)
    h.wait(0.5)
    assert [t["phase"] for t in h.turns()] == ["after_answer", "before_speech"]


def test_pi_speaking_then_interrupted():
    h = Harness()
    h.audio(1.0, True)
    h.models.eot.p = 0.9
    h.wait(0.5)
    h.call.speak("a1", "Un. Deux. Trois.", final=True)
    assert any(e["type"] == "speaking" for e in h.events)
    h.audio(0.8, True)  # talks over Pi's voice
    assert {"cmd": "stop"} in h.controls()
    assert [e for e in h.events if e["type"] == "spoken"][0]["interrupted"] is True
    h.wait(0.5)
    assert h.turns()[-1]["phase"] == "while_speaking"


def test_a_backchannel_leaves_pi_talking():
    h = Harness()
    h.audio(1.0, True)
    h.models.eot.p = 0.9
    h.wait(0.5)
    h.call.speak("a1", "Un long texte.", final=False)
    h.models.eot.p_interrupt = 0.1
    h.models.text = "ok"
    h.audio(0.4, True)  # "ok", short
    h.wait(0.5)
    assert {"cmd": "stop"} not in h.controls()
    assert any(e["type"] == "barge" and e["phase"] == "dropped" for e in h.events)
    assert len(h.turns()) == 1


def test_pi_hears_its_own_voice_back():
    h = Harness()
    h.audio(1.0, True)
    h.models.eot.p = 0.9
    h.wait(0.5)
    h.call.speak("a1", "J'ai trouvé la cause du problème dans le footer.", final=True)
    h.call.drained()
    h.wait(0.6)  # spoken to the end
    h.models.text = "la cause du problème dans le footer"
    h.audio(1.0, True)  # the tail of its voice, through the speakers
    h.wait(0.6)
    assert len(h.turns()) == 1, "the echo isn't sent"


def test_muted_hears_nothing():
    h = Harness()
    h.call.set_mute(True)
    h.audio(1.0, True)
    h.models.eot.p = 0.9
    h.wait(0.5)
    assert h.turns() == []


def test_the_earcon_follows_a_sent_turn():
    h = Harness()
    h.audio(1.0, True)
    h.models.eot.p = 0.9
    h.wait(0.5)
    kinds = [framing.parse_speaker(f[5:])[1] for f in h.to_helper if f[:1] == framing.SPEAKER]
    assert framing.EARCON in kinds


@pytest.mark.parametrize("text,expected", [("ok", True), ("oui oui", True), ("mm", True), ("Arrête-toi à cinq.", False), ("ok mais non", False)])
def test_backchannels(text, expected):
    assert is_backchannel(text) is expected


def test_echo_filter():
    assert is_echo("la cause du problème", "J'ai trouvé la cause du problème dans le footer.")
    assert not is_echo("non attends plutôt le header", "J'ai trouvé la cause du problème dans le footer.")
    assert not is_echo("", "x")


def test_the_fused_end_of_turn_rule():
    assert ended(0.6, 0.0)
    assert not ended(0.3, 0.5)
    assert ended(0.15, 0.95), "Smart Turn rescues a short answer VoxTurn hesitates on"
    assert not ended(0.05, 0.99)
