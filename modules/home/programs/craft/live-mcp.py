"""Stands in for a Craft app's live MCP server until a call needs the app.

Claude Code starts every MCP server with the session, but a live server only
reaches an app that runs with its control port, and opening every app with
each session is not an option. So this answers the handshake and the listings
itself, and the first call that needs the app opens it with its launcher,
waits for the port and hands the session to the real server.

Usage: live-mcp.py --label APP --headless-server NAME --port PORT
                   --launcher PATH --fallback JSON_ARGV -- LIVE_ARGV...
"""

import argparse
import json
import socket
import subprocess
import sys
import threading
import time

LISTS = {
    "tools/list": ("tools", "tools"),
    "prompts/list": ("prompts", "prompts"),
    "resources/list": ("resources", "resources"),
    "resources/templates/list": ("resources", "resourceTemplates"),
}
# Only these open the app. Anything else the stand-in can't answer, such as the
# `server/discover` probe Claude Code sends before `initialize`, gets "method
# not found" instead of opening every app with each session.
APP_METHODS = {
    "tools/call",
    "resources/read",
    "resources/subscribe",
    "resources/unsubscribe",
    "prompts/get",
    "completion/complete",
}
LIST_CHANGED = {
    "tools/list": "notifications/tools/list_changed",
    "prompts/list": "notifications/prompts/list_changed",
    "resources/list": "notifications/resources/list_changed",
}
# Replies to this proxy's own requests carry these ids and never reach Claude.
OWN_ID = "craft-live-mcp:"
REPLY_TIMEOUT = 20
PORT_TIMEOUT = 60

out_lock = threading.Lock()


