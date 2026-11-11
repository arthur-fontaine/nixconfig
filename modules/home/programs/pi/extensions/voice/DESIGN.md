# Pi voice: design (phase 1, approved; built in phase 2)

> **Phase 2 changes, from the person's answers.** STT is Whisper large-v3-turbo with the
> vocabulary prompt (nothing else matched it on French and code words, RESEARCH.md), TTS is
> Voxtral 4B. The rewind rule (Q3) is narrower than proposed below: a total rewind only when the
> new speech starts **before Pi starts speaking** and no tool changed files; while Pi speaks, or
> after a file change, the words are a steer; after the answer is spoken, a new message
> (`addition.ts`, `whatToDoWithAddition`). The mute key is Ctrl+Alt+M. The rest is as designed;
> README.md describes what was built.
>
> **Permissions, as seen in the live test.** Herdr's terminals run in herdr-core (`Herdr Core.app`,
> `dev.herdr.core`, Developer-ID signed), so macOS asked for and keeps the microphone grant under
> **herdr-core**, not Herdr.app. It survives rebuilds of pi-voice and its helper, and of herdr-core
> as long as it keeps that signature.

Calls with Pi: the person talks, Pi hears when he has finished and sends the
message itself; Pi answers in writing exactly as today and, in parallel, out
loud; if he speaks again while Pi is answering, Pi drops its answer, rewinds
and resends his message with what he just added.

