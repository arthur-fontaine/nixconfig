"""Phrase boosting for Parakeet TDT's greedy decoder (mlx-audio), as a boosting tree.

NeMo's context biasing for transducers (GPU-PB, the boosting tree) adds a bonus
to the log-probability of tokens that extend a phrase from a list. This does
the same in the greedy loop: the phrases become a trie of the model's
SentencePiece pieces; at each step, every token that continues a phrase from
the current trie node (or starts one) gets `score` added to its
log-probability before the argmax over tokens. Blank is not boosted, so a
boost can only pick a phrase token over another token, or over blank when the
phrase token is close.

    boost = PhraseBoost(model, ["worktree", "pnpm", "nix build"], score=3.0)
    text = boost.transcribe("speech.wav")
"""

from dataclasses import dataclass, field

import mlx.core as mx
from mlx_audio.stt.models.parakeet import tokenizer


@dataclass
class Node:
    children: dict[int, "Node"] = field(default_factory=dict)
    end: bool = False


def tokenize(phrase: str, vocabulary: list[str]) -> list[int]:
    """Greedy longest-match over the vocabulary's pieces, "▁" marking a word start."""
    pieces = {p: i for i, p in enumerate(vocabulary)}
    text = "▁" + phrase.replace(" ", "▁")
    out, i = [], 0
    while i < len(text):
        for j in range(len(text), i, -1):
            if text[i:j] in pieces:
                out.append(pieces[text[i:j]])
                i = j
                break
        else:
            return []  # a character the vocabulary lacks: skip the phrase
    return out


class PhraseBoost:
    def __init__(self, model, phrases: list[str], score: float = 3.0):
        self.model = model
        self.score = score
        self.root = Node()
        for phrase in phrases:
            # Each phrase as written and lower-cased, since the model may spell either.
            for form in {phrase, phrase.lower(), phrase[:1].upper() + phrase[1:]}:
                ids = tokenize(form, model.vocabulary)
                node = self.root
                for t in ids:
                    node = node.children.setdefault(t, Node())
                if ids:
                    node.end = True

    def _bonus(self, node: Node) -> mx.array:
        b = [0.0] * (self.model.blank_id + 1)
        for t in set(node.children) | set(self.root.children):
            b[t] = self.score
        return mx.array(b)

    def transcribe(self, path: str) -> str:
        from mlx_audio.stt.models.parakeet.audio import log_mel_spectrogram
        from mlx_audio.stt.utils import load_audio

        m = self.model
        audio = load_audio(path, m.preprocessor_config.sample_rate)
        mel = log_mel_spectrogram(audio, m.preprocessor_config)
        mel = mel if mel.ndim == 3 else mx.expand_dims(mel, 0)
        features, lengths = m.encoder(mel)
        mx.eval(features, lengths)
        hidden, cell = m._make_initial_decoder_state(1, features.dtype)
        last, time, symbols, node = m.blank_id, 0, 0, self.root
        tokens: list[int] = []
        while time < int(lengths[0]):
            feature = features[:, time:time + 1]
            current = mx.array([[last]], dtype=mx.int32)
            emb = m.decoder.prediction["embed"](current)
            emb = mx.where(mx.expand_dims(current == m.blank_id, -1), mx.zeros_like(emb), emb)
            out, (h, c) = m.decoder.prediction["dec_rnn"](emb, (hidden, cell))
            joint = m.joint(feature, out.astype(feature.dtype))[0, 0, 0]
            logp = joint[: m.blank_id + 1].astype(mx.float32)
            logp = logp - mx.logsumexp(logp)
            token = int(mx.argmax(logp + self._bonus(node)))
            duration = m.durations[int(mx.argmax(joint[m.blank_id + 1:]))]
            if token != m.blank_id:
                last, hidden, cell = token, h.astype(feature.dtype), c.astype(feature.dtype)
                tokens.append(token)
                # Follow the trie: continue the phrase, or start one, or fall back to the root.
                node = node.children.get(token) or self.root.children.get(token) or self.root
            time += duration
            symbols += 1
            if duration != 0:
                symbols = 0
            elif m.max_symbols is not None and symbols >= m.max_symbols:
                time, symbols = time + 1, 0
        return tokenizer.decode([t for t in tokens if not tokenizer.is_special_token(t, m.vocabulary)], m.vocabulary)
