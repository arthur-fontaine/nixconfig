#!/usr/bin/env node
// A local stdio launcher for Herdr's nix-editor mod. A mod can open TCP sockets but not
// start processes, so the bridge does it: each connection names a program and gets its
// stdio. The editor's backend is `nvim --embed` (its own LSP client talks to the language
// servers); nothing is installed for it: nvim and the servers come from the login shell's
// PATH or the project (node_modules/.bin).
//
// Listens on 127.0.0.1:7741. A client's first line is JSON:
//   {"token", "op": "run", "cmd": [...], "cwd", "input"?}  then the socket is the program's
//                                                stdio; with "input": "base64" the client
//                                                sends base64 lines (Herdr's sockets write
//                                                strings only) and gets raw bytes back
//   {"token", "op": "which", "name"}             replies {"ok", "path"}
// The bridge answers one JSON line ({"ok": true} or {"ok": false, "error"}) before piping.
// The token lives in ~/.config/herdr-app/lsp-bridge.json (mode 0600).
"use strict";
const net = require("node:net");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");
const { Transform } = require("node:stream");

const PORT = Number(process.env.HERDR_LSP_BRIDGE_PORT || 7741);
const HTTP_PORT = Number(process.env.HERDR_LSP_BRIDGE_HTTP_PORT || PORT + 2);
const HOME = os.homedir();
const CONFIG = process.env.HERDR_LSP_BRIDGE_CONFIG || path.join(HOME, ".config/herdr-app/lsp-bridge.json");
const LOG = process.env.HERDR_LSP_BRIDGE_LOG || path.join(HOME, "Library/Logs/herdr-lsp-bridge.log");
// Programs the bridge starts, by executable name: from PATH, or (servers only) by absolute
// path inside a node_modules/.bin.
const SERVERS = new Set(["typescript-language-server", "tsgo"]);
// nvim only as an embedded UI backend: these flags, -u/-i with a path, nothing else.
const NVIM_FLAGS = new Set(["--embed", "--clean", "--noplugin", "-n"]);
const NVIM_PATH_FLAGS = new Set(["-u", "-i"]);
function nvimArgsOk(args) {
  if (!args.includes("--embed")) return false;
  for (let i = 0; i < args.length; i++) {
    if (NVIM_FLAGS.has(args[i])) continue;
    if (NVIM_PATH_FLAGS.has(args[i]) && typeof args[i + 1] === "string" && (args[i + 1] === "NONE" || path.isAbsolute(args[i + 1]))) { i++; continue; }
    return false;
  }
  return true;
}
const HELLO_MAX = 16 * 1024 * 1024;

fs.mkdirSync(path.dirname(LOG), { recursive: true });
const logStream = fs.createWriteStream(LOG, { flags: "a" });
const log = (...parts) => logStream.write(`${new Date().toISOString()} ${parts.join(" ")}\n`);

function token() {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG, "utf8"));
    if (saved.token && saved.port === PORT && saved.http === HTTP_PORT) return saved.token;
  } catch {}
  const fresh = crypto.randomBytes(24).toString("hex");
  fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify({ port: PORT, http: HTTP_PORT, token: fresh }) + "\n", { mode: 0o600 });
  fs.chmodSync(CONFIG, 0o600);
  return fresh;
}
const TOKEN = token();

// The login shell's PATH, once, after the bridge's own: launchd gives the bridge the
// interactive shell's (mise's shims), which a login shell rebuilds without.
function loginPath() {
  const own = (process.env.PATH || "").split(":").filter(Boolean);
  const login = loginShellPath().split(":").filter(Boolean);
  return [...new Set([...own, ...login])].join(":");
}

function loginShellPath() {
  try {
    const out = execFileSync("/bin/zsh", ["-lc", 'printf "__PATH__%s\\n" "$PATH"'], { encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "ignore"] });
    const line = out.split("\n").find((l) => l.startsWith("__PATH__"));
    if (line) return line.slice("__PATH__".length);
  } catch (e) { log("login PATH failed:", e.message); }
  return process.env.PATH || "/usr/bin:/bin";
}
const PATH = loginPath();

function which(name) {
  for (const dir of PATH.split(":")) {
    const file = path.join(dir, name);
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch {}
  }
  return null;
}