The models and the numbers behind each choice are in [RESEARCH.md](RESEARCH.md).
Open questions for the person are at the end ([Open questions](#open-questions)).

## What the person asked for, as requirements

1. Local STT and TTS, the best current ones, French first with English
   technical words.
2. **Auto-send**: the message goes when he has finished his turn, judged by a
   recent end-of-turn model, not by a fixed silence.
3. **Rewind and append**: if he speaks again after his message was sent and
   while Pi is answering, Pi's answer is dropped and his message is resent
   with the new words added.
4. **Two outputs**: the written answer is the normal one, unchanged, even in
   style; the spoken version is shown in a collapsed row like "Read 2 files",
   opened by a click.
5. Several Pi chats open, one in a call at a time; as few permission prompts
   as possible.

## Architecture

```
 Herdr (holds the microphone grant: NSMicrophoneUsageDescription + audio-input entitlement)
 ├─ pi (chat A) ── voice extension ─┐
 ├─ pi (chat B) ── voice extension ─┤  NDJSON over a Unix socket
 │                                  │  ~/.cache/pi-voice/daemon.sock
 └─ pi-voice daemon (Python, MLX) ◄─┘  spawned by the first /call, detached
      ├─ models: Silero VAD, VoxTurn (MLX port) + Smart Turn, Parakeet v3, ZONOS3-Mini
      ├─ the call state machine (below)
      └─ pi-voice-audio (Swift child): AVAudioEngine with voice processing (echo cancellation)
           mic → 16 kHz mono frames on stdout; TTS PCM on stdin → speakers; playback position
```

Three processes, each doing one thing:

- **The voice extension** (TypeScript, in every Pi): the `/call` command and
  key, the footer status, sending and rewinding messages, the spoken row,
  and the spoken pass (Haiku through Pi's provider). Thin: no audio, no model.
- **The daemon** (`pi-voice`, Python): loads the models once, runs the state
  machine, decides turns and barge-ins, synthesizes speech. One per user, so
  one call at a time is a property of the design, not a lock to get right.
- **The audio helper** (`pi-voice-audio`, ~200 lines of Swift): the only
  process that opens the microphone and the speakers, so echo cancellation
  has both signals. Swift because voice processing is an AVAudioEngine API
  and a real-time audio callback in Python is fragile.

**Why spawned from Pi and not a launchd agent.** macOS charges a microphone
access to the *responsible process*: for anything started from a terminal,
the terminal app. Herdr is Developer-ID signed and already declares the
microphone (checked: `NSMicrophoneUsageDescription` "Terminal programs
running in Herdr can use the microphone…", entitlement
`com.apple.security.device.audio-input`). A daemon spawned from Pi inside
Herdr inherits Herdr as its responsible process, even once detached, so the
call costs **at most one prompt, for Herdr, once**, and survives every
rebuild. A launchd agent would be its own responsible process: it would need
its own `.app` with an Info.plist, and a stable signing identity, since TCC
pins an ad-hoc signature (what nix produces) to the binary's cdhash and
re-prompts after every rebuild
([details](https://nick-liu.com/posts/tcc-cdhash-trap/)); that means a
self-signed certificate made by hand in Keychain Access. It stays the
fallback for using voice outside Herdr (open question Q7).

**Lifecycle.**

- `/call` connects to the socket; if nothing answers, it spawns `pi-voice`
  detached (`spawn` with `detached: true`, `stdio` to a log file) and waits
  for it. First start loads the models: ~10–20 s from a warm disk cache
  (load times in RESEARCH.md), shown in the footer as "chargement…".
- The daemon unloads the models 10 minutes after the last call ends (RAM back
  to near zero) and exits after 30 minutes with no client.
- **One call at a time**: the daemon knows which session owns the call
  (session id and name, sent by the extension). `/call` in another chat asks
  "Reprendre l'appel de « name » ?"; yes moves the call (the old chat's
  footer says "appel déplacé vers « name »"), no leaves it. Every connected
  chat shows in its footer that a call is on elsewhere.

**Transport.** One Unix socket, newline-delimited JSON, a `v` field for the
protocol version. Audio never reaches Pi; it stays between the daemon and
its helper (binary frames over the helper's stdin/stdout). Messages:

| Direction | Message | Meaning |
| --- | --- | --- |
| Pi → daemon | `hello {session, name, cwd}` | a chat connected |
| | `call.start`, `call.end`, `call.take` | start, end, move the call |
| | `agent {state: "busy" \| "idle", mutated: bool}` | Pi's run state, and whether a tool with side effects ran since the voice message |
| | `speak {id, text, final}` | spoken text to say, in order, by sentence |
| | `speak.cancel {id}` | drop what's queued for this answer |
| | `vocab {words}` | project words (for a biasing STT, if chosen) |
| | `mute {on}` | stop listening without ending the call |
| daemon → Pi | `state {name, owner}` | the call state, for the footer |
| | `partial {text}` | the words so far, for the footer |
| | `turn {id, text, audio_ms}` | the user finished a turn: send it |
| | `barge {phase: "start" \| "confirmed" \| "dropped"}` | the user is talking over Pi |
| | `spoken {id, text, interrupted_at}` | what was actually said aloud, up to where it stopped |
| | `error {message}` | shown, and the call ends cleanly |

## The call, as a state machine

The daemon owns the states; the extension applies the Pi side of each
transition. Times are the defaults, tunable in the daemon's config.

```
            /call                 speech (VAD ≥ 150 ms)
  OFF ─────────────► LISTENING ─────────────────────► USER_SPEAKING
   ▲                    ▲  ▲                          │        ▲
   │ /call again,       │  │ empty / noise            │ silence│ speech again
   │ error              │  │ (VoxTurn "invalid")      │ ≥200 ms│
   │                    │  │                          ▼        │
   │                    │  └─────────────────────── PAUSED ────┘
   │                    │                              │ P(end) ≥ 0.5 (VoxTurn + transcript,
   │                    │                              │ Smart Turn rescue), or 1.5 s
   │                    │                              ▼
   │                    │                        END_OF_TURN ── final transcript ──► SENT
   │                    │                                                            │
   │                    │   reply spoken to the end,                                 │ Pi starts
   │                    │   then 400 ms                                              ▼
   │                    └────────────────────── PI_SPEAKING ◄── first sentence ── PI_WORKING
   │                                                │ speech                         │ speech
   │                                                ▼                                ▼
   │                                           BARGE_IN (TTS ducked, user speaking, both cases)
   │                                                │
   │            backchannel, echo, < 300 ms ────────┘ (resume TTS)
   │                                                │ confirmed
   │                                                ▼
   │                                   USER_ADDING ─(end of turn)─► REWIND_APPEND ─► SENT
   └──────────────────────────────────────────────────────────────────────────────────
```

| State | Entered when | The daemon | Pi (extension) | Footer |
| --- | --- | --- | --- | --- |
| OFF | no call | idle, models unloaded after 10 min | nothing | nothing |
| LISTENING | `/call`, or the previous exchange finished | VAD on the mic | — | `📞 à l'écoute` |
| USER_SPEAKING | VAD hears ≥ 150 ms of speech | buffers the turn; re-decodes it every 0.5 s for the partial | — | `📞 « partial… »` |
| PAUSED | 200 ms of silence | asks VoxTurn (with the partial transcript) now and every 250 ms; starts the final decode speculatively | — | same |
| END_OF_TURN | P(end) ≥ 0.5, or Smart Turn ≥ 0.9 with VoxTurn ≥ 0.1, or 1.5 s of silence | final transcript (65 ms, often already done); drops it if VoxTurn says "invalid" (cough, noise) or it is empty | — | — |
| SENT | `turn` sent | plays a short earcon (Q5) | `pi.sendUserMessage(text)`, or `{deliverAs: "steer"}` if Pi is busy with something else; records the entry id of the voice message | `📞 envoyé` |
| PI_WORKING | Pi's run started | listens (barge-in possible) | spoken pass on each assistant text block (see Two outputs) | `📞 Pi réfléchit` |
| PI_SPEAKING | first spoken sentence plays | plays sentences in order; tracks how far playback got | appends the spoken row when the answer is done | `📞 Pi parle` |
| BARGE_IN | speech (VAD) while PI_WORKING or PI_SPEAKING | ducks the TTS at once (-20 dB in 50 ms); checks: ≥ 300 ms of speech, not the echo of its own text, VoxTurn `intent` = interrupt rather than backchannel | — | `📞 …` |
| (dropped) | backchannel ("mm", "ok", "ouais"), echo, or < 300 ms | resumes the TTS where it was | — | back |
| USER_ADDING | barge-in confirmed | stops the TTS, reports `spoken {interrupted_at}`; listens to the addition as a normal turn (PAUSED and END_OF_TURN rules) | aborts Pi's run at once (`ctx.abort()`), so no more tokens are spent | `📞 « addition… »` |
| REWIND_APPEND | the addition's end of turn | — | see below | `📞 envoyé` |

**Rewind and append**, in the extension, as a hidden command so it gets a
command context even mid-run (Pi runs extension commands immediately, even
while streaming: `dist/core/agent-session.js:1656-1665`; the rewind extension
opens its picker the same way, `rewind/extension.ts:213`):

1. `await ctx.waitForIdle()` (the run was aborted at USER_ADDING).
2. `ctx.navigateTree(voiceEntryId)`: the leaf moves to the voice message's
   parent, so Pi's answer and the old message leave the active branch
   (they stay in the session tree, `/tree` shows them). Pi puts the old
   prompt in the editor; the extension puts back whatever draft was there.
3. `pi.sendUserMessage(old + " " + addition)`: one message, as if said in
   one go. It is the new voice entry for the next barge-in.

**When a rewind happens, and when it doesn't** (the person's rule, made
precise; Q3):

| Situation | What happens |
| --- | --- |
| Speech while Pi works or speaks its answer to the voice message, **no tool with side effects has run** since | rewind and append, as above |
| Same, but Pi already ran `edit`, `write`, or a `bash` that changed files (bash-changes knows) | no rewind: the run continues and the addition goes as a **steer** (`deliverAs: "steer"`), so Claude takes it into account without losing what it did |
| Speech after the answer was spoken to the end (+400 ms) | a new turn, sent normally |
| Speech during the earcon right after sending (< 1 s): he hadn't finished | rewind and append (the cut-off case) |
| The message was typed, not spoken | never rewound by voice; speech is a new turn or a steer |
| Several additions | each appends to the last voice message: "A B C" |

## Pi extension API points used

Pi 1.5.0 docs under
`/opt/homebrew/Cellar/pi-coding-agent/1.5.0/libexec/lib/node_modules/@earendil-works/pi-coding-agent/`.

| Need | API | Reference |
| --- | --- | --- |
| `/call`, `/call end` | `pi.registerCommand` | docs/extensions.md:1735 |
| A key to start and end the call | `pi.registerShortcut` | docs/extensions.md:1849 |
| Auto-send | `pi.sendUserMessage(text)` when idle, `{deliverAs: "steer"}` while busy | docs/extensions.md:1649; examples/extensions/send-user-message.ts:46-51; the person's hc-inbox/index.ts:16 |
| Telling voice messages from typed ones | `input` event, `event.source === "extension"` | docs/extensions.md:1110 |
| Rewind from an event, mid-run | a hidden command run through `pi.sendUserMessage("/voice-rewind", {expandPromptTemplates: true})`, which executes at once even while streaming | dist/core/agent-session.js:1656-1665; rewind/extension.ts:213 |
| Stop the run | `ctx.abort()`, then `ctx.waitForIdle()` | docs/extensions.md:1253, 1335; rewind/extension.ts:304-315 |
| Rewind the conversation | `ctx.navigateTree(entryId)` (command context only, rejects mid-run) | docs/extensions.md:1407; rewind/extension.ts:420 |
| Put the draft back | `ctx.ui.getEditorText()` / `setEditorText()` | docs/extensions.md:2871 ff. |
| Pi's run state and text, streamed | `agent_start`, `agent_settled`, `message_update` (`text_delta`), `tool_execution_end` | docs/extensions.md:663, 752, 788 |
| The spoken pass through Pi's own Haiku | `ctx.modelRegistry.streamSimple(model, context, options)` | docs/extensions.md:1220; bash-titles/index.ts:13, 57-66 (same provider and model) |
| The spoken row, outside the LLM context | `pi.appendEntry("voice-spoken", data)` + `pi.registerEntryRenderer` (gets `expanded`) | docs/extensions.md:1681, 1829; examples/extensions/entry-renderer.ts:20-35 |
| Click to open the row | `MouseRegion` around the row (fullscreen mode, Pi's default) | docs/tui.md:40, 56-62; docs/settings.md:97; tool-rows-faint/index.ts:41 passes clicks through |
| Keyboard path | Ctrl+O (`app.tools.expand`) sets `expanded` | docs/keybindings.md:164 |
| Footer status | `ctx.ui.setStatus("voice", text)`; the footer extension shows it on line 2 | docs/extensions.md:2875; footer/layout.ts:33-37, 130 (add "voice" to its order) |
| Mark a voice message in the chat, display only | `pi.registerMarkdownTransformer` (a 🎙 before the text; the model never sees it) | docs/extensions.md:1807 |
| Socket and child process cleanup | `session_shutdown` | docs/extensions.md:252, 601 |
| Another context-only alternative to rewind, not used | `context_edit` entries replace a message in the model's view | docs/session-format.md:139, 235 |

## The two outputs

**The written answer is untouched**: the extension adds nothing to the system
prompt, the messages or the tools, so the main model's output is exactly
today's. The spoken version is made beside it:

1. The extension follows the assistant's text through `message_update`
   (`text_delta`) and cuts it into **blocks**: a paragraph, or the text before
   a tool call ("Je regarde le footer.").
2. A **plain, short block** (under ~200 characters, no code, no path, no list,
   no table) is spoken as it is after light cleanup, with no added latency:
   that covers most of what Pi says between tool calls.
3. Anything else goes to **Claude Haiku 5.5** through Pi's own provider
   (`claude-code`, as `bash-titles` does), streamed, with the prompt drafted in
   [bench/voice_pass_bench.py](bench/voice_pass_bench.py) (spoken French or
   English like the answer, the gist, never code or paths or hashes, a
   question kept, four sentences at most) plus what was already said for this
   answer, so it continues instead of repeating. Measured: 1.0 s to first
   token, 1.3 s to the first sentence. Each finished sentence goes to the
   daemon (`speak`) and ZONOS3-Mini starts in 115 ms.
4. When the answer is done (or interrupted), `pi.appendEntry("voice-spoken",
   {text, interrupted_at, duration_ms, for: assistantEntryId})`. A custom
   entry never enters the model's context (docs/extensions.md:1681), so
   the next turns are not influenced by the spoken style either.

**Time from the end of his turn to Pi's voice** (median): end of turn 260 ms
+ Claude's first paragraph (seconds, model and task dependent) + Haiku's
first sentence 1.3 s (0 for a plain block) + TTS 115 ms. The earcon at SENT
says "heard" within ~300 ms; an instant spoken acknowledgement is Q5.

**The row**, drawn like compact-tools' groups:

```
⦁ Spoke 12s · « J'ai trouvé la cause : le footer lisait l'ancienne clé… »  (click to expand)
```

Opened (click, or Ctrl+O):

```
⦁ Spoke 12s
  J'ai trouvé la cause : le footer lisait l'ancienne clé de configuration,
  qui a changé avec le dernier commit. J'ai modifié le fichier qui lit les
  segments […] Tu veux que je fasse le commit ?
```

Interrupted: `⦁ Spoke 4s, interrupted · « J'ai trouvé la cause… »`, the
opened text marking where playback stopped. Faint like the tool rows. On a
rewind, the row stays on the abandoned branch with the answer it belongs to.

Other ways considered:

- **Ask the main model for both versions** (a spoken section in its reply):
  changes the written output and its style, which the brief rules out.
- **A local small LLM for the pass** (LFM2.5-1.2B, LFM3-1.7B): 0.1–0.5 s, but
  measured to drop the question or read the code. Kept as an offline
  fallback when Haiku errors (Q6).
- **Speak the written text through a cleanup filter only**: instant, free,
  but reads long answers whole; this is what step 2 does for short plain blocks.

## Echo cancellation and barge-in

Recommended: **macOS voice processing in the audio helper**, plus two
software checks, with headphones simply working too.

- The helper plays the TTS through the same `AVAudioEngine` whose input node
  has `setVoiceProcessingEnabled(true)`, attaching the playback graph
  *before* enabling it (otherwise the echo reference is empty, a known
  silent failure). This is the unit FaceTime uses, built in, nothing to
  install.
- It is output subtraction with a residual tail in quiet rooms, so the daemon
  also: (a) drops speech heard during playback whose transcript matches the
  text being spoken (Soniox v6's idea, at the text level), and (b) asks
  VoxTurn whether the speech is an interruption or a backchannel, with
  `speaker="agent"`. A barge-in needs ≥ 300 ms of speech passing both.
- Headphones need nothing more. AirPods' microphone switches them to the
  low-quality hands-free profile; the Mac's built-in mic with AirPods for
  output avoids that (the helper picks the input device: Q8).
- Runner-up: WebRTC AEC3 in the daemon (pip `webrtc-audio-processing`),
  tunable, if voice processing proves too weak on the person's speakers.

None of this can be measured without the microphone: it is the first human
check of phase 2.

## Permissions

- **Microphone**: one prompt, for Herdr ("Terminal programs running in Herdr
  can use the microphone"), the first time a call starts, if Herdr doesn't
  already have it (the TCC database isn't readable without Full Disk Access,
  so unknown). It survives Herdr updates (Developer ID) and every nix rebuild
  of the daemon or helper (they borrow Herdr's identity).
- The helper also embeds an Info.plist with `NSMicrophoneUsageDescription`
  (`-sectcreate __TEXT __info_plist`), so that started from another terminal
  it can still prompt, for that terminal.
- Nothing else: no Accessibility, no Screen Recording. The socket is a file
  in `~/.cache/pi-voice/`, mode 0600.

## Nix packaging

In this repo, under `modules/home/programs/pi/`:

- `extensions/voice/index.ts` (+ modules): added to the `extensions` set in
  `default.nix` like the others, with a one-line comment.
- `extensions/voice/daemon/`: a Python project (`pyproject.toml`, `uv.lock`)
  pinning `mlx`, `mlx-audio` (a commit, until VoxTurn's MLX port and
  ZONOS3's support are in a release), `silero-vad`, `onnxruntime`. No
  PyTorch once VoxTurn is ported to MLX.
- `pi-voice`: a `writeShellApplication` that runs
  `uv run --frozen --project ${./daemon} -m pi_voice` with
  `UV_PROJECT_ENVIRONMENT=~/.cache/pi-voice/venv` and `uv` from nixpkgs. The
  venv lives outside the store because MLX and its friends are wheels that
  nixpkgs lags behind; `uv.lock` keeps it reproducible. (uv2nix is the purer
  route, worth it once the dependency set settles.)
- `pi-voice-audio`: built from one Swift file with nixpkgs' Swift toolchain
  and Apple SDK, ad-hoc signed (fine: Herdr's identity counts).
- Models: downloaded into the shared `~/.cache/huggingface` on the first call
  (Parakeet v3 2.5 GB, ZONOS3-Mini 1.4 GB, VoxTurn and its Qwen3-ASR backbone
  ~2 GB until the MLX port, Smart Turn 8 MB, Silero 2 MB), or ahead of time
  with `pi-voice fetch`. Nothing in the store.
- Settings: `~/.pi/agent/voice.json` (voice, thresholds, key, vocabulary),
  merged from nix like `compact-tools.json` (`default.nix:145`, `:385`).
- No launchd agent, no brew, no macOS setting.

## Phase-2 test harness

**Automated, run by an agent alone** (`voice/tests/e2e/`):

- **A fake audio helper** that speaks the real helper's protocol: it plays a
  scripted timeline of WAV files into the daemon as if from the mic, in real
  time or on a virtual clock (fast), and writes what the daemon plays to a
  WAV instead of the speakers. Optional loopback: the TTS output mixed back
  into the "mic" at -10 dB with 30–80 ms of delay, to test the echo checks
  (not the macOS AEC itself).
- **Pi in RPC mode** (`pi --mode rpc --no-session -e ./voice`) with a
  **scripted provider** registered by a test extension (`pi.registerProvider`,
  docs/extensions.md:1958; examples/extensions/custom-provider-anthropic
  shows a custom `streamSimple`), so answers, tool calls and timings are
  deterministic and free. The spoken pass points at a scripted model too.
- **Clips**: generated with the TTS candidates and `say` like bench/clips.py,
  plus a few recordings of the person later (a fixture folder).
- Each scenario asserts on the RPC event stream, the session file and the
  output WAV:

| Scenario | Asserts |
| --- | --- |
| A French command with code words | one user message; WER ≤ 15 % against the script; sent ≤ 600 ms after the end of speech |
| "Alors, euh… [1.2 s] je voudrais…" | exactly one message, both halves in it; nothing sent in the pause |
| Several hesitations in one turn, a list ("trois fichiers : … … …") | one message |
| A short answer "Non." after a question | sent ≤ 600 ms after |
| Speech 1.5 s into Pi's spoken answer | TTS stops ≤ 300 ms after speech onset; the run is aborted; the active branch has one user message = old + " " + addition; Pi answers again; a `voice-spoken` entry marked interrupted on the old branch |
| Speech right after sending (≤ 1 s) | rewind and append, no answer spoken in between |
| "mm-hm" during the answer | TTS resumes; no abort; no new message |
| Loopback echo of the answer, no user speech | no barge-in, no message |
| Barge-in after a scripted `edit` tool call | no rewind; a steer message with the addition |
| Barge-in after the answer finished | a new message, no rewind |
| Typed message, then speech | no rewind |
| A second Pi runs `/call` | transfer prompt; after yes, chat A's footer says the call moved and A gets no more turns |
| Daemon killed mid-call | chat shows the error, the call ends, `/call` starts a new daemon |
| The voice row | renderer output contains "Spoke" and the first words; expanded output contains the whole spoken text |
| Memory | daemon footprint during a call ≤ 5.5 GB; ≤ 200 MB 10 min after |

**Only a human can check**: the real microphone (Herdr's prompt appears once,
then never again across rebuilds; quiet room and with noise); the speakers
without headphones (Pi doesn't interrupt itself, barge-in still works);
AirPods and the built-in mic; how the voice sounds and its French; whether
end-of-turn timing feels right in real speech (the synthetic clips can't
judge prosody); the overall delay feel; two Herdr panes in practice.

## Open questions

Each with options and my recommendation first.

**Q1. STT: speed or code words?**
- **Parakeet v3** (recommended): FR 18 % WER on the test clips, 65 ms, 1.6 GB;
  "worktree" may come out "World Trade" in the transcript (Claude usually
  understands, but it shows in the chat).
- Whisper large-v3-turbo with a vocabulary prompt: FR 9 %, 16/19 code words,
  +0.6 s per turn, 2.5 GB.
- Both: Parakeet for the live partial, Whisper for the final text (+2.5 GB).

**Q2. Which voice?** Listen to `/tmp/k12-samples/`. Options: ZONOS3-Mini's
preset French voice (recommended to start), a ZONOS3 voice cloned from 10 s
of a voice he likes, or Pocket TTS (faster, but English words sound French).

**Q3. When does speaking again rewind?** Recommended: the table in
[Rewind and append](#the-call-as-a-state-machine): rewind while Pi works or
speaks, unless a tool already changed files (then a steer); a new turn once
the answer has been spoken. Alternatives: always rewind, restoring files with
the rewind extension's machinery (risky mid-run); or never rewind once Pi has
started, only steer.

**Q4. How to start and end a call?** Recommended: `/call` toggles, plus a key
(`ctrl+alt+v`, free in Pi's defaults per keybindings.md; to confirm against
Herdr's), and the call ends by itself after 10 minutes with no speech. Mute
with the same key held, or `/call mute`.

**Q5. What confirms the message was sent?** Recommended: a short earcon
(no model, ~300 ms after the end of turn). Alternatives: a spoken "d'accord"
picked from a few local phrases; nothing.

**Q6. The spoken pass when Haiku is unavailable** (quota, offline):
recommended, speak only the plain blocks and say "la réponse est à l'écran";
alternative, LFM2.5-1.2B locally (fast, often loses the point).

**Q7. Voice outside Herdr** (another terminal, ssh)? Recommended: not in
phase 2 (that terminal would be asked for the microphone instead).
Alternative: a launchd `.app` signed with a self-signed certificate he makes
once in Keychain Access, which works from anywhere.

**Q8. Echo**: recommended, Mac speakers with voice processing and the
built-in mic as default input; alternative, require headphones at first and
add voice processing after.

**Q9. VoxTurn's licence is CC-BY-NC-4.0** (non-commercial). Fine for personal
use; if this ever ships to others, Smart Turn (BSD-2) is the fallback.

**Q10. The language**: recommended, auto-detected per turn (French and English
both work); forcing French made the measured models translate English.
