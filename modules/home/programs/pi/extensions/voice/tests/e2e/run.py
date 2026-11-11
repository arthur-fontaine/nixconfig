"""End-to-end check of Pi voice: WAV files instead of the mic, a real Pi in RPC mode.

    cd voice/daemon && uv run python ../tests/e2e/run.py [--keep] [case ...]

What runs:
- the daemon (`python -m pi_voice serve`) with the fake audio helper
  (`pi_voice.fake_audio`) instead of the Swift one: the helper streams silence
  as the mic, plays a WAV into it when the harness says so (its control
  socket), and records what the daemon plays;
- for each case, a fresh `pi --mode rpc --no-session` on Haiku, with the voice
  extension and tests/e2e/capture.ts (which records every request to the main
  model), started with `/call` through RPC;
- a control run without the voice extension, for the system prompt and tools.

Cases (each prints PASS/FAIL lines; the exit code is the number of failures):
- auto_send: the transcript, sent on its own after a real end of turn;
- hesitation: "euh" and a 1.2 s pause inside one turn: no send until the end;
- rewind: new speech right after sending, before Pi speaks: the answer is
  dropped, the message resent with the addition;
- steer: new speech while Pi speaks: no rewind, the words go to Pi as a
  second message (a steer when Pi is still running);
- for all: the voice row ("voice-spoken" custom entry) is in the session and
  never in a request to the model; the system prompt and tools equal the
  control run's; no message of the extension reaches the model; the
  assistant's written text equals what the provider streamed.

Cost: a handful of short Haiku turns.
"""

import asyncio
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
VOICE = HERE.parent.parent
EXTENSION = VOICE / "index.ts"
CAPTURE = HERE / "capture.ts"
MODEL = "claude-code/claude-haiku-5-5"
VOICE_NAME = "Thomas"

CLIPS = {
    "bonjour": "Réponds seulement par le mot bonjour.",
    "hesitation": "Réponds seulement, euh [[slnc 1200]] par le mot merci.",
    "oui": "Réponds seulement par le mot oui.",
    "plutot": "Non, plutôt par le mot non.",
    "compte": "Compte lentement de un à dix, en toutes lettres, avec une phrase par nombre.",
    "cinq": "Arrête-toi à cinq.",
}

results: list[tuple[str, bool, str]] = []


def check(case: str, ok: bool, what: str) -> bool:
    results.append((case, bool(ok), what))
    print(f"  {'PASS' if ok else 'FAIL'}  {case}: {what}", flush=True)
    return bool(ok)


def norm(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[^\w' ]+", " ", text.lower().replace("’", "'"))).strip()


def make_clips(out: Path) -> dict[str, Path]:
    paths = {}
    for name, text in CLIPS.items():
        aiff, wav = out / f"{name}.aiff", out / f"{name}.wav"
        subprocess.run(["say", "-v", VOICE_NAME, "-o", str(aiff), text], check=True)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(aiff), "-ac", "1", "-ar", "16000", str(wav)], check=True)
        aiff.unlink()
        paths[name] = wav
    return paths


class Lines:
    """NDJSON records from a stream, each stamped with time.time() on arrival."""

    def __init__(self, reader: asyncio.StreamReader, label: str):
        self.records: list[tuple[float, dict]] = []
        self.label = label
        self._task = asyncio.create_task(self._read(reader))
        self._changed = asyncio.Event()

    async def _read(self, reader):
        while line := await reader.readline():
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue
            self.records.append((time.time(), record))
            self._changed.set()

    async def wait(self, pred, timeout: float, after: float = 0.0):
        """The first record after `after` matching pred, or None after timeout seconds."""
        end = time.time() + timeout
        while True:
            for t, r in self.records:
                if t >= after and pred(r):
                    return t, r
            left = end - time.time()
            if left <= 0:
                return None
            self._changed.clear()
            try:
                await asyncio.wait_for(self._changed.wait(), left)
            except asyncio.TimeoutError:
                return None


