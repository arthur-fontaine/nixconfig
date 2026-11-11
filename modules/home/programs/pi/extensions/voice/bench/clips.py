"""Test clips, rendered with macOS `say` (no microphone involved).

Run: python clips.py [outdir]   (default /tmp/k12-clips)

STT clips: one sentence each, French and English, with the code words the
person uses ("pnpm", "worktree", "nix build"...).

Turn clips: one `say` utterance per clip with inline `[[slnc N]]` silences, so
prosody stays continuous across a hesitation (separate utterances would each
end on a falling, "finished" intonation and bias the turn detectors). Each
inline silence is a *hold*; the clip ends with 2 s of silence after the real
end of turn. `turn_labels.json` records where the speech stops for each pause
(found from the audio, as `say` adds its own short pauses around ours).
"""

import json
import subprocess
import sys
import wave
from pathlib import Path

import numpy as np

SR = 16000

STT = [
    # id, voice, text (what is spoken), reference (what we expect written)
    ("fr1", "Thomas", "Tu peux lancer pnpm install dans le worktree, puis faire un nix build ?",
     "tu peux lancer pnpm install dans le worktree puis faire un nix build"),
    ("fr2", "Thomas", "Regarde le fichier default point nix et ajoute l'extension voice dans la liste.",
     "regarde le fichier default point nix et ajoute l'extension voice dans la liste"),
    ("fr3", "Thomas", "Le footer ne s'affiche plus depuis le dernier commit, tu peux vérifier les tests ?",
     "le footer ne s'affiche plus depuis le dernier commit tu peux vérifier les tests"),
    ("fr4", "Thomas", "Crée une branche, fais un rebase sur main et pousse sur GitHub.",
     "crée une branche fais un rebase sur main et pousse sur github"),
    ("fr5", "Jacques", "Je voudrais que le daemon tourne en launchd agent, avec un socket Unix.",
     "je voudrais que le daemon tourne en launchd agent avec un socket unix"),
    ("en1", "Samantha", "Can you run pnpm test in the worktree and then do a nix build?",
     "can you run pnpm test in the worktree and then do a nix build"),
    ("en2", "Samantha", "Rewind the last message and append what I just said.",
     "rewind the last message and append what i just said"),
    ("en3", "Samantha", "The TypeScript extension should talk to the daemon over a WebSocket.",
     "the typescript extension should talk to the daemon over a websocket"),
]

TURNS = [
    # id, voice, text with [[slnc ms]] holds
    ("t_fr_euh", "Thomas", "Alors, euh [[slnc 1200]] je voudrais que tu regardes le fichier de config."),
    ("t_fr_mid", "Thomas", "Est-ce que tu peux [[slnc 900]] lancer un nix build sur la branche ?"),
    ("t_fr_two", "Thomas", "Ok donc le problème c'est que [[slnc 1500]] euh [[slnc 800]] le footer ne s'affiche plus."),
    ("t_fr_et", "Thomas", "Regarde le worktree et [[slnc 700]] dis-moi ce qui a changé."),
    ("t_fr_pour", "Thomas", "Ajoute un test pour [[slnc 1100]] la fonction de rewind."),
    ("t_fr_short", "Thomas", "Merci, c'est parfait."),
    ("t_fr_cmd", "Thomas", "Fais un commit."),
    ("t_fr_non", "Thomas", "Non."),
    ("t_fr_list", "Jacques", "Il faut modifier trois fichiers : [[slnc 900]] le footer, [[slnc 700]] le daemon, [[slnc 700]] et les tests."),
    ("t_en_could", "Samantha", "So I was thinking we could [[slnc 1000]] move the daemon into a launchd agent."),
    ("t_en_um", "Samantha", "Um [[slnc 900]] can you check the logs?"),
    ("t_en_cmd", "Samantha", "Run pnpm test."),
]

TAIL_SILENCE_S = 2.0


def say(voice: str, text: str, out: Path) -> np.ndarray:
    aiff = out.with_suffix(".aiff")
    subprocess.run(["say", "-v", voice, "-o", str(aiff), text], check=True)
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(aiff), "-ac", "1", "-ar", str(SR), str(out)], check=True)
    aiff.unlink()
    with wave.open(str(out)) as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768


def write(path: Path, audio: np.ndarray) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((np.clip(audio, -1, 1) * 32767).astype(np.int16).tobytes())


def silences(audio: np.ndarray, min_s: float, frame_s: float = 0.02, thresh_db: float = -45) -> list[tuple[float, float]]:
    """(start, end) of runs of frames below thresh_db, at least min_s long."""
    n = int(frame_s * SR)
    frames = audio[: len(audio) // n * n].reshape(-1, n)
    db = 20 * np.log10(np.sqrt((frames**2).mean(axis=1)) + 1e-9)
    quiet = db < thresh_db
    runs, start = [], None
    for i, q in enumerate(list(quiet) + [False]):
        if q and start is None:
            start = i
        elif not q and start is not None:
            if (i - start) * frame_s >= min_s:
                runs.append((start * frame_s, i * frame_s))
            start = None
    return runs


def main() -> None:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/k12-clips")
    out.mkdir(parents=True, exist_ok=True)
    refs = {}
    for cid, voice, text, ref in STT:
        say(voice, text, out / f"{cid}.wav")
        refs[cid] = {"lang": cid[:2], "text": text, "ref": ref}
    (out / "stt_refs.json").write_text(json.dumps(refs, ensure_ascii=False, indent=1))

    labels = {}
    for cid, voice, text in TURNS:
        audio = say(voice, text, out / f"{cid}.wav")
        audio = np.concatenate([audio, np.zeros(int(TAIL_SILENCE_S * SR), np.float32)])
        write(out / f"{cid}.wav", audio)
        pauses = silences(audio, min_s=0.5)
        # Leading silence isn't a pause; the last run is the real end of turn.
        pauses = [p for p in pauses if p[0] > 0.05]
        labels[cid] = {
            "lang": cid.split("_")[1],
            "text": text,
            "holds": [s for s, _ in pauses[:-1]],
            "eot": pauses[-1][0],
            "duration": len(audio) / SR,
        }
    (out / "turn_labels.json").write_text(json.dumps(labels, ensure_ascii=False, indent=1))
    print(json.dumps(labels, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
