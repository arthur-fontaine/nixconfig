# Pi voice

Voice calls with Pi. `/call` (or **Ctrl+Alt+V**) starts a call; you talk, Pi hears when you
have finished and sends your message itself; it answers in writing exactly as always, and says a
spoken version of the answer at the same time. The spoken text shows as a collapsed row under
the answer, `⦁ Spoke 12s · « … »  (click to expand)`; a click or Ctrl+O opens it.

- **Adding details**: speak again right after sending, before Pi starts speaking, and no file
  was changed yet: Pi drops its answer and resends your message with what you added.
- **Interrupting**: speak while Pi is speaking (or after it changed files): its voice stops and
  your words go to the running turn (a steer), or as the next message when Pi is done.
- After the answer was spoken to the end, what you say is a new message.
- `/call mute` / `/call unmute` (or **Ctrl+Alt+M**), `/call end` (or `/call` again). The call
  ends by itself after 10 minutes without speech. Another chat's `/call` offers to take the call.

Research, measurements and the design: [RESEARCH.md](RESEARCH.md), [DESIGN.md](DESIGN.md).

## How it works

- `index.ts` (this extension, in every Pi): the command and keys, the footer item (`listening`), sending and rewinding messages, the spoken pass and the row. It adds nothing to
  the model's context: no prompt, no message, no tool. The spoken text is a custom entry
  (`voice-spoken`), which Pi never sends to the model.
- The spoken pass (`spoken.ts`): Pi's text is cut into blocks as it streams; a short plain block
  is said as it is, the rest goes to Claude Haiku through Pi's own `claude-code` provider, which
  says the gist (no code, no paths). Without Haiku, only the plain blocks are said, and "La
  réponse est à l'écran".
- `daemon/` (`pi-voice serve`, Python, MLX): the first `/call` starts it, detached, on
  `~/.cache/pi-voice/daemon.sock`; one daemon for every chat, so one call at a time. It runs
  Silero VAD, VoxTurn (ported to MLX, 8-bit; Smart Turn rescues short answers) for the end of
  turn, Whisper large-v3-turbo with a vocabulary prompt for the transcript, and Voxtral 4B TTS
  (4-bit). About 6 GB while a call is on; it unloads the models 10 minutes after a call and
  exits after 30 minutes without a client. Log: `~/.cache/pi-voice/daemon.log`.
- `audio/` (`pi-voice-audio`, Swift): the only process that opens the microphone and the
  speakers, with macOS voice processing (echo cancellation). The daemon also drops speech that
  is just its own words coming back, and tells interruptions from "ok", "mm".
- Packaging: `../../voice.nix`. Models download into the Hugging Face cache on the first call
  (`pi-voice fetch` gets them ahead, ~6 GB); the Python environment is a uv venv in
  `~/.cache/pi-voice/venv`, synced from `daemon/uv.lock`.

## Checks

```sh
node --test 'tests/*.test.ts'                    # the extension: the rewind/steer rule, the spoken pass, the row
cd daemon
uv run pytest -m "not models"                    # the call's state machine with fakes
uv run pytest -m models                          # VoxTurn in MLX against its PyTorch code (needs the clips of ../bench/clips.py)
uv run python ../tests/e2e/run.py                # end to end: WAV files instead of the mic, a real Pi on Haiku
```

The end-to-end harness starts the daemon with a fake audio helper (`pi_voice.fake_audio`: WAV
files in, a WAV file out, no device), and for each case a real `pi --mode rpc` on Haiku with
this extension and `tests/e2e/capture.ts`, which records everything that reaches the model. It
checks the transcript, the auto-send, no send on hesitations, the rewind with the appended
text, the steer while Pi speaks, the voice row, that no instruction or message of the extension
reaches the model (the system message is byte-for-byte that of a run without the extension),
and that the written answer is exactly what the provider streamed.

## Manual checks, after `rebuild`

What only a person can check: the real microphone and speakers.

1. In a Herdr terminal, start `pi` and type `/call`. The first time, the footer shows
   `loading voice models…` for a while (downloads, then ~20 s); then `listening`.
2. **Permission**: macOS asks whether **Herdr** may use the microphone (once). Allow. If nothing
   is asked and nothing is heard, check System Settings → Privacy & Security → Microphone → Herdr.
3. **Auto-send**: say « Dis-moi bonjour en une phrase. » and stop. Within about a second and a
   half, the message appears and is sent, with a short two-note chime.
4. **Hesitation**: say « Explique-moi, euh… » wait a second « …ce qu'est un worktree. » One
   message only, with both halves.
5. **Pi's voice**: on the Mac's speakers, without headphones, Pi says the answer; it must not
   hear itself (no message sent from its own voice, no interruption of itself).
6. **Adding details**: say « Liste trois fichiers de ce dossier. » and right after it's sent,
   before Pi speaks, « en ignorant les fichiers cachés. » Pi starts over with one message holding
   both.
7. **Interrupting**: ask « Compte lentement jusqu'à vingt. » and while Pi counts, say « Arrête-toi
   à dix. » Its voice stops; your words go to Pi. Saying only « ok » or « mm » while it talks
   doesn't stop it.
8. **The row**: under each answer, `⦁ Spoke … (click to expand)`; a click opens it, Ctrl+O too.
9. **Two chats**: `/call` in another Pi asks to take the call; the first one's footer says the
   call moved.
10. `/call` again ends the call; Activity Monitor shows `python` (pi-voice) releasing its ~6 GB
    10 minutes later.
