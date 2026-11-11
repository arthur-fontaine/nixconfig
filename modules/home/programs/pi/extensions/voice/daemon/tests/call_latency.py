"""How long from /call to "listening": cold (a fresh daemon) and warm (the daemon still alive, models unloaded or loaded).

    uv run python tests/call_latency.py [--runs 3] [--warm-runs 3]

Drives the daemon over its socket as the voice extension does (hello, call.start) and times
until it reports the "listening" state, the moment the footer says it. The audio helper is the
fake one (no device); the daemon's own phase timings (`pi-voice: timing …` lines) are printed
for each cold run. Cold includes the process start and Python imports, as the extension's
first /call does; warm is a second /call after hanging up, with the models still loaded
(within the 10 minutes before they're unloaded).
"""

import argparse
import asyncio
import json
import os
import re
import signal
import statistics
import sys
import tempfile
import time
from pathlib import Path


async def call_until_listening(socket: Path, timeout: float = 300) -> float:
    t0 = time.time()
    for _ in range(int(timeout * 20)):
        try:
            reader, writer = await asyncio.open_unix_connection(str(socket))
            break
        except (FileNotFoundError, ConnectionRefusedError):
            await asyncio.sleep(0.05)
    else:
        raise RuntimeError("the daemon never opened its socket")
    writer.write(b'{"type": "hello", "session": "latency", "name": "latency"}\n{"type": "call.start"}\n')
    await writer.drain()
    while line := await asyncio.wait_for(reader.readline(), timeout):
        msg = json.loads(line)
        if msg.get("type") == "state" and msg.get("name") == "listening":
            elapsed = time.time() - t0
            writer.write(b'{"type": "call.end"}\n')
            await writer.drain()
            writer.close()
            return elapsed
    raise RuntimeError("the daemon closed the connection")


async def start_daemon(work: Path):
    socket, log = work / "daemon.sock", work / "daemon.log"
    helper = f"{sys.executable} -m pi_voice.fake_audio --control {work / 'helper.sock'}"
    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-m", "pi_voice", "serve", "--socket", str(socket), "--audio", helper,
        stdout=open(log, "w"), stderr=asyncio.subprocess.STDOUT, start_new_session=True)
    return proc, socket, log


async def stop(proc):
    for sig in (signal.SIGTERM, signal.SIGKILL):
        if proc.returncode is not None:
            return
        try:
            os.killpg(proc.pid, sig)
            await asyncio.wait_for(proc.wait(), 10)
        except (ProcessLookupError, asyncio.TimeoutError):
            pass


async def main(runs: int, warm_runs: int) -> None:
    cold, warm = [], []
    for i in range(runs):
        work = Path(tempfile.mkdtemp(prefix="pi-voice-latency-"))
        t_spawn = time.time()
        proc, socket, log = await start_daemon(work)
        try:
            # Cold: what the extension's first /call waits for, from spawning the daemon.
            await call_until_listening(socket)
            cold.append(time.time() - t_spawn)
            phases = re.findall(r"pi-voice: timing (.+) ([\d.]+)s", log.read_text())
            print(f"cold run {i + 1}: {cold[-1]:.1f} s  " + ", ".join(f"{k} {v}s" for k, v in phases), flush=True)
            for _ in range(warm_runs if i == 0 else 0):
                await asyncio.sleep(1.0)
                warm.append(await call_until_listening(socket))
                print(f"warm: {warm[-1]:.2f} s", flush=True)
        finally:
            await stop(proc)
            for f in work.iterdir():
                f.unlink()
            work.rmdir()

    def summary(xs):
        return f"median {statistics.median(xs):.2f} s, min {min(xs):.2f}, max {max(xs):.2f} (n={len(xs)})"
    print(f"\ncold /call -> listening: {summary(cold)}")
    if warm:
        print(f"warm /call -> listening: {summary(warm)}")


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--runs", type=int, default=3)
    p.add_argument("--warm-runs", type=int, default=3)
    a = p.parse_args()
    asyncio.run(main(a.runs, a.warm_runs))