// The executable to run, or null when it isn't an allowed server.
function resolve(cmd0) {
  if (typeof cmd0 !== "string") return null;
  if (path.isAbsolute(cmd0)) {
    const real = path.normalize(cmd0);
    return path.basename(path.dirname(real)) === ".bin" && path.basename(path.dirname(path.dirname(real))) === "node_modules"
      && SERVERS.has(path.basename(real)) && fs.existsSync(real) ? real : null;
  }
  return SERVERS.has(cmd0) || cmd0 === "nvim" ? which(cmd0) : null;
}

const reply = (socket, value) => socket.write(JSON.stringify(value) + "\n");

// Newline-separated base64 in, bytes out.
function base64Lines() {
  let pending = "";
  return new Transform({
    transform(chunk, _enc, done) {
      pending += chunk.toString("latin1");
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) if (line) this.push(Buffer.from(line, "base64"));
      done();
    },
  });
}

function startServer(socket, hello, rest) {
  const exe = resolve(hello.cmd?.[0]);
  const args = Array.isArray(hello.cmd) ? hello.cmd.slice(1) : [];
  const ok = exe && args.every((a) => typeof a === "string") && (hello.cmd[0] !== "nvim" || nvimArgsOk(args));
  if (!ok) return void (reply(socket, { ok: false, error: `not an allowed program: ${JSON.stringify(hello.cmd ?? null)}` }), socket.end());
  const cwd = typeof hello.cwd === "string" && fs.existsSync(hello.cwd) ? hello.cwd : HOME;
  const child = spawn(exe, args, { cwd, env: { ...process.env, PATH }, stdio: ["pipe", "pipe", "pipe"] });
  log("start", child.pid, exe, args.join(" "), "in", cwd);
  child.stderr.on("data", (d) => logStream.write(d));
  child.on("error", (e) => { log("spawn error", exe, e.message); socket.destroy(); });
  child.on("exit", (code, signal) => { log("exit", child.pid, code ?? signal); socket.end(); });
  reply(socket, { ok: true });
  // pipe() pauses the faster side when the other's buffer is full.
  const input = hello.input === "base64" ? base64Lines() : null;
  if (input) {
    input.pipe(child.stdin);
    if (rest.length) input.write(rest);
    socket.pipe(input);
  } else {
    if (rest.length) child.stdin.write(rest);
    socket.pipe(child.stdin);
  }
  child.stdout.pipe(socket);
  const stop = () => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); };
  socket.on("close", stop);
  socket.on("error", stop);
  child.stdin.on("error", () => {});
}

const server = net.createServer((socket) => {
  let buffered = Buffer.alloc(0);
  const onData = (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    const nl = buffered.indexOf(10);
    if (nl < 0) {
      if (buffered.length > HELLO_MAX) socket.destroy();
      return;
    }
    socket.off("data", onData);
    socket.pause();
    const rest = buffered.subarray(nl + 1);
    let hello;
    try { hello = JSON.parse(buffered.subarray(0, nl).toString("utf8")); } catch { hello = null; }
    if (!hello || typeof hello.token !== "string" || hello.token.length !== TOKEN.length
      || !crypto.timingSafeEqual(Buffer.from(hello.token), Buffer.from(TOKEN))) {
      log("refused: bad token");
      return void (reply(socket, { ok: false, error: "bad token" }), socket.end());
    }
    const op = hello.op ?? "run";
    if (op === "run") startServer(socket, hello, rest);
    else if (op === "which") { const p = resolve(hello.name); reply(socket, { ok: Boolean(p), path: p }); socket.end(); }
    else { reply(socket, { ok: false, error: `unknown op ${op}` }); socket.end(); }
    socket.resume();
  };
  socket.on("data", onData);
  socket.on("error", () => {});
});

server.on("error", (e) => { log("listen error", e.message); process.exit(1); });
server.listen(PORT, "127.0.0.1", () => log("listening on", PORT, "PATH", PATH));

// --- HTTP: the same programs, reached with fetch -----------------------------------------
// Herdr's script runtime crashes with a TCP socket read pending under load (its `net`
// module), while fetch holds up, so the editor uses this. Every request is a POST of JSON
// with the token:
//   /run   {cmd, cwd}  → {ok, id}         starts the program
//   /send  {id, data}  → {ok}             base64 bytes to its stdin
//   /recv  {id}        → base64 text      its stdout since the last /recv; waits up to
//                                         RECV_WAIT_MS for some ("" if none); 410 once it ended
//   /close {id}        → {ok}             stops it
// A program nobody has asked for output for in IDLE_MS is stopped: its client is gone.
const RECV_WAIT_MS = 15000;
const IDLE_MS = 45000;
const sessions = new Map();

