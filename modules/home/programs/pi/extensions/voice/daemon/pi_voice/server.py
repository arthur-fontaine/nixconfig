"""The daemon: a Unix socket for the Pi extensions (NDJSON), the audio helper as a child, one call at a time.

Client -> daemon, one JSON object per line ("v": 1 implied):
  {"type": "hello", "session": id, "name": str}
  {"type": "call.start", "take": bool}   start the call, or take it from another chat
  {"type": "call.end"}
  {"type": "speak", "id": answer id, "text": sentence, "final": bool}
  {"type": "answer", "state": "aborted" | "silent"}   Pi's run was aborted, or ended with nothing to say
  {"type": "mute", "on": bool}
  {"type": "vocab", "words": [...]}
Daemon -> clients:
  {"type": "call", "active": bool, "owner": name | null, "mine": bool, "moved_to": name?}
  {"type": "busy", "owner": name}          call.start while another chat has the call
  {"type": "loading"} / {"type": "ready", "seconds": float}
  to the owner only: "state", "partial", "partial_resumed", "turn", "barge", "speaking", "spoken", "idle_end", "error"
"""

import asyncio
import json
import os
import shlex
import signal
import sys
import time
from concurrent.futures import Future
from pathlib import Path

from . import framing
from .call import Call
from .models import T0, Models, Worker, timing

UNLOAD_AFTER_S = 600.0
EXIT_AFTER_S = 1800.0


class Client:
    def __init__(self, reader, writer):
        self.reader, self.writer = reader, writer
        self.session: str | None = None
        self.name = "Pi"

    def send(self, obj: dict) -> None:
        try:
            self.writer.write((json.dumps(obj, ensure_ascii=False) + "\n").encode())
        except Exception:
            pass