def send(msg):
    with out_lock:
        sys.stdout.write(json.dumps(msg, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def log(text):
    print(f"craft-live-mcp: {text}", file=sys.stderr, flush=True)


def port_open(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


class Server:
    """One real MCP server process on stdio."""

    def __init__(self, argv, on_message=None, on_exit=None, quiet=False):
        self.on_message = on_message
        self.on_exit = on_exit
        self.replies = {}
        self.cond = threading.Condition()
        self.alive = True
        self.next_id = 0
        self.proc = subprocess.Popen(
            argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL if quiet else None,
            text=True,
            bufsize=1,
        )
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.proc.stdout:
            try:
                msg = json.loads(line)
            except ValueError:
                continue
            mid = msg.get("id")
            if isinstance(mid, str) and mid.startswith(OWN_ID) and "method" not in msg:
                with self.cond:
                    self.replies[mid] = msg
                    self.cond.notify_all()
            elif self.on_message:
                self.on_message(msg)
        with self.cond:
            self.alive = False
            self.cond.notify_all()
        if self.on_exit:
            self.on_exit(self)

    def write(self, msg):
        try:
            self.proc.stdin.write(json.dumps(msg, separators=(",", ":")) + "\n")
            self.proc.stdin.flush()
            return True
        except (OSError, ValueError):
            return False

    def request(self, method, params=None):
        self.next_id += 1
        mid = f"{OWN_ID}{self.next_id}"
        msg = {"jsonrpc": "2.0", "id": mid, "method": method}
        if params is not None:
            msg["params"] = params
        if not self.write(msg):
            return None
        deadline = time.monotonic() + REPLY_TIMEOUT
        with self.cond:
            while mid not in self.replies and self.alive:
                left = deadline - time.monotonic()
                if left <= 0:
                    break
                self.cond.wait(left)
            return self.replies.pop(mid, None)

    def handshake(self, init_params):
        reply = self.request("initialize", init_params)
        if not reply or "result" not in reply:
            return None
        self.write({"jsonrpc": "2.0", "method": "notifications/initialized"})
        return reply["result"]

    def listings(self, capabilities):
        """Every page of each listing the server advertises, merged."""
        lists = {}
        for method, (capability, key) in LISTS.items():
            if capability not in capabilities:
                continue
            items, cursor = [], None
            while True:
                reply = self.request(method, {"cursor": cursor} if cursor else None)
                if not reply or "result" not in reply:
                    break
                items += reply["result"].get(key, [])
                cursor = reply["result"].get("nextCursor")
                if not cursor:
                    lists[method] = {key: items}
                    break
        return lists

    def stop(self):
        try:
            self.proc.stdin.close()
        except OSError:
            pass
        try:
            self.proc.terminate()
            self.proc.wait(5)
        except (OSError, subprocess.TimeoutExpired):
            self.proc.kill()


class Proxy:
    def __init__(self, args):
        self.args = args
        self.live = None
        self.init_params = None
        self.lists = {}
        self.pending = set()
        self.lock = threading.Lock()

    def note(self):
        a = self.args
        return (
            f"This server drives the {a.label} window on screen, so the user sees "
            f"every edit as it happens. {a.label} opens by itself on the first call "
            f"that needs it. Use this server rather than `{a.headless_server}` "
            f"whenever the user wants to watch the work or asks for the real app, "
            f"its UI or live edits."
        )

    def initialize(self, msg):
        self.init_params = msg.get("params") or {}
        if port_open(self.args.port) and self.start_live() is None:
            result = self.live_result
        else:
            result = self.stand_in()
        if result is None:
            send({"jsonrpc": "2.0", "id": msg["id"], "error": {
                "code": -32603, "message": f"{self.args.label}: no MCP server answered"}})
            return
        result = dict(result)
        result["instructions"] = self.note() + "\n\n" + result.get("instructions", "")
        # Tells Claude to list again once the real server replaces the stand-in.
        capabilities = dict(result.get("capabilities") or {})
        for capability in ("tools", "prompts", "resources"):
            if capability in capabilities:
                capabilities[capability] = {**capabilities[capability], "listChanged": True}
        result["capabilities"] = capabilities
        send({"jsonrpc": "2.0", "id": msg["id"], "result": result})

    def stand_in(self):
        """Reads the handshake and listings from a server that needs no app.

        The live server itself when it starts without the app (some do and
        retry on each call), else the headless one."""
        for argv in (self.args.live, self.args.fallback):
            server = Server(argv, quiet=True)
            try:
                result = server.handshake(self.init_params)
                if result is not None:
                    self.lists = server.listings(result.get("capabilities") or {})
                    return result
            finally:
                server.stop()
        return None

    def open_app(self):
        """Opens the app with its control port. Returns an error, or None."""
        a = self.args
        if port_open(a.port):
            return None
        log(f"opening {a.label}")
        try:
            run = subprocess.run([a.launcher], capture_output=True, text=True, timeout=30)
        except (OSError, subprocess.TimeoutExpired) as e:
            return f"could not open {a.label}: {e}"
        if run.returncode != 0:
            return (run.stderr or run.stdout).strip() or f"could not open {a.label}"
        deadline = time.monotonic() + PORT_TIMEOUT
        while not port_open(a.port):
            if time.monotonic() > deadline:
                return f"{a.label} did not open its control port {a.port} within {PORT_TIMEOUT} s"
            time.sleep(0.25)
        return None

    def start_live(self):
        """Starts the real live server. Returns an error, or None."""
        server = Server(self.args.live, on_message=self.from_live, on_exit=self.live_exited)
        result = server.handshake(self.init_params)
        if result is None:
            server.stop()
            return f"the live MCP server could not reach {self.args.label}"
        lists = server.listings(result.get("capabilities") or {})
        changed = [LIST_CHANGED[m] for m in LIST_CHANGED if self.lists and lists.get(m) != self.lists.get(m)]
        self.lists = lists
        self.live_result = result
        with self.lock:
            self.live = server
        for method in changed:
            send({"jsonrpc": "2.0", "method": method})
        return None

    def from_live(self, msg):
        if "method" not in msg:
            with self.lock:
                self.pending.discard(json.dumps(msg.get("id")))
        send(msg)

    def live_exited(self, server):
        with self.lock:
            if self.live is not server:
                return
            self.live = None
            pending, self.pending = self.pending, set()
        for mid in pending:
            send({"jsonrpc": "2.0", "id": json.loads(mid), "error": {
                "code": -32603, "message": f"the connection to {self.args.label} closed"}})

    def stop_live(self):
        with self.lock:
            server = self.live
        if server:
            server.stop()

    def forward(self, msg):
        with self.lock:
            server = self.live
            if server and "id" in msg:
                self.pending.add(json.dumps(msg["id"]))
        if not server or not server.write(msg):
            self.fail(msg, f"the connection to {self.args.label} closed")

    def fail(self, msg, error):
        if "id" not in msg:
            return
        if msg.get("method") == "tools/call":
            reply = {"result": {"content": [{"type": "text", "text": error}], "isError": True}}
        else:
            reply = {"error": {"code": -32603, "message": error}}
        send({"jsonrpc": "2.0", "id": msg["id"], **reply})

    def handle(self, msg):
        method = msg.get("method")
        if method == "initialize":
            self.initialize(msg)
            return
        if method is None:
            # A reply to a request the real server made.
            if self.live:
                self.live.write(msg)
            return
        if self.live and method == "tools/call" and not port_open(self.args.port):
            # The app was quit since: start it and the server again.
            self.stop_live()
        if self.live:
            self.forward(msg)
            return
        if "id" not in msg:
            return
        if method in ("ping", "logging/setLevel"):
            send({"jsonrpc": "2.0", "id": msg["id"], "result": {}})
        elif method in LISTS and not (msg.get("params") or {}).get("cursor"):
            key = LISTS[method][1]
            send({"jsonrpc": "2.0", "id": msg["id"], "result": self.lists.get(method, {key: []})})
        elif method not in APP_METHODS and method not in LISTS:
            send({"jsonrpc": "2.0", "id": msg["id"], "error": {
                "code": -32601, "message": f"Method not found: {method}"}})
        else:
            error = self.open_app() or self.start_live()
            if error:
                log(error)
                self.fail(msg, error)
            else:
                self.forward(msg)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--label", required=True)
    parser.add_argument("--headless-server", required=True)
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--launcher", required=True)
    parser.add_argument("--fallback", type=json.loads, required=True)
    parser.add_argument("live", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if args.live[:1] == ["--"]:
        args.live = args.live[1:]

    proxy = Proxy(args)
    for line in sys.stdin:
        try:
            msg = json.loads(line)
        except ValueError:
            continue
        if isinstance(msg, dict):
            proxy.handle(msg)
    proxy.stop_live()


main()