class Helper:
    """The fake audio helper's control socket: play a WAV into the mic, hear back what it saw."""

    def __init__(self, path: Path):
        self.path = path

    async def open(self):
        for _ in range(600):
            try:
                self.reader, self.writer = await asyncio.open_unix_connection(str(self.path))
                self.events = Lines(self.reader, "helper")
                return
            except (FileNotFoundError, ConnectionRefusedError):
                await asyncio.sleep(0.1)
        raise RuntimeError(f"fake audio helper never opened {self.path}")

    async def send(self, cmd: dict):
        self.writer.write((json.dumps(cmd) + "\n").encode())
        await self.writer.drain()

    async def play(self, wav: Path) -> float:
        """Plays the clip into the mic; returns when the helper finished it (time.time() of its end)."""
        sent = time.time()
        await self.send({"cmd": "play", "path": str(wav)})
        got = await self.events.wait(lambda r: r.get("event") == "played" and r.get("path") == str(wav), 60, sent)
        if not got:
            raise RuntimeError(f"the helper never played {wav}")
        return got[1]["end"]


class Pi:
    def __init__(self, capture_dir: Path, socket: Path, with_voice: bool = True):
        self.capture_dir, self.socket, self.with_voice = capture_dir, socket, with_voice
        self.cwd = capture_dir.parent / "cwd"  # one folder for every run: the prompt names it
        self.cwd.mkdir(exist_ok=True)

    async def start(self):
        # --no-mcp: the MCP servers' descriptions change between runs, which would hide what matters here.
        args = ["pi", "--mode", "rpc", "--no-session", "--no-mcp", "--model", MODEL, "--thinking", "off"]
        if self.with_voice:
            args += ["-e", str(EXTENSION)]
        args += ["-e", str(CAPTURE)]
        env = {**os.environ, "VOICE_CAPTURE": str(self.capture_dir), "PI_VOICE_SOCKET": str(self.socket),
               "PI_VOICE_NO_SPAWN": "1"}
        self.proc = await asyncio.create_subprocess_exec(*args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                                         stderr=open(self.capture_dir / "pi.stderr", "w"),
                                                         env=env, cwd=str(self.cwd), limit=2**24)
        self.events = Lines(self.proc.stdout, "pi")
        self._id = 0

    async def command(self, cmd: dict, timeout: float = 30):
        self._id += 1
        cmd = {**cmd, "id": f"h{self._id}"}
        self.proc.stdin.write((json.dumps(cmd) + "\n").encode())
        await self.proc.stdin.drain()
        got = await self.events.wait(lambda r: r.get("type") == "response" and r.get("id") == cmd["id"], timeout)
        if not got:
            raise RuntimeError(f"no response to {cmd}")
        return got[1]

    async def idle(self, timeout: float = 90, after: float = 0.0):
        """Waits for the run to settle (agent_settled) after `after`."""
        return await self.events.wait(lambda r: r.get("type") == "agent_settled", timeout, after)

    async def stop(self):
        if self.proc.returncode is None:
            self.proc.stdin.close()
            try:
                await asyncio.wait_for(self.proc.wait(), 10)
            except asyncio.TimeoutError:
                self.proc.kill()

    def user_messages_sent(self, after: float = 0.0) -> list[tuple[float, str]]:
        out = []
        for t, r in self.events.records:
            m = r.get("message") or {}
            if t >= after and r.get("type") == "message_start" and m.get("role") == "user":
                c = m.get("content")
                out.append((t, c if isinstance(c, str) else " ".join(p.get("text", "") for p in c if p.get("type") == "text")))
        return out


def text_of(message: dict) -> str:
    c = message.get("content")
    if isinstance(c, str):
        return c
    return "".join(p.get("text", "") for p in c or [] if p.get("type") == "text")


async def branch_entries(pi: Pi) -> list[dict]:
    res = await pi.command({"type": "get_entries"})
    entries = res.get("data", {}).get("entries", res.get("data", []))
    tree = await pi.command({"type": "get_tree"})
    leaf = tree.get("data", {}).get("leafId")
    by_id = {e["id"]: e for e in entries}
    branch, cur = [], leaf
    while cur:
        branch.append(by_id[cur])
        cur = by_id[cur].get("parentId")
    return list(reversed(branch)), entries


def requests(capture: Path) -> list[dict]:
    f = capture / "requests.jsonl"
    return [json.loads(l)["payload"] for l in f.read_text().splitlines()] if f.exists() else []


def system_and_tools(payload: dict):
    """The leading system message: the prompt and the tool declarations, with its timestamp left out."""
    head = dict(payload["messages"][0])
    head.pop("timestamp", None)
    return json.dumps(head, sort_keys=True, ensure_ascii=False)


