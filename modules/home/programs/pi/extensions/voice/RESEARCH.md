# Pi voice: research and measurements (phase 1)

What runs locally for voice calls with Pi, measured on the person's Mac, with
a recommendation per role. The design that uses these results is in
[DESIGN.md](DESIGN.md); the scripts behind every number are in [bench/](bench/).

## Recommendations

| Role | Recommended | Runner-up | Why |
| --- | --- | --- | --- |
| STT | **Whisper large-v3-turbo with a vocabulary prompt** (chosen in phase 2, see [Phase 2: the STT gaps](#phase-2-the-stt-gaps)) | Parakeet TDT 0.6B v3 | The only model at FR 9 % WER and 16/19 code words; 830 ms per utterance, started speculatively at the pause. Parakeet is the fastest (65 ms) and most accurate without a prompt (FR 18 %), but its phrase boosting (tried in phase 2) doesn't close the gap. |
| End of turn | **VoxTurn v1** (Oct 15, 2026) given the transcript so far, with Smart Turn v3.2 as a rescue for short answers | Smart Turn v3.2 alone at threshold 0.9 | 1 false cut-off in 18 hesitations (Smart Turn 6/18, 500 ms silence 11/18), 260 ms median delay after a real end. Best open model on eot-bench in French (13.4 % at a 300 ms budget, Smart Turn 39 %). Must be ported to MLX: through PyTorch it needs fp32 on the GPU, 5.7 GB. Licence CC-BY-NC-4.0: fine for personal use, not for anything sold. |
| TTS | **Zyphra ZONOS3-Mini** (Nov 9, 2026, MLX) | Kyutai Pocket TTS, French model (CPU) | One model for French and English (43 languages), streams, 115 ms to first audio, round-trip WER FR 6 % / EN 6 %, 1.4 GB, Apache-2.0. Pocket TTS is 27 ms and tiny but has one model per language and reads English words the French way. |
| Spoken version of the answer | **Claude Haiku 5.5 through Pi's own provider**, streamed | none local yet | The only one that follows the brief: speaks the gist, never code or paths, keeps the closing question. 1.0 s to first token, 1.3 s to the first sentence. Local 1–2B models answer in 0.1–0.5 s but drop the question or read the code. |
| Omni (STT + TTS in one) | not recommended now | LFM3-Audio-2B (MLX 4-bit) | One 1.9 GB model does both, but its ASR is behind Parakeet, mlx-audio can't stream its waveform, and it does no end-of-turn detection. Worth it only if RAM gets tight. |
| Echo cancellation | **macOS voice processing (VoiceProcessingIO)** in the audio helper + a text-level echo filter | headphones | Built in, what FaceTime uses; not measurable without the microphone, so a human check. |

Everything a call needs fits in about **4–5 GB** while a call is on (Parakeet
1.6 GB + ZONOS3 1.4 GB + VoxTurn ported to MLX about 1–1.6 GB + VAD), and
nothing when no call is on: the daemon unloads the models.

## Machine and method

- MacBook, **Apple M4 Pro, 24 GB**, macOS 27.0 (26A428), with the person's
  usual load running (browser, Herdr, two `llama-server`s; swap 5 GB in use).
  One model at a time, warmed up once before timing.
- Runtimes: `mlx` 0.32.4, `mlx-audio` 0.6.5 (git `3e2368e`), `mlx-whisper`
  0.4.3, `torch` 2.15.0 (MPS), `transformers` 5.22.2, `onnxruntime` 1.31.1,
  `silero-vad` 6.2.3, `p99turn` 1.2.3, `pocket-tts` 4.0.1, `llama-server`
  0.9.0 (cd959ba), Pi 1.5.0.
- **Clips**: rendered with macOS `say` (no microphone), [bench/clips.py](bench/clips.py).
  - STT: 5 French sentences (voices Thomas and Jacques) and 3 English
    (Samantha), with the person's words: pnpm, worktree, nix build,
    default.nix, commit, rebase, GitHub, launchd, Unix socket, WebSocket,
    TypeScript, daemon, footer, rewind.
  - Turns: 12 utterances, 9 French and 3 English, each a single `say`
    utterance with inline `[[slnc N]]` silences, so a hesitation keeps the
    sentence's prosody. 18 mid-turn pauses ("Alors, euh… je voudrais…",
    "Est-ce que tu peux… lancer…", lists) and 12 real ends, some very short
    ("Non.", "Fais un commit.").
- **Caveat on the clips**: the French `say` voices pronounce English words the
  French way, badly ("worktree" comes out close to "work tray", "nix" as
  "X"), so French WER on code words is pessimistic. A real speaker mixes the
  two better. The turn clips are synthetic too: these numbers rank models,
  eot-bench (real users, 14 languages) gives the absolute ones.
- Memory: `footprint` (physical footprint, what Activity Monitor shows) for
  the stack, otherwise MLX peak memory and process RSS above the pre-load
  baseline. RSS does not count GPU memory under PyTorch MPS, which is how
  VoxTurn's real cost was first missed (see the stack table).

## 1. STT

### Candidates

| Model | Date | Size | Languages | Streaming | Source |
| --- | --- | --- | --- | --- | --- |
| NVIDIA Parakeet TDT 0.6B v3 | 2025, MLX port | 0.6B | 25 European (auto) | offline (TDT) | [mlx-community/parakeet-tdt-0.6b-v3](https://huggingface.co/mlx-community/parakeet-tdt-0.6b-v3), [parakeet-mlx](https://github.com/senstella/parakeet-mlx) |
| NVIDIA Nemotron 3.5 ASR streaming 0.6B | 2026 | 0.6B | 40 locales | yes, cache-aware (80 ms steps, 0–1 s look-ahead) | [mlx-community/nemotron-3.5-asr-streaming-0.6b](https://huggingface.co/mlx-community/nemotron-3.5-asr-streaming-0.6b), [mlx-audio README](https://github.com/Blaizzy/mlx-audio/blob/main/mlx_audio/stt/models/nemotron_asr/README.md) |
| Qwen3-ASR 0.6B | Jan 2026 | 0.6B | multilingual, hotwords | offline | [Qwen/Qwen3-ASR-0.6B](https://huggingface.co/Qwen/Qwen3-ASR-0.6B) |
| Whisper large-v3-turbo | 2024 | 0.8B | 99, prompt | offline (30 s windows) | [mlx-community/whisper-large-v3-turbo](https://huggingface.co/mlx-community/whisper-large-v3-turbo) |
| Mistral Voxtral Mini 4B Realtime | Feb 2026 | 4B | multilingual | yes | [mistralai/Voxtral-Mini-4B-Realtime-2602](https://huggingface.co/mistralai/Voxtral-Mini-4B-Realtime-2602) |
| Edge0 Audio8-ASR-0.1B | May 2026 | 0.1B LM + 0.2B encoder | 7, French included | offline | [Edge0/Audio8-ASR-0.1B](https://huggingface.co/Edge0/Audio8-ASR-0.1B), **CC-BY-NC** |
| Edge0 ARK-ASR-0.6B (Audio8 ASR 0.6B) | 2026 | 0.6B | 19 | offline | [Edge0/ark-asr-0.6b-int8-onnx](https://huggingface.co/Edge0/ark-asr-0.6b-int8-onnx) |
| Edge0 Audio8 ASR Infinite (the person's reference) | Sep 23, 2026 | 3B decoder + Voxtral 4B audio tower, 8.2 GB bf16 | **Chinese and English only** | yes, with semantic VAD heads | [Edge0/Audio8-ASR-Infinite](https://huggingface.co/Edge0/Audio8-ASR-Infinite), [tweet](https://x.com/SamuelZengML/status/2102726739449332221) |
| Soniox STT v6 | Nov 3, 2026 | cloud | 60+ | yes, with agent echo cancellation | [changelog](https://docs.soniox.com/stt/models), [blog](https://soniox.com/blog/soniox-stt-v6), [tweet](https://x.com/soniox_ai/status/2118375665653227667) |

Not measured: **Audio8 ASR Infinite** (no French, 8 GB, needs a vLLM build);
**Soniox** (cloud only, no local model: its v6 "agent voice echo
cancellation", where the agent's text goes into the STT so it filters the
agent's own voice, is an idea the design copies at the text level);
**WhisperKit** and other Core ML builds (same Whisper accuracy; could cut
Whisper's 830 ms, a phase-2 option if Whisper is chosen).

### Results

8 clips, auto language unless stated. "Code words" counts the terms above
that came out right (19 in the clips). Decode is the whole utterance after
warm-up, which is the delay between the end of turn and the final transcript.

| Model (runtime, precision) | FR WER | EN WER | Code words | Decode / utterance | RTF | Memory |
| --- | --- | --- | --- | --- | --- | --- |
| **Parakeet TDT v3** (mlx-audio, f32) | **18 %** | 6 % | 8/19 | **65 ms** | **0.017** | MLX peak 2.7 GB; **1.6 GB footprint in bf16**, same transcripts |
| Parakeet TDT v3, cast to bf16 | same | same | same | n/m | n/m | 1.59 GB footprint |
| Nemotron 3.5 streaming (mlx-audio, 8-bit) | 25 % | 6 % | 10/19 | 135 ms | 0.035 | MLX peak 1.0 GB |
| Qwen3-ASR 0.6B (mlx-audio, 8-bit) | 38 % | 9 % | 7/19 | 140 ms | 0.035 | MLX peak 1.8 GB |
| Qwen3-ASR 0.6B + hotwords | 29 % | 3 % | 14/19 | 137 ms | 0.034 | 1.8 GB |
| Qwen3-ASR 0.6B + hotwords, language forced French | 22 % | **26 %** (translated English into French) | 13/19 | 129 ms | 0.031 | 1.8 GB |
| Whisper large-v3-turbo (mlx-whisper, f16) | 20 % | 3 % | 10/19 | 835 ms | 0.21 | MLX peak 2.5 GB |
| **Whisper large-v3-turbo + vocabulary prompt** | **9 %** | **0 %** | **16/19** | 828 ms | 0.21 | 2.5 GB |
| Voxtral Mini 4B Realtime (mlx-audio, 4-bit) | 20 % | 0 % | 12/19 | 2355 ms | 0.56 | MLX peak 5.3 GB |
| Audio8-ASR-0.1B (Edge0 ONNX, int8, CPU) | 37 % | 9 % | 8/19 | 357 ms | 0.089 | RSS 1.5 GB |
| Audio8-ASR-0.1B + hotwords | 215 % (loops "p n p n…") | 11 % | 11/19 | 371 ms | 0.11 | 1.5 GB |
| ARK-ASR-0.6B (Edge0 ONNX, int8, CPU) | 25 % | 6 % | 9/19 | 509 ms | 0.13 | RSS 2.7 GB |

Streaming (mlx-audio `create_streaming_session`, 80 ms chunks fed in order):

| Model | Compute per 80 ms step (median / p95) | First text after speech starts | Flush at end |
| --- | --- | --- | --- |
| Nemotron 3.5 (8-bit) | 0.2 / 31 ms | 1.2 s | 23 ms |
| Voxtral Mini 4B Realtime (4-bit) | 244 / 899 ms (slower than real time) | 1.0 s | 9.8 s |

Typical errors, to show what the WER hides (French clip fr1, "Tu peux lancer
pnpm install dans le worktree, puis faire un nix build ?"):

- Parakeet: "…pnpm install dans le World Trade, puis faire un X build."
- Nemotron: "…P N P M installe dans le Work Tray puis faire un X-Bild."
- Whisper + prompt: "…pnpm install dans le worktree, puis faire un xbuild."
- Qwen3-ASR (clip fr5, voice Jacques): answered in Russian, with and without hotwords.

### Reading

- **Streaming STT is not needed for the turn itself.** Decoding the whole
  utterance at the end of the turn costs 65 ms with Parakeet, and decoding can
  start speculatively when the pause starts, in parallel with the end-of-turn
  check (≈260 ms). Live partials for the footer come from re-decoding the
  growing buffer every 0.5 s (65 ms each). Nemotron's real streaming gives its
  first text 1.2 s after speech starts, later than that.
- **Vocabulary biasing matters more than the model** for this person's speech:
  Whisper goes from 10 to 16 code words right with a one-line prompt, Qwen3-ASR
  from 7 to 14 with hotwords. Parakeet has no biasing in its MLX port.
- **Forcing French is wrong**: Qwen3-ASR then translates English sentences.
  Keep auto-detection; Parakeet's never failed on these clips, Qwen3-ASR's
  did (Russian).
- Claude reads the transcript, and usually understands "World Trade" in a
  sentence about a worktree, but the transcript is also what shows in the
  chat, so the person will see the errors. That is the trade-off for open
  question Q1 in DESIGN.md: Parakeet (fast) or Whisper + prompt (right words,
  +0.6 s per turn).

## 2. End-of-turn detection

### Candidates, with what's new in October and November 2026

| Model | Released | Kind | Open | French | Size / speed | Source |
| --- | --- | --- | --- | --- | --- | --- |
| Silero VAD + silence timeout | — | acoustic | MIT | n/a | <1 ms / 32 ms frame | [snakers4/silero-vad](https://github.com/snakers4/silero-vad) |
| Smart Turn v3.2 (Pipecat) | Jan 2026 | audio classifier on the turn | BSD-2 | yes (23 languages) | 8 MB int8, 8 ms here | [pipecat-ai/smart-turn](https://github.com/pipecat-ai/smart-turn), [HF](https://huggingface.co/pipecat-ai/smart-turn-v3); in the person's reference [Decoded08's stack](https://x.com/Decoded08/status/2119316511605055622) |
| LiveKit Turn Detector v1 / v1-mini | Jun 2026 | audio + semantic | v1 hosted only; v1-mini open (LiveKit licence) | yes | — | [blog](https://livekit.com/blog/solving-end-of-turn-detection), [eot-bench](https://github.com/livekit/eot-bench) |
| **Cue v1** (Pype) | **Oct 13, 2026** | Gemma 4 E4B logits × √Smart Turn | open weights | 14 languages, English prompt | 8B, too big here | [Pype/cue-v1](https://huggingface.co/Pype/cue-v1) |
| **SPEV** (Sprag) | **Oct 14, 2026** | omnimodal decision model | open weights | ? | **30B**, too big | [SpragAI/SPEV](https://huggingface.co/SpragAI/SPEV) |
| **VoxTurn v1** | **Oct 15, 2026** | speech LLM (Qwen3-ASR-0.6B + LoRA), several questions in one pass | open weights, **CC-BY-NC-4.0** (personal use fine) | yes, 13.4 % on eot-bench | 0.8B, 8 ms on a GPU | [AustinXiao/voxturn](https://huggingface.co/AustinXiao/voxturn), [arXiv 2610.21150](https://arxiv.org/abs/2610.21150) |
| **Tyger** | **Oct 16, 2026** | Nemotron 3.5 ASR + 14M GRU, answer / stop / chime-in, hears its own playback | Apache-2.0 | **English only** | 0.6B | [nineninesix/tyger](https://huggingface.co/nineninesix/tyger), [Reddit](https://www.reddit.com/r/LocalLLaMA/comments/1x7msmj/) |
| **turn-1 / turn-1-mini** (p99lab) | Oct 2026 | streaming audio | Apache-2.0 | **English only** | 5.3M, 1.3 ms / 160 ms | [p99lab/turn-1-mini](https://huggingface.co/p99lab/turn-1-mini) |
| **LFM3 d1-Omni-2B** (Liquid) | **Oct 27, 2026** | decision model on audio | LFM licence | 43-language ID | 2B | [LFM3 blog](https://www.liquid.ai/blog/lfm3); not benchmarked for end of turn by anyone yet |
| Indic turn detector | Nov 7, 2026 | text | Apache-2.0 | no | 0.5B | [tarun7r/indic-turn-detector](https://huggingface.co/tarun7r/indic-turn-detector) |
| Audio8 ASR Infinite semantic VAD | Sep 2026 | heads on the ASR | Apache-2.0 | no | 8 GB | above |
| Soniox v6 / AssemblyAI / Deepgram Flux | 2026 | cloud | — | — | — | not local |

eot-bench (LiveKit's open benchmark, real user turns in 14 languages; false
cut-offs at a 300 ms latency budget, lower is better), from the
[leaderboard](https://livekit.com/benchmarks/eot-bench) and the VoxTurn paper:

| Model | English | French | 14-language mean | Open |
| --- | --- | --- | --- | --- |
| LiveKit v1 | 9.9 % | 13 % | 14.0 % | no |
| turn-1 (2.8B) | 10.6 % | — | — | yes |
| **VoxTurn v1** | 11.5 % | **13.4 %** | **19.9 %** | yes |
| Deepgram Flux | 12.9 % | 13 % | — | no |
| turn-1-mini | 22.6 % | — | — | yes |
| LiveKit v1-mini | 27.8 % | 22 % | 28.4 % | yes |
| Smart Turn v3.2 | 35.2 % | 39 % | 39.7 % | yes |
| Silence only (VAD) | 55.6 % | 57 % | — | — |

### Measured here

Same policy for all, the one Pipecat and VoxTurn use: Silero VAD marks a
pause after 200 ms of silence, the detector is asked then and every 250 ms
while it lasts, the turn ends when P(end) ≥ threshold or after the fallback
timeout. A detector only hears audio up to the moment it is asked.
[bench/eot_bench.py](bench/eot_bench.py), fusions in [bench/eot_fuse.py](bench/eot_fuse.py).

| Detector | Threshold | False cut-offs (pauses) | Clips cut | Delay after a real end, median | Ends that waited for the timeout | Cost per call |
| --- | --- | --- | --- | --- | --- | --- |
| Silence 300 ms | — | 11/18 | 8/12 | 352 ms | — | — |
| Silence 500 ms | — | 11/18 | 8/12 | 552 ms | — | — |
| Silence 800 ms | — | 8/18 | 7/12 | 852 ms | — | — |
| Silence 1200 ms | — | 2/18 | 2/12 | 1252 ms | — | — |
| Smart Turn v3.2 | 0.5 | 6/18 | 5/12 | 282 ms | 0 (max 2.0 s) | 8 ms, CPU |
| Smart Turn v3.2 | 0.9 | 3/18 | 3/12 | 1006 ms | 3 | 8 ms |
| turn-1-mini (English model) | 0.5 | 4/18 | 3/12 | 1121 ms | 3 | ~1 ms |
| VoxTurn v1, audio only | 0.5 | 1/18 | 1/12 | 294 ms | 4 | 91 ms, MPS fp32 |
| **VoxTurn v1 + transcript so far** | 0.5 | **1/18** | 1/12 | **268 ms** | 2 | 90 ms |
| **VoxTurn + transcript, or Smart Turn ≥ 0.9 with VoxTurn ≥ 0.1** | — | **1/18** | 1/12 | **260 ms** | **1** | 98 ms |

With a 1.5 s fallback instead of 3 s, the best rule keeps 1/18 false
cut-offs and its worst real end waits 1.5 s.

- VoxTurn holds through every "euh" and mid-sentence pause; its weak spot is
  short or flat French ends ("Non.", "Merci, c'est parfait."), where
  Smart Turn is strong, hence the fusion. The one false cut-off left is "Il
  faut modifier trois fichiers :" before a list.
- Silence alone can't do it: any timeout short enough to feel quick cuts
  most hesitations.
- **VoxTurn's cost through PyTorch**: fp32 on MPS adds **5.7 GB** of physical
  footprint (RSS showed 1.6 GB); fp16 and bf16 crash in Metal Performance
  Shaders ("Destination NDArray and Accumulator NDArray cannot have different
  datatype"). On CPU it is ~1 s per decision per its card. Phase 2 should
  port it to MLX: its backbone is Qwen3-ASR-0.6B, which mlx-audio already
  runs in 8-bit (1.8 GB peak with activations), plus a merged LoRA and one
  linear head. Until then, Smart Turn v3.2 at 0.9 is the fallback (8 MB).
- The person's wish that a new model "says when the user has finished" is
  met by VoxTurn: it is the first open model near the hosted ones in French.

## 3. TTS

### Candidates

| Model | Date | Size | French | Streaming | Source |
| --- | --- | --- | --- | --- | --- |
| **Zyphra ZONOS3-Mini** | **Nov 9, 2026** (the person's reference) | 800M MoE, 100M active | yes (43 languages, voices Gaspard…) | yes | [Zyphra/ZONOS3-Mini](https://huggingface.co/Zyphra/ZONOS3-Mini), [tweet](https://x.com/victormustar/status/2120069632602382827) |
| Kyutai Pocket TTS, French model | May 2026 (6 languages) | 100M (219 MB), 24-layer variant 672 MB | yes, one model per language | yes, CPU | [kyutai/pocket-tts](https://huggingface.co/kyutai/pocket-tts), [blog](https://kyutai.org/blog/) |
| Kokoro 82M | 2025 | 82M | one French voice (ff_siwis) | per sentence | [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M); in Decoded08's stack |
| Qwen3-TTS 0.6B CustomVoice | 2026 | 0.6B | yes | yes | [mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit](https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit) |
| Mistral Voxtral 4B TTS | Mar 2026 | 4B | yes | yes | [mlx-community/Voxtral-4B-TTS-2603-mlx-4bit](https://huggingface.co/mlx-community/Voxtral-4B-TTS-2603-mlx-4bit) |
| Edge0 Audio8-TTS-Realistic 0.6B | Oct 14, 2026 | 0.6B | yes (23) | no | [nativ-community/Audio8-TTS-Realistic-0.6b-4bit](https://huggingface.co/nativ-community/Audio8-TTS-Realistic-0.6b-4bit) |
| Fish Audio **Drama 3** | Oct 13, 2026 (the person's reference) | **24 GB even in int4** | yes | yes | [fishaudio/drama-3-int4](https://huggingface.co/fishaudio/drama-3-int4), [Niklas's comparison](https://x.com/niklaslenz_ai/status/2110325646673039694): doesn't fit in 24 GB |
| Breeze TTS 2 / Fish S2 Pro | Oct 2026 | 3.5B / 4.6B | ? | ? | same thread; too heavy next to the rest |
| Kyutai TTS 1.6B en/fr | Jul 2025 | 1.6B | yes | text and audio | [kyutai/tts-1.6b-en_fr](https://huggingface.co/kyutai/tts-1.6b-en_fr); superseded by Pocket TTS for local use |
| Chatterbox, Orpheus, CSM, F5 | 2025 | 0.5–3B | partly | partly | older generation, not measured |

### Results

4 sentences: 3 French (one with "default point nix", "pnpm test",
"worktree"), 1 English. Time to first audio is from the call to the first
chunk; a non-streaming model yields the whole sentence, and the daemon feeds
TTS one sentence at a time. Round-trip WER: the sample transcribed by
Parakeet v3, an intelligibility proxy only ([bench/tts_roundtrip.py](bench/tts_roundtrip.py)).

| Model (runtime) | First audio, median | RTF | Streams | Memory | Round-trip WER FR / EN |
| --- | --- | --- | --- | --- | --- |
| **ZONOS3-Mini** (mlx-audio, voice gaspard / wyatt) | **115 ms** | 0.14 | yes | MLX peak 1.6 GB; **1.4 GB** footprint in the stack | **6 % / 6 %** |
| Pocket TTS French (pocket-tts, CPU, voice estelle) | **27 ms** | 0.08 | yes | RSS 1.4 GB (PyTorch; the model is 219 MB) | 11 % / **50 %** (English with the French model) |
| Pocket TTS French 24-layer | 81 ms | 0.21 | yes | RSS 3.0 GB | 9 % / 50 % |
| Qwen3-TTS 0.6B (8-bit, voice Ryan) | 131 ms | 0.24 | yes | MLX peak 2.7 GB | 9 % / 6 % |
| Voxtral 4B TTS (4-bit) | 278 ms | 0.35 | yes | MLX peak 3.4 GB | **4 % / 0 %** |
| Kokoro 82M (ff_siwis / af_heart) | 220 ms | 0.19 | no (per sentence) | MLX peak 2.3 GB | 15 % / 6 % |
| Audio8-TTS-Realistic 0.6B (4-bit) | 3.5 s | 0.43 | no | MLX peak **7.3 GB** | 6 % / 0 % |
| LFM3-Audio-2B, TTS task (4-bit) | ~40 ms to the first speech frame, 885 ms per sentence | 0.14 | not in mlx-audio | 1.9 GB (with its ASR) | 13 % / 6 % |

How they sound is for the person: samples in `/tmp/k12-samples/` (see its
README.txt). ZONOS3's samples use its preset French voice; it also clones a
voice from 5–10 s of audio, so the person could pick any voice.

## 4. Speech-to-speech and omni models

- **LFM3-Audio-2B** ([Ollama](https://ollama.com/library/lfm3-audio),
  [HF](https://huggingface.co/LiquidAI/LFM3-Audio-2B-GGUF), Oct 27, 2026) and
  **LFM3-Omni-2B** ([docs](https://docs.liquid.ai/lfm/models/lfm3-omni-2b),
  [MindStudio](https://www.mindstudio.ai/blog/liquid-ai-lfm3-family-release)):
  one model for ASR, TTS and voice chat; French speech in and out; Ollama
  isn't installed here, so measured through mlx-audio (4-bit,
  [bench/lfm3_bench.py](bench/lfm3_bench.py)):
  - ASR: FR 26 % / EN 3 % WER, 9/19 code words, 185 ms per utterance;
  - TTS: first speech frame ~40 ms, 885 ms per sentence, round trip 13 % / 6 %;
  - 1.9 GB MLX peak for both.
- A Liquid employee on the launch thread: "the Audio model is a stronger
  ASR/TTS model than the Omni" ([HN](https://news.ycombinator.com/item?id=50262229));
  the Omni adds vision, which a voice layer doesn't need. The same thread
  notes llama.cpp now serves LFM3-Audio behind an OpenAI-realtime-style
  WebSocket, another runtime for it.
- **What it can't do here**: Claude stays the brain, so the omni model's
  dialogue skill is unused, and what's left is a weaker STT (than Parakeet), a
  TTS on par with ZONOS3, no end-of-turn detection (its sibling d1-Omni-2B
  could be asked, unbenchmarked), and in mlx-audio no waveform streaming in
  or out ("LiveASR, streaming waveform input/output … are not supported").
  Interleaved voice chat is English only.
- **Verdict**: separate models are better now (STT accuracy, a real turn
  detector, streaming TTS). LFM3-Audio is the fallback if memory gets tight:
  it saves about 1 GB against Parakeet + ZONOS3.
- Full-duplex models (Moshi, Kyutai's post-trained duplex models, Block's
  Dessa, Tyger's s2s stack) would replace Claude as the speaker, which the
  brief excludes; Tyger's own stack needs 28 GB of VRAM.

## 5. Echo cancellation and barge-in

Not measurable without the speakers and microphone; from the sources:

- **macOS voice processing** (`AVAudioEngine.inputNode.setVoiceProcessingEnabled(true)`,
  the VoiceProcessingIO unit that FaceTime uses) subtracts the output from the
  input. Field reports
  ([barock.dev](https://barock.dev/2026/04/22/why-your-ios-voice-agent-still-hears-itself),
  [recall.ai](https://www.recall.ai/blog/acoustic-echo-cancellation),
  [WWDC23](https://developer.apple.com/videos/play/wwdc2023/10235/)):
  the playback must go through the same engine and be attached **before**
  voice processing is enabled, or the reference is empty; a residual tail
  remains in quiet rooms, ~800 ms. A plain Swift executable with an
  embedded Info.plist is enough ([citelao/mac-native-echo-cancellation](https://github.com/citelao/mac-native-echo-cancellation)).
- Soniox v6's idea, local: the daemon knows the text it is speaking, so a
  transcript heard during playback that matches it is the echo, not the user.
- VoxTurn also answers "is this an interruption or a backchannel"
  (`intent`, with `speaker="agent"`), so "mm-hm" while Pi talks doesn't stop it.

## 6. The spoken version of the answer

Same written answer (French, a code block, two paths, a commit hash, a
question at the end), prompt in [bench/voice_pass_bench.py](bench/voice_pass_bench.py), 3 runs each:

| Backend | First token | First sentence (TTS can start) | Whole | Follows the brief |
| --- | --- | --- | --- | --- |
| **Claude Haiku 5.5** (`claude-code` provider, through `pi --mode json`) | 1029 ms | 1282 ms | 2.1 s | yes, 3/3; reads the hash "9af1b0f" in 2/3 |
| LFM2.5-1.2B Q8 (llama-server, local, 1.4 GB) | 9 ms | 94 ms | 0.4 s | partly: drops the question once, garbles it once, says "footerSegments" once |
| LFM3-1.7B Q4_K_M (llama-server, local) | 183 ms | 475 ms | 1.1 s | no: copies the written answer, paths and code included |

Haiku's output, run 2: "J'ai trouvé la cause : le footer lisait l'ancienne
clé de configuration, qui a changé avec le dernier commit. J'ai modifié le
fichier qui lit les segments, en gardant l'ancienne clé en repli, et ajouté
deux tests. Les quatorze tests passent, mais il faudra lancer un rebuild pour
voir le footer dans Pi. Tu veux que je fasse le commit ?"

Cost: a few hundred input tokens per answer on the person's Claude plan
(the same provider `bash-titles` and `input-autocomplete` already use for
Haiku), nothing on the main model, whose prompt is not touched.

## 7. Memory of the whole stack

One process, models loaded and warmed in order ([bench/stack_memory.py](bench/stack_memory.py)), `footprint`:

| Step | Physical footprint |
| --- | --- |
| Python | 20 MB |
| + Parakeet v3, f32 | 2.9 GB |
| + ZONOS3-Mini | 4.4 GB |
| + Silero VAD | 4.1 GB |
| + VoxTurn on MPS, fp32 (PyTorch) | **9.8 GB** |
| Parakeet v3 cast to bf16 alone | 1.6 GB |

Target for phase 2: Parakeet bf16 1.6 + ZONOS3 1.4 + VoxTurn in MLX (~1–1.6)
+ VAD and Smart Turn (<0.1) ≈ **4–5 GB during a call**, released after it.

## 8. Not measured, and why

- Microphone, speakers, echo cancellation: off limits for this phase.
- LiveKit v1-mini: its plugin needs the LiveKit Agents runtime; eot-bench
  numbers above instead.
- Cue v1, SPEV: 8B and 30B, too big next to the rest.
- Kyutai TTS 1.6B, Chatterbox, Orpheus, CSM, F5: older; Pocket TTS and
  ZONOS3 supersede them for this machine.
- Breeze TTS 2, Fish S2 Pro, Drama 3: 3.5–24 GB.

## Phase 2: the STT gaps

The person asked whether the recent STT models had all been looked at and
whether Parakeet can boost phrases; the rule: keep a model only if it matches
Whisper + prompt (FR WER ≤ 9 %, ≥ 16/19 code words) in under 300 ms per
utterance. Same clips and bench, Nov 10, 2026.

| Model | FR WER | EN WER | Code words | Per utterance | Memory | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Whisper large-v3-turbo + prompt (reference) | **9 %** | **0 %** | **16/19** | 828 ms | 2.5 GB | |
| Parakeet TDT v3 + phrase boosting, score 3 | 18 % | 0 % | 11/19 | 64 ms | 2.7 GB | a boosting tree in the greedy TDT decoder ([bench/parakeet_boost.py](bench/parakeet_boost.py)) |
| Parakeet TDT v3 + phrase boosting, score 5 | 22 % | 0 % | 11/19 | 59 ms | 2.7 GB | stronger boost starts inventing ("WoW work trait") |
| NVIDIA Canary 1B v2 (mlx-audio, 8-bit, [Mediform/canary-1b-v2-mlx-q8](https://huggingface.co/Mediform/canary-1b-v2-mlx-q8)) | 23 % | 6 % | 9/19 | 94 ms | 1.4 GB | needs the language given (it was, per clip): no auto-detection |
| Kyutai STT 1B en/fr ([kyutai/stt-1b-en_fr-mlx](https://huggingface.co/kyutai/stt-1b-en_fr-mlx), moshi_mlx 0.2.12) | 23 % | 9 % | 9/19 | streaming: 17 ms per 80 ms step, text 0.5 s behind the audio | 2.5 GB | fr5 (voice Jacques) garbled |

- **Parakeet boosting**: greedy boosting can only pick a phrase token when the
  acoustic model already gives it some weight; "worktree" said the French way
  comes out "World Trade", whose first piece is not "work". NeMo's GPU-PB
  boosting tree works the same way inside beam search, which would help a
  little more but runs only through NeMo's PyTorch stack (CUDA-oriented);
  not worth its install here given how far greedy boosting is from the bar.
- **Canary-Qwen 2.5B**: English only, not a candidate.
- **Result**: nothing matches Whisper + prompt on French and code words, so
  phase 2 uses **Whisper large-v3-turbo with the vocabulary prompt**. Its
  830 ms are hidden in part by starting the decode when the pause begins,
  in parallel with the end-of-turn check.

## Phase 2: the call stack as built

The person chose Whisper large-v3-turbo + prompt (STT) and Voxtral 4B TTS (the
voice he found nicest). VoxTurn runs in MLX (`daemon/pi_voice/voxturn_mlx.py`),
its language model in 8 bits, matching VoxTurn's PyTorch code within 0.043 on
P(end of turn) (`daemon/tests/test_voxturn_parity.py`). Measured in one process,
as the daemon loads them (`daemon/tests/stack_memory.py`, `footprint`), M4 Pro:

| Step | Physical footprint | Per call |
| --- | --- | --- |
| Silero VAD (ONNX) | 59 MB | <1 ms per 32 ms frame |
| + VoxTurn (MLX, LM 8-bit) + Smart Turn (ONNX) | 2.5 GB | 119 ms per end-of-turn check |
| + Whisper large-v3-turbo | 5.0 GB | 931 ms per utterance |
| + Voxtral 4B TTS (4-bit) | 6.1 GB | 362 ms to first audio, 2.7 s for a 12 s sentence |
| after a turn, warm | 6.2 GB (MLX peak 6.0 GB) | |

About 6 GB while a call is on, nothing 10 minutes after it ends (the daemon
unloads the models). With the person's usual load the Mac kept 58 % of its
memory free during the measurement. VoxTurn's language model in bf16 instead
of 8 bits costs 0.5 GB more for the same decisions.

End to end (`tests/e2e/run.py`, fake audio, real Pi on Haiku): a message is
sent 1.2–1.4 s after the end of speech (VoxTurn's end of turn, then Whisper's
0.9 s; the decode starts at the pause, so part of it overlaps).