class Daemon:
    def __init__(self, socket: Path, audio_cmd: str, models: Models | None = None):
        self.socket, self.audio_cmd = socket, audio_cmd
        self.loop = asyncio.get_running_loop()
        self.worker = Worker() if models is None else models.worker
        self.models = models or Models(self.worker)
        self.clients: list[Client] = []
        self.owner: Client | None = None
        self.call: Call | None = None
        self.helper_proc = None
        self.last_activity = time.time()
        self.call_ended_at: float | None = None
        self.stopping = asyncio.Event()

    # ------------------------------------------------------------------ worker results on the loop
    def run(self, fn, priority: int = 1):
        """A model call on the worker; its callbacks run on the event loop."""
        return LoopFuture(self.worker.submit(fn, priority), self.loop)

    def run_stream(self, make, on_chunk, on_done):
        threadsafe = self.loop.call_soon_threadsafe
        return self.worker.stream(make, lambda c: threadsafe(on_chunk, c), lambda x: threadsafe(on_done, x))

    # ------------------------------------------------------------------ helper
    async def start_helper(self):
        self.helper_proc = await asyncio.create_subprocess_exec(
            *shlex.split(self.audio_cmd), stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE)
        asyncio.create_task(self._read_helper())

    def to_helper(self, data: bytes) -> None:
        if self.helper_proc and self.helper_proc.stdin and not self.helper_proc.stdin.is_closing():
            self.helper_proc.stdin.write(data)

    async def _read_helper(self):
        reader = self.helper_proc.stdout
        while (got := await framing.read_frame(reader)) is not None:
            kind, payload = got
            if kind == framing.MIC:
                if self.call and getattr(self, "first_mic", False):
                    self.first_mic = False
                    timing("call: first mic frame", self.call_t0)
                if self.call:
                    self.call.mic(payload)
            elif kind == framing.EVENT:
                ev = json.loads(payload)
                if ev.get("event") == "mic_open" and getattr(self, "call_t0", None):
                    timing("call: mic open", self.call_t0)
                if self.call and ev.get("event") == "played":
                    self.call.played(ev["seq"])
                elif self.call and ev.get("event") == "drained":
                    self.call.drained()
                elif ev.get("event") == "error":
                    self.broadcast({"type": "error", "message": f"audio: {ev.get('message')}"})
        self.broadcast({"type": "error", "message": "the audio helper stopped"})
        await self.end_call()

    # ------------------------------------------------------------------ clients
    def broadcast(self, obj: dict) -> None:
        for c in self.clients:
            c.send(obj)

    def to_owner(self, obj: dict) -> None:
        if obj.get("type") not in ("partial",) or os.environ.get("PI_VOICE_LOG") == "all":
            print(f"pi-voice: {time.strftime('%H:%M:%S')} {json.dumps(obj, ensure_ascii=False)}", flush=True)
        if self.owner:
            self.owner.send(obj)

    def call_status(self) -> None:
        for c in self.clients:
            c.send({"type": "call", "active": self.owner is not None, "owner": self.owner.name if self.owner else None,
                    "mine": c is self.owner})

    async def handle(self, reader, writer):
        client = Client(reader, writer)
        self.clients.append(client)
        try:
            while line := await reader.readline():
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                self.last_activity = time.time()
                await self.dispatch(client, msg)
        finally:
            self.clients.remove(client)
            if client is self.owner:
                await self.end_call()

    async def dispatch(self, client: Client, msg: dict):
        kind = msg.get("type")
        if kind == "hello":
            client.session, client.name = msg.get("session"), msg.get("name") or "Pi"
            client.send({"type": "call", "active": self.owner is not None,
                         "owner": self.owner.name if self.owner else None, "mine": False})
        elif kind == "call.start":
            if self.owner is not None and self.owner is not client and not msg.get("take"):
                client.send({"type": "busy", "owner": self.owner.name})
                return
            await self.start_call(client)
        elif kind == "call.end" and client is self.owner:
            await self.end_call()
        elif self.call is None or client is not self.owner:
            return
        elif kind == "speak":
            self.call.speak(str(msg.get("id")), msg.get("text", ""), bool(msg.get("final")))
        elif kind == "answer":
            state = msg.get("state")
            if state == "aborted":
                self.call.cancel_answer()
            elif state == "continue":
                self.call.continue_answer()
            else:
                self.call.answer_finished_silent()
        elif kind == "mute":
            self.call.set_mute(bool(msg.get("on")))
            self.to_helper(framing.json_frame(framing.CONTROL, {"cmd": "mic", "on": not msg.get("on")}))
        elif kind == "vocab" and self.models.stt:
            self.models.stt.vocabulary = list(dict.fromkeys([*self.models.stt.vocabulary, *msg.get("words", [])]))

    async def start_call(self, client: Client):
        self.call_t0 = time.time()
        self.first_mic = True
        previous = self.owner
        if previous is not None and previous is not client:
            previous.send({"type": "call", "active": False, "owner": client.name, "mine": False, "moved_to": client.name})
        self.owner = client
        self.call_ended_at = None
        if not self.models.complete:
            if not self.models.ready:
                client.send({"type": "loading"})
            # Speech that waited for Voxtral starts when it's there.
            on_tts = lambda: self.loop.call_soon_threadsafe(lambda: self.call and self.call._next_sentence())  # noqa: E731
            fut = self.models.load(on_tts)
            if not self.models.ready:
                seconds = await asyncio.wrap_future(fut)
                client.send({"type": "ready", "seconds": round(seconds, 1)})
        timing("call: models ready", self.call_t0)
        if self.call is None:
            t = time.time()
            self.call = Call(self.models, self.run, self.to_owner, self.to_helper)
            timing("load silero", t)
            self.call.run_stream = self.run_stream
            self.to_helper(framing.json_frame(framing.CONTROL, {"cmd": "mic", "on": True}))
        self.call_status()
        self.to_owner({"type": "state", "name": self.call.state})

    async def end_call(self):
        if self.call is not None:
            self.call.cancel_answer()
            self.to_helper(framing.json_frame(framing.CONTROL, {"cmd": "mic", "on": False}))
        self.call = None
        self.owner = None
        self.call_ended_at = time.time()
        self.call_status()

    async def ticker(self):
        while not self.stopping.is_set():
            await asyncio.sleep(0.05)
            if self.call:
                self.call.tick()
            now = time.time()
            if self.call is None and self.call_ended_at and now - self.call_ended_at > UNLOAD_AFTER_S and self.models.ready:
                await asyncio.wrap_future(self.models.unload())
            if not self.clients and self.call is None and now - self.last_activity > EXIT_AFTER_S:
                self.stopping.set()

    async def serve(self):
        self.socket.parent.mkdir(parents=True, exist_ok=True)
        if self.socket.exists():
            self.socket.unlink()
        server = await asyncio.start_unix_server(self.handle, path=str(self.socket))
        os.chmod(self.socket, 0o600)
        await self.start_helper()
        asyncio.create_task(self.ticker())
        for sig in (signal.SIGTERM, signal.SIGINT):
            self.loop.add_signal_handler(sig, self.stopping.set)
        print(f"pi-voice: listening on {self.socket}", flush=True)
        timing("socket ready (since start)", T0)
        try:
            await self.stopping.wait()
        finally:
            server.close()
        if self.helper_proc and self.helper_proc.returncode is None:
            self.helper_proc.terminate()
        if self.socket.exists():
            self.socket.unlink()
        print("pi-voice: stopped", flush=True)
        # The model worker thread can be busy for seconds; nothing in it needs to finish.
        os._exit(0)


class LoopFuture:
    """A worker Future whose done callbacks run on the asyncio loop, never on the worker thread."""

    def __init__(self, future: Future, loop: asyncio.AbstractEventLoop):
        self.future, self.loop = future, loop

    def add_done_callback(self, fn):
        self.future.add_done_callback(lambda f: self.loop.call_soon_threadsafe(fn, f))

    def result(self):
        return self.future.result()


def default_socket() -> Path:
    return Path(os.environ.get("PI_VOICE_SOCKET") or Path.home() / ".cache/pi-voice/daemon.sock")


async def amain(socket: Path, audio_cmd: str):
    await Daemon(socket, audio_cmd).serve()


def serve(argv: list[str]) -> None:
    import argparse
    p = argparse.ArgumentParser(prog="pi-voice serve")
    p.add_argument("--socket", type=Path, default=default_socket())
    p.add_argument("--audio", default=os.environ.get("PI_VOICE_AUDIO", "pi-voice-audio"),
                   help="the audio helper's command (the fake one in tests)")
    args = p.parse_args(argv)
    asyncio.run(amain(args.socket, args.audio))
    sys.exit(0)