async def common_checks(case: str, pi: Pi, capture: Path, control: dict):
    branch, entries = await branch_entries(pi)
    spoken = [e for e in branch if e.get("type") == "custom" and e.get("customType") == "voice-spoken"]
    check(case, spoken, "a voice row (voice-spoken custom entry) is on the branch")
    payloads = requests(capture)
    check(case, payloads, f"{len(payloads)} request(s) to the main model captured")
    conversation = {(e["message"]["role"], text_of(e["message"]).strip()) for e in entries if e.get("type") == "message"}
    sent = [(m.get("role"), text_of(m).strip()) for p in payloads for m in p["messages"][1:]]
    foreign = [m for m in sent if m not in conversation]
    check(case, not foreign, f"every message sent to the model is one of the conversation's {foreign[:2]}")
    spoken_only = [e["data"]["text"] for e in spoken if ("assistant", e["data"]["text"].strip()) not in conversation]
    check(case, not any(("user", t) in sent or ("assistant", t) in sent for t in spoken_only), "no spoken text is sent as a message")
    check(case, not [e for e in entries if e.get("type") == "custom_message"], "no custom message (none can reach the model)")
    roles = {m.get("role") for p in payloads for m in p["messages"][1:]}
    check(case, roles <= {"user", "assistant", "toolResult"}, f"only the conversation follows the system message: {sorted(roles)}")
    same = all(system_and_tools(p) == system_and_tools(control) for p in payloads)
    check(case, same, "system prompt and tools are byte-for-byte the control run's")
    msgs = [json.loads(l)["message"] for l in (capture / "messages.jsonl").read_text().splitlines()]
    streamed = "".join(json.loads(l)["delta"] for l in (capture / "deltas.jsonl").read_text().splitlines())
    written = "".join(text_of(m) for m in msgs if m.get("role") == "assistant")
    check(case, streamed and written == streamed, "the written answers are exactly what the provider streamed")
    return branch, entries


async def case_auto_send(helper: Helper, pi: Pi, clips, capture, control):
    case = "auto_send"
    t0 = time.time()
    end = await helper.play(clips["bonjour"])
    got = await pi.events.wait(lambda r: r.get("type") == "message_start" and r["message"].get("role") == "user", 15, t0)
    if not check(case, got, "a user message was sent on its own"):
        return
    latency = got[0] - end
    text = text_of(got[1]["message"])
    words = set(norm(CLIPS["bonjour"]).split())
    hit = len(words & set(norm(text).split())) / len(words)
    check(case, hit >= 0.8, f"transcript {text!r} ({hit:.0%} of the words)")
    check(case, latency <= 1.5, f"sent {latency * 1000:.0f} ms after the end of speech (≤ 1500)")
    await pi.idle(after=got[0])
    await helper.events.wait(lambda r: r.get("event") == "tts_end", 60, got[0])
    await asyncio.sleep(1.0)
    await common_checks(case, pi, capture, control)


async def case_hesitation(helper: Helper, pi: Pi, clips, capture, control):
    case = "hesitation"
    t0 = time.time()
    end = await helper.play(clips["hesitation"])
    early = [m for t, m in pi.user_messages_sent(t0) if t < end - 0.05]
    check(case, not early, "nothing sent during the hesitation")
    got = await pi.events.wait(lambda r: r.get("type") == "message_start" and r["message"].get("role") == "user", 15, t0)
    if not check(case, got, "sent after the real end"):
        return
    text = norm(text_of(got[1]["message"]))
    check(case, "seulement" in text and "merci" in text, f"one message with both halves: {text!r}")
    await pi.idle(after=got[0])
    await asyncio.sleep(2.0)
    check(case, len(pi.user_messages_sent(t0)) == 1, "exactly one user message")


async def case_rewind(helper: Helper, pi: Pi, clips, capture, control):
    case = "rewind"
    t0 = time.time()
    await helper.play(clips["oui"])
    got = await pi.events.wait(lambda r: r.get("type") == "message_start" and r["message"].get("role") == "user", 15, t0)
    if not check(case, got, "first message sent"):
        return
    # Right after sending, before Pi speaks: the person adds a detail.
    await asyncio.sleep(0.2)
    spoke_before = await helper.events.wait(lambda r: r.get("event") == "tts_start", 0.01, got[0])
    check(case, not spoke_before, "the addition starts before Pi speaks")
    await helper.play(clips["plutot"])
    second = await pi.events.wait(lambda r: r.get("type") == "message_start" and r["message"].get("role") == "user",
                                  20, got[0] + 0.01)
    if not check(case, second, "the message was resent"):
        return
    await pi.idle(after=second[0])
    await helper.events.wait(lambda r: r.get("event") == "tts_end", 60, second[0])
    await asyncio.sleep(1.0)
    branch, entries = await common_checks(case, pi, capture, control)
    users = [norm(text_of(e["message"])) for e in branch if e.get("type") == "message" and e["message"].get("role") == "user"]
    check(case, len(users) == 1, f"one user message left on the branch: {users}")
    check(case, users and "oui" in users[0] and "plutôt" in users[0], "it is the old text with the addition appended")
    all_users = [e for e in entries if e.get("type") == "message" and e["message"].get("role") == "user"]
    check(case, len(all_users) == 2, "the first message stays in the session tree (abandoned branch)")