function tokenOk(t) {
  return typeof t === "string" && t.length === TOKEN.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
}

function flush(s) {
  if (!s.waiter) return;
  const res = s.waiter;
  if (s.out.length) {
    const data = Buffer.concat(s.out).toString("base64");
    s.out = [];
    s.waiter = null;
    clearTimeout(s.waitTimer);
    res.end(data);
  } else if (s.ended) {
    s.waiter = null;
    clearTimeout(s.waitTimer);
    res.statusCode = 410;
    res.end("");
    sessions.delete(s.id);
  }
}

function stopSession(s) {
  if (s.child.exitCode === null && s.child.signalCode === null) s.child.kill("SIGTERM");
}

function httpRun(body) {
  const exe = resolve(body.cmd?.[0]);
  const args = Array.isArray(body.cmd) ? body.cmd.slice(1) : [];
  const ok = exe && args.every((a) => typeof a === "string") && (body.cmd[0] !== "nvim" || nvimArgsOk(args));
  if (!ok) return { ok: false, error: `not an allowed program: ${JSON.stringify(body.cmd ?? null)}` };
  const cwd = typeof body.cwd === "string" && fs.existsSync(body.cwd) ? body.cwd : HOME;
  const child = spawn(exe, args, { cwd, env: { ...process.env, PATH }, stdio: ["pipe", "pipe", "pipe"] });
  const s = { id: crypto.randomBytes(12).toString("hex"), child, out: [], waiter: null, waitTimer: null, ended: false, seen: Date.now() };
  sessions.set(s.id, s);
  log("start", child.pid, exe, args.join(" "), "in", cwd, "(http)");
  child.stderr.on("data", (d) => logStream.write(d));
  child.stdout.on("data", (d) => { s.out.push(d); flush(s); });
  child.on("error", (e) => { log("spawn error", exe, e.message); s.ended = true; flush(s); });
  child.on("exit", (code, signal) => { log("exit", child.pid, code ?? signal); s.ended = true; flush(s); });
  child.stdin.on("error", () => {});
  return { ok: true, id: s.id };
}

const httpServer = http.createServer((req, res) => {
  let size = 0;
  const parts = [];
  req.on("data", (d) => { size += d.length; if (size > HELLO_MAX) req.destroy(); else parts.push(d); });
  req.on("end", () => {
    let body;
    try { body = JSON.parse(Buffer.concat(parts).toString("utf8")); } catch { body = null; }
    const json = (code, value) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value)); };
    if (req.method !== "POST" || !body || !tokenOk(body.token)) return json(403, { ok: false, error: "bad token" });
    const route = req.url;
    if (route === "/run") return json(200, httpRun(body));
    const s = sessions.get(body.id);
    if (!s) return route === "/recv" ? (res.statusCode = 410, res.end("")) : json(404, { ok: false, error: "no such program" });
    s.seen = Date.now();
    if (route === "/send") {
      if (typeof body.data === "string" && body.data) s.child.stdin.write(Buffer.from(body.data, "base64"));
      return json(200, { ok: true });
    }
    if (route === "/close") { stopSession(s); return json(200, { ok: true }); }
    if (route === "/recv") {
      if (s.waiter) { s.waiter.end(""); clearTimeout(s.waitTimer); }
      s.waiter = res;
      res.on("close", () => { if (s.waiter === res) s.waiter = null; });
      s.waitTimer = setTimeout(() => { if (s.waiter === res) { s.waiter = null; res.end(""); } }, RECV_WAIT_MS);
      return flush(s);
    }
    json(404, { ok: false, error: `unknown route ${route}` });
  });
});

setInterval(() => {
  for (const s of sessions.values()) {
    if (s.waiter || Date.now() - s.seen <= IDLE_MS) continue;
    if (s.ended) sessions.delete(s.id);
    else { log("idle, stopping", s.child.pid); stopSession(s); s.seen = Date.now(); }
  }
}, 5000).unref();

httpServer.on("error", (e) => { log("http listen error", e.message); process.exit(1); });
httpServer.listen(HTTP_PORT, "127.0.0.1", () => log("http on", HTTP_PORT));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => {
  for (const s of sessions.values()) stopSession(s);
  server.close();
  httpServer.close();
  process.exit(0);
});