async def case_steer(helper: Helper, pi: Pi, clips, capture, control):
    case = "steer"
    t0 = time.time()
    await helper.play(clips["compte"])
    got = await pi.events.wait(lambda r: r.get("type") == "message_start" and r["message"].get("role") == "user", 15, t0)
    if not check(case, got, "first message sent"):
        return
    speaking = await helper.events.wait(lambda r: r.get("event") == "tts_start", 60, got[0])
    if not check(case, speaking, "Pi started speaking"):
        return
    await asyncio.sleep(1.0)
    onset = time.time()
    await helper.play(clips["cinq"])
    stopped = await helper.events.wait(lambda r: r.get("event") == "tts_stop", 10, onset)
    check(case, stopped and stopped[0] - onset <= 1.0, "Pi's voice stopped when the person spoke")
    second = await pi.events.wait(lambda r: r.get("type") == "message_start" and r["message"].get("role") == "user",
                                  20, onset)
    if not check(case, second, "the addition was sent"):
        return
    await pi.idle(after=second[0])
    await helper.events.wait(lambda r: r.get("event") == "tts_end", 60, second[0])
    await asyncio.sleep(1.0)
    branch, _ = await common_checks(case, pi, capture, control)
    users = [norm(text_of(e["message"])) for e in branch if e.get("type") == "message" and e["message"].get("role") == "user"]
    check(case, len(users) == 2 and "lettres" in users[0] and re.search(r"\bcinq\b|\b5\b", users[1]), f"no rewind: both messages on the branch {users}")


CASES = {"auto_send": case_auto_send, "hesitation": case_hesitation, "rewind": case_rewind, "steer": case_steer}


async def main(argv: list[str]):
    keep = "--keep" in argv
    names = [a for a in argv if not a.startswith("--")] or list(CASES)
    work = Path(tempfile.mkdtemp(prefix="pi-voice-e2e-"))
    print(f"work dir {work}", flush=True)
    clips = make_clips(work)
    socket, control_sock = work / "daemon.sock", work / "helper.sock"
    helper_cmd = f"{shlex.quote(sys.executable)} -m pi_voice.fake_audio --control {control_sock} --out {work / 'played.wav'}"
    daemon = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "pi_voice", "serve", "--socket", str(socket), "--audio", helper_cmd,
        stdout=open(work / "daemon.log", "w"), stderr=subprocess.STDOUT)
    try:
        helper = Helper(control_sock)
        await helper.open()

        cap0 = work / "control"
        cap0.mkdir()
        pi0 = Pi(cap0, socket, with_voice=False)
        await pi0.start()
        await pi0.command({"type": "prompt", "message": CLIPS["bonjour"]})
        await pi0.idle()
        await pi0.stop()
        control = requests(cap0)[0]

        for name in names:
            print(f"== {name}", flush=True)
            cap = work / name
            cap.mkdir()
            pi = Pi(cap, socket)
            await pi.start()
            try:
                res = await pi.command({"type": "prompt", "message": "/call"})
                ready = await helper.events.wait(lambda r: r.get("event") == "mic_open", 120)
                if check(name, res.get("success") and ready, "/call started the call"):
                    await CASES[name](helper, pi, clips, cap, control)
            except Exception as e:  # a crash is a failure of that case, not of the run
                check(name, False, f"crashed: {type(e).__name__}: {e}")
            finally:
                try:
                    await pi.command({"type": "prompt", "message": "/call"}, timeout=10)
                except Exception:
                    pass
                await pi.stop()
    finally:
        if daemon.returncode is None:
            daemon.terminate()
            await daemon.wait()
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)} passed, {len(failed)} failed", flush=True)
    if not keep and not failed:
        subprocess.run(["rm", "-rf", str(work)])
    return len(failed)


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
