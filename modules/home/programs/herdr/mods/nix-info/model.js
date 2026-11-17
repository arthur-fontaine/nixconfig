// A Pi session's JSONL as the Info panel reads it: fed in chunks as the file grows,
// turned into the figures the panel shows. Pure, so `node --test` covers it; nix joins it
// into main.js (top-level `export` stripped), hence the `info` prefix on every name.

// Pi's folder for a cwd's sessions: "/Users/a/x" → "--Users-a-x--".
export function infoSessionDir(cwd) {
  return `-${String(cwd).replace(/\/+$/, "").replaceAll("/", "-")}--`;
}

// Pi titles its terminal "π - <session name> - <folder>", or "π - <folder>" before it has one.
export function infoParseTitle(title) {
  const m = /^π - (.*)$/.exec(title ?? "");
  if (!m) return null;
  const parts = m[1].split(" - ");
  return parts.length >= 2 ? { name: parts.slice(0, -1).join(" - "), folder: parts.at(-1) } : { name: null, folder: parts[0] };
}

// UTF-8 bytes of a string, to advance a byte offset by what was read.
export function infoUtf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

export function infoNewSession(file) {
  return {
    file,
    rest: "", // an unfinished last line, completed by the next chunk
    offset: 0, // bytes consumed from the file
    cwd: null,
    name: null,
    model: null,
    thinking: null,
    started: null, // ms
    last: null, // ms of the latest entry
    messages: 0, // user and assistant messages
    compactions: 0,
    lastCompaction: null, // ms
    requests: [], // per assistant response: { context, input, cacheRead, cacheWrite, output, afterCompaction }
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    tools: new Map(), // id → tool call (see infoTool)
    order: [], // tool call ids, oldest first
    files: new Map(), // path → { added, removed }
    written: new Map(), // path → content of its last write, for diffing the next one
    pendingCompaction: false,
    changed: new Set(), // ids of the calls whose bash-changes record was counted
    untitled: 0,
    untitledNested: 0, // nested bash calls only bash-titles.json can name // codemode calls without a title of their own (details.title or a late one)
    early: new Map(), // id → a late title fed before its call
  };
}

const ms = (t) => (typeof t === "number" ? t : t ? Date.parse(t) || null : null);

function rel(path, cwd) {
  if (!path || !cwd) return path ?? "";
  const dir = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(dir) ? path.slice(dir.length) : path;
}

const firstLine = (s) => String(s ?? "").split("\n")[0];

// A bash command as people read it: without the set-up in front of the real program
// (`cd <dir> &&`, `export X=…;`, `X=… ` assignments, `set -e;`), repeatedly; newlines
// count as `;`. When nothing is left, the command as written.
const WORD = `(?:"[^"]*"|'[^']*'|\\$\\([^)]*\\)|[^\\s;&|]+)`;
const SEP = "\\s*(?:&&|;|\\n)\\s*";
const NOISE = [
  new RegExp(`^cd(?:\\s+${WORD})?${SEP}`),
  new RegExp(`^export\\s+[A-Za-z_]\\w*(?:=${WORD})?(?:\\s+[A-Za-z_]\\w*(?:=${WORD})?)*${SEP}`),
  new RegExp(`^set(?:\\s+[^;&\\n]+)?${SEP}`),
  new RegExp(`^[A-Za-z_]\\w*=${WORD}?(?:${SEP}|\\s+)`),
];
const infoProgram = (p) => p.split("/").pop();

export function infoCommand(command) {
  let rest = String(command ?? "").replace(/^\s+/, "");
  for (let changed = true; changed && rest;) {
    changed = false;
    for (const re of NOISE) {
      const m = re.exec(rest);
      if (m && m[0].length < rest.length) { rest = rest.slice(m[0].length).replace(/^\s+/, ""); changed = true; }
    }
  }
  const shown = rest || String(command ?? "");
  // A heredoc or an inline script says what it does in its body, not in its marker:
  // "python3 · import json, re", "bash · git fetch origin".
  const heredoc = /^(\S+)[^\n]*<<-?\s*['"]?(\w+)['"]?[^\n]*\n([\s\S]*)$/.exec(shown);
  if (heredoc) {
    const body = heredoc[3].split("\n").map((l) => l.trim()).find((l) => l && l !== heredoc[2]);
    if (body) return `${infoProgram(heredoc[1])} · ${body}`;
  }
  const inline = /^(\S+)\s+(?:-\w*c\w*|-e)\s+(['"])([\s\S]*?)\2/.exec(shown);
  if (inline) {
    const body = inline[3].split("\n").map((l) => l.trim()).find(Boolean);
    if (body) return `${infoProgram(inline[1])} · ${body}`;
  }
  return firstLine(shown).trim();
}

// A tool call as listed: `kind` is the short word, `arg` the one thing that tells calls apart.
export function infoTool(call, cwd) {
  const a = call.arguments ?? {};
  const base = { id: call.id, name: call.name, path: null };
  switch (call.name) {
    case "bash":
      return { ...base, kind: "bash", arg: infoCommand(a.command), full: String(a.command ?? "") };
    case "read":
    case "edit":
    case "write":
      return { ...base, kind: call.name, arg: rel(a.path, cwd), path: a.path ?? null };
    case "ask_user_question":
      return { ...base, kind: "ask", arg: firstLine(a.questions?.[0]?.question ?? a.question ?? "") };
    case "web_fetch":
      return { ...base, kind: "fetch", arg: String((Array.isArray(a.urls) ? a.urls[0] : a.url) ?? "") };
    case "Agent":
      return { ...base, kind: "agent", arg: firstLine([a.subagent_type, a.description ?? a.prompt].filter(Boolean).join(": ")) };
    case "codemode":
      return { ...base, kind: "code", arg: infoScriptArg(String(a.code ?? ""), cwd), full: String(a.code ?? "") };
    default:
      return { ...base, kind: call.name, arg: firstLine(Object.values(a).find((v) => typeof v === "string") ?? "") };
  }
}

// ---- codemode: a script is named by the calls it makes --------------------------------

// Kinds with their counts, in order of first use: "edit ×3, bash".
function infoCallNames(names) {
  const n = new Map();
  for (const name of names) { const k = infoTool({ name }).kind; n.set(k, (n.get(k) ?? 0) + 1); }
  return [...n].map(([k, c]) => (c > 1 ? `${k} ×${c}` : k)).join(", ");
}

// One call as "bash: git status", "read: src/a.ts"; its kind alone when it has no argument.
function infoCallLabel(name, args, cwd) {
  const t = infoTool({ name, arguments: args }, cwd);
  return t.arg ? `${t.kind}: ${t.arg}` : t.kind;
}

const INFO_ARG_KEYS = ["command", "path", "url", "urls", "query", "question"];
const INFO_TOOL_CALL = /\btools\s*\.\s*(\w+)\s*\(/g;

// The literal arguments of a call written in the code, as far as a regex reads them:
// `command: "…"`, `path: '…'`, a template too (its ${…} shown as written).
function infoCodeArgs(text) {
  const args = {};
  for (const key of INFO_ARG_KEYS) {
    const m = new RegExp(`\\b${key}\\s*:\\s*(\`(?:[^\`\\\\]|\\\\.)*\`|"(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*')`).exec(text);
    if (m) args[key] = m[1].slice(1, -1);
  }
  return Object.keys(args).length ? args : null;
}

// A script's arg before it has a result: its calls when the code names several, the one call
// with its literal argument, else its first line that isn't a comment or a lone bracket.
export function infoScriptArg(code, cwd) {
  const calls = [...code.matchAll(INFO_TOOL_CALL)];
  if (calls.length > 1) return infoCallNames(calls.map((m) => m[1]));
  if (calls.length === 1) {
    const args = infoCodeArgs(code.slice(calls[0].index));
    if (args) return infoCallLabel(calls[0][1], args, cwd);
  }
  const line = code.split("\n").map((l) => l.trim()).find((l) => l && !/^(\/\/|\/\*|\*)/.test(l) && /[\w"'`]/.test(l));
  return line ?? firstLine(code).trim();
}

// details.calls' arguments: JSON cut at some length, so read by regex when they don't parse.
function infoCutArgs(raw) {
  raw = String(raw ?? "");
  let args = null;
  try { args = JSON.parse(raw); } catch {
    args = {};
    for (const key of INFO_ARG_KEYS) {
      const v = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(raw)?.[1];
      if (v === undefined) continue;
      try { args[key] = JSON.parse(`"${v}"`); } catch { args[key] = v.replace(/\\n/g, "\n").replace(/\\(.)/g, "$1"); }
    }
  }
  return args && typeof args === "object" ? args : {};
}

// The calls a finished script made: Pi's nestedCalls, else details.calls. A nested call whose
// arguments were too big carries only argumentsBytes: its details.calls twin's cut ones name it,
// but `whole` stays false, so its lines aren't counted from them.
function infoNestedCalls(m) {
  const details = Array.isArray(m.details?.calls) ? m.details.calls : [];
  const nested = Array.isArray(m.nestedCalls?.calls) ? m.nestedCalls.calls : null;
  const byId = new Map(details.map((c) => [c?.id, c]));
  return (nested ?? details).filter((c) => c && typeof c.name === "string").map((c) => {
    const whole = Boolean(c.arguments && typeof c.arguments === "object");
    const d = byId.get(c.id);
    return { id: c.id, name: c.name, error: c.status === "error", whole, args: whole ? c.arguments : infoCutArgs(d?.args ?? c.args),
      duration: typeof c.durationMs === "number" ? Math.round(c.durationMs) : null, errorText: c.error ?? d?.error ?? null,
      title: [c.title, d?.title].find((x) => typeof x === "string" && x.trim())?.trim() ?? null };
  });
}

// A finished script's arg from the calls it made; null when it made none (it threw first).
function infoNestedArg(calls, cwd) {
  if (calls.length > 1) return infoCallNames(calls.map((c) => c.name));
  return calls.length ? infoCallLabel(calls[0].name, calls[0].args, cwd) : null;
}

// Which commands bash-titles names (its wantsTitle): long, on several lines, or of several steps.
export function infoWantsTitle(command) {
  const text = String(command ?? "").trim();
  if (!text) return false;
  const steps = (text.match(/;|&&|\|\|?/g) ?? []).length;
  return text.length > 80 || text.includes("\n") || steps > 2;
}

// sha256 as hex, of a string's UTF-8 (a lone surrogate as U+FFFD, as Node encodes it), which
// bash-titles keys its cache by. Here rather than Herdr's crypto: this file is joined into two
// bundles with its imports dropped, and runs under node --test as is.
const INFO_PRIMES = [];
for (let n = 2; INFO_PRIMES.length < 64; n++) if (INFO_PRIMES.every((p) => n % p)) INFO_PRIMES.push(n);
const infoFrac = (x) => ((x - Math.floor(x)) * 4294967296) >>> 0;
const INFO_K = INFO_PRIMES.map((p) => infoFrac(Math.cbrt(p)));
const INFO_H = INFO_PRIMES.slice(0, 8).map((p) => infoFrac(Math.sqrt(p)));

function infoUtf8(s) {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(++i) - 0xdc00);
    else if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

export function infoSha256(s) {
  const bytes = infoUtf8(s), bits = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(i >= 4 ? 0 : (bits >>> (i * 8)) & 0xff);
  const h = INFO_H.slice(), w = new Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let o = 0; o < bytes.length; o += 64) {
    for (let i = 0; i < 16; i++) w[i] = (bytes[o + i * 4] << 24) | (bytes[o + i * 4 + 1] << 16) | (bytes[o + i * 4 + 2] << 8) | bytes[o + i * 4 + 3];
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + INFO_K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      k = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    [a, b, c, d, e, f, g, k].forEach((x, i) => { h[i] = (h[i] + x) | 0; });
  }
  return h.map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
}

// A script's key in ~/.pi/agent/bash-titles.json (its keyOf(scriptKey(code))).
export function infoScriptKey(code) {
  return infoSha256(`codemode\0${String(code).trim()}`.trim()).slice(0, 32);
}

// A command's key in ~/.pi/agent/bash-titles.json (its keyOf(command)).
export function infoCommandKey(command) {
  return infoSha256(String(command).trim()).slice(0, 32);
}

// Lines added and removed between two texts, line by line as a multiset (moves aren't changes).
export function infoLineDiff(before, after) {
  const count = new Map();
  for (const l of before ? String(before).split("\n") : []) count.set(l, (count.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of after ? String(after).split("\n") : []) {
    const n = count.get(l) ?? 0;
    if (n > 0) count.set(l, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of count.values()) removed += n;
  return { added, removed };
}

// A path made absolute against `base` (the session's cwd, a git root), "." and ".." resolved,
// so a file named relatively and absolutely counts once.
function infoAbs(path, base) {
  if (typeof path !== "string" || !path) return null;
  if (path.startsWith("~")) return path;
  const full = path.startsWith("/") || !base ? path : `${base}/${path}`;
  const out = [];
  for (const part of full.split("/")) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return `${full.startsWith("/") ? "/" : ""}${out.join("/")}`;
}

function infoAddLines(state, path, added, removed) {
  const f = state.files.get(path) ?? { added: 0, removed: 0 };
  f.added += added; f.removed += removed;
  state.files.set(path, f);
}

// bash-changes' record of a call (on its result, or a session entry for one that went on in the
// background): once per call. Returns the files it covers, whose edits and writes inside the same
// script it already counts.
function infoCountChanges(state, id, changes) {
  const covered = new Set();
  if (!changes || !Array.isArray(changes.files)) return covered;
  for (const f of changes.files) {
    const path = infoAbs(f?.path, changes.root ?? state.cwd);
    if (!path) continue;
    covered.add(path);
    if (!state.changed.has(id)) infoAddLines(state, path, Number(f.added) || 0, Number(f.removed) || 0);
  }
  if (typeof id === "string") state.changed.add(id);
  return covered;
}

function countLines(state, call, covered = null) {
  const a = call.arguments ?? {};
  const path = infoAbs(a.path, state.cwd);
  if (!path) return;
  let d = null;
  if (call.name === "edit") {
    const edits = Array.isArray(a.edits) ? a.edits : [{ oldText: a.oldText, newText: a.newText }];
    d = { added: 0, removed: 0 };
    for (const e of edits) {
      const x = infoLineDiff(e.oldText ?? "", e.newText ?? "");
      d.added += x.added; d.removed += x.removed;
    }
  } else if (call.name === "write") {
    // Against the last write when known; else the whole content is new.
    d = infoLineDiff(state.written.get(path) ?? "", a.content ?? "");
    state.written.set(path, a.content ?? "");
  }
  if (d && !covered?.has(path)) infoAddLines(state, path, d.added, d.removed);
}

// A call bash-titles names (a codemode script, a long bash command) has a title of its own:
// bash-titles.json is no longer needed for it.
function infoTitled(state, call) {
  if (!call.needsTitle || call.titled) return;
  call.titled = true;
  state.untitled--;
}

function apply(state, entry) {
  const t = ms(entry.timestamp);
  if (t) { state.last = t; state.started ??= t; }
  switch (entry.type) {
    case "session":
      state.cwd = entry.cwd ?? state.cwd;
      state.started = ms(entry.timestamp) ?? state.started;
      return;
    case "session_info":
      if (entry.name) state.name = entry.name;
      return;
    case "model_change":
      state.model = entry.modelId ?? state.model;
      return;
    case "thinking_level_change":
      state.thinking = entry.thinkingLevel ?? state.thinking;
      return;
    case "custom": {
      if (entry.customType === "bash-changes") { infoCountChanges(state, entry.data?.toolCallId, entry.data?.fileChanges); return; }
      // A title Pi learned after the result: the latest entry for a call counts.
      const id = entry.data?.toolCallId, title = entry.data?.title;
      if (entry.customType !== "bash-titles" || typeof id !== "string" || typeof title !== "string" || !title.trim()) return;
      const call = state.tools.get(id);
      if (!call) { state.early.set(id, title.trim()); return; }
      if (!call.needsTitle) return;
      call.lateTitle = title.trim();
      infoTitled(state, call);
      return;
    }
    case "compaction":
      state.compactions++;
      state.lastCompaction = t;
      state.pendingCompaction = true;
      return;
    case "message":
      break;
    default:
      return;
  }
  const m = entry.message ?? {};
  if (m.role === "user") state.messages++;
  else if (m.role === "assistant") {
    state.messages++;
    if (m.model) state.model = m.model;
    if (m.thinkingLevel) state.thinking = m.thinkingLevel;
    const u = m.usage;
    if (u && (u.input || u.cacheRead || u.cacheWrite || u.output)) {
      const r = { input: u.input ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0, output: u.output ?? 0, afterCompaction: state.pendingCompaction };
      r.context = r.input + r.cacheRead + r.cacheWrite;
      state.requests.push(r);
      state.pendingCompaction = false;
      for (const k of ["input", "output", "cacheRead", "cacheWrite"]) state.totals[k] += r[k];
    }
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b?.type !== "toolCall" || !b.id || state.tools.has(b.id)) continue;
      state.tools.set(b.id, { ...infoTool(b, state.cwd), started: ms(m.timestamp) ?? t, duration: null, error: null, call: b,
        args: infoCapValue(b.arguments ?? {}), result: null, resultCut: false, finished: null });
      state.order.push(b.id);
      const call = state.tools.get(b.id);
      call.needsTitle = b.name === "codemode" || (b.name === "bash" && infoWantsTitle(b.arguments?.command));
      if (call.needsTitle) state.untitled++;
      if (state.early.has(b.id)) {
        if (call.needsTitle) { call.lateTitle = state.early.get(b.id); infoTitled(state, call); }
        state.early.delete(b.id);
      }
    }
  } else if (m.role === "toolResult") {
    const call = state.tools.get(m.toolCallId);
    if (!call) return;
    call.threw = m.isError === true;
    call.error = call.threw;
    call.finished = ms(m.timestamp) ?? t;
    call.duration = typeof m.durationMs === "number" ? m.durationMs : call.finished - (call.started ?? t);
    const text = resultText(m.content);
    call.result = text.length > RESULT_CAP ? text.slice(0, RESULT_CAP) : text;
    call.resultCut = text.length > RESULT_CAP;
    // Pi's edit result carries the diff with line numbers: the inspector shows it as is.
    const diff = m.details?.diff;
    if (typeof diff === "string") call.diff = infoParseDiff(diff.length > RESULT_CAP ? diff.slice(0, RESULT_CAP) : diff);
    const title = m.details?.title;
    if (call.needsTitle && typeof title === "string" && title.trim()) { call.title = title.trim(); infoTitled(state, call); }
    // Changes bash-changes saw happened, whether the call failed or not.
    const covered = infoCountChanges(state, m.toolCallId, m.details?.fileChanges);
    if (call.name === "codemode") {
      const calls = infoNestedCalls(m);
      call.arg = infoNestedArg(calls, state.cwd) ?? call.arg;
      // A failed nested call is an error, though the script caught it and went on.
      call.error ||= calls.some((c) => c.error);
      const outputs = m.details?.callOutputs ?? {};
      call.nested = calls.slice(0, INFO_NESTED_CAP).map((c, i) => {
        const t = infoTool({ name: c.name, arguments: c.args }, state.cwd);
        // Its result: the error, else the first lines of its output codemode kept.
        const out = outputs[c.id];
        const lines = Array.isArray(out?.lines) ? out.lines : [];
        const text = c.error && typeof c.errorText === "string" ? c.errorText : lines.join("\n");
        // Title first, as a top-level bash: none carries one yet, but bash-titles may name them.
        // A long command bash-titles named only in bash-titles.json (nested calls' titles aren't
        // in the session): keyed by its whole command, so not from details.calls' cut one.
        const wants = !c.title && c.name === "bash" && c.whole && infoWantsTitle(c.args.command);
        if (wants) state.untitledNested++;
        return { id: typeof c.id === "string" ? c.id : `${m.toolCallId}/${i + 1}`, name: c.name, kind: t.kind, arg: c.title ?? t.arg, full: t.full ?? t.arg, path: infoAbs(t.path, state.cwd), wants,
          error: c.error, duration: c.duration, args: infoCapValue(c.args, INFO_NESTED_ARG_CAP),
          result: text.slice(0, INFO_NESTED_ARG_CAP), resultCut: text.length > INFO_NESTED_ARG_CAP || (!c.error && out?.total > lines.length) };
      });
      for (const c of calls) if (!c.error && c.whole) countLines(state, { name: c.name, arguments: c.args }, covered);
    }
    // Lines count once the edit or write went through.
    else if (!call.threw) countLines(state, call.call, covered);
    delete call.call;
  }
}

// ---- What the inspector keeps per call: capped, so hundreds of calls stay small ---------

// The stored text of one call's result (and of each long argument string) stops here.
export const RESULT_CAP = 64 * 1024;
// The nested calls kept per script (its sub-rows), and the length of each one's strings.
const INFO_NESTED_CAP = 200;
const INFO_NESTED_ARG_CAP = 2048;
const ARG_STRING_CAP = 16 * 1024;

function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b?.type === "text" ? b.text ?? "" : b?.type === "image" ? "[image]" : "")).join("\n");
}

// Arguments as given, long strings cut (a write's content, an edit's text).
export function infoCapValue(value, cap = ARG_STRING_CAP) {
  if (typeof value === "string") return value.length > cap ? `${value.slice(0, cap)}…` : value;
  if (Array.isArray(value)) return value.map((v) => infoCapValue(v, cap));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, infoCapValue(v, cap)]));
  return value;
}

// Pretty JSON as lines of colored parts: { indent, parts: [{ text, kind }] }, kind one of
// key, string, number, literal (true/false/null), punct.
export function infoJsonLines(value) {
  const lines = [];
  const walk = (v, indent, lead, tail) => {
    const head = lead ? [...lead] : [];
    if (v && typeof v === "object") {
      const array = Array.isArray(v);
      const entries = array ? v.map((x) => [null, x]) : Object.entries(v);
      const [open, close] = array ? ["[", "]"] : ["{", "}"];
      if (!entries.length) { lines.push({ indent, parts: [...head, { text: open + close + tail, kind: "punct" }] }); return; }
      lines.push({ indent, parts: [...head, { text: open, kind: "punct" }] });
      entries.forEach(([k, x], i) => {
        const key = k === null ? null : [{ text: JSON.stringify(k), kind: "key" }, { text: ": ", kind: "punct" }];
        walk(x, indent + 1, key, i < entries.length - 1 ? "," : "");
      });
      lines.push({ indent, parts: [{ text: close + tail, kind: "punct" }] });
      return;
    }
    const kind = typeof v === "string" ? "string" : typeof v === "number" ? "number" : "literal";
    const parts = [...head, { text: v === undefined ? "null" : JSON.stringify(v), kind }];
    if (tail) parts.push({ text: tail, kind: "punct" });
    lines.push({ indent, parts });
  };
  walk(value, 0, null, "");
  return lines;
}

// An edit call's change as diff lines: { sign: "-" | "+", text }, edit by edit.
export function infoEditDiff(args) {
  const edits = Array.isArray(args?.edits) ? args.edits : args?.oldText !== undefined ? [args] : [];
  const out = [];
  edits.forEach((e, i) => {
    if (i) out.push({ sign: " ", text: "⋯" });
    for (const l of String(e.oldText ?? "").split("\n")) out.push({ sign: "-", text: l });
    for (const l of String(e.newText ?? "").split("\n")) out.push({ sign: "+", text: l });
  });
  return out;
}

// Pi's edit diff ("+ 31 text", "- 30 text", "  27 text", "   ..." between hunks) as
// { lines: [{ sign: "+" | "-" | " ", num, text }], from, to }: from–to spans the changed lines.
export function infoParseDiff(diff) {
  const lines = [];
  let from = null, to = null;
  for (const raw of String(diff).split("\n")) {
    if (!raw.trim()) continue;
    const m = /^([+\- ])\s*(\d+) ?(.*)$/.exec(raw);
    if (!m) { lines.push({ sign: " ", num: null, text: "⋯" }); continue; }
    const num = Number(m[2]);
    lines.push({ sign: m[1], num, text: m[3] });
    if (m[1] !== " ") { from = from === null ? num : Math.min(from, num); to = to === null ? num : Math.max(to, num); }
  }
  return { lines, from, to };
}

// The first `max` lines of a result, and how many more there are.
export function infoResultLines(text, max = 200) {
  const lines = String(text ?? "").replace(/\n$/, "").split("\n");
  return { lines: lines.slice(0, max), more: Math.max(0, lines.length - max) };
}

// "16:48:27.954" (or "16:48:27" without `ms`), local time.
export function infoClock(msec, ms = true) {
  if (!msec) return "—";
  const d = new Date(msec), p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${ms ? `.${p(d.getMilliseconds(), 3)}` : ""}`;
}

// Feeds a chunk read from the file (`bytes` of it); returns whether anything new was applied.
export function infoFeed(state, chunk, bytes = infoUtf8Length(chunk)) {
  state.offset += bytes;
  const text = state.rest + chunk;
  const lines = text.split("\n");
  state.rest = lines.pop() ?? "";
  let changed = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    apply(state, entry);
    changed = true;
  }
  return changed;
}

// ---- What the panel shows ------------------------------------------------------------

export function infoContext(state, window = 1_000_000) {
  const last = state.requests.at(-1);
  const used = last?.context ?? null;
  return { used, window, ratio: used === null ? 0 : used / window, compactions: state.compactions };
}

// Context size per request (oldest first) for a sparkline: { ratio, afterCompaction }.
export function infoSpark(state, window = 1_000_000, max = 72) {
  return state.requests.slice(-max).map((r) => ({ ratio: r.context / window, afterCompaction: r.afterCompaction }));
}

const hit = (r) => { const all = r.input + r.cacheRead + r.cacheWrite; return all ? r.cacheRead / all : null; };

export function infoCache(state) {
  const last = state.requests.at(-1);
  return { last: last ? hit(last) : null, session: hit(state.totals), read: state.totals.cacheRead, written: state.totals.cacheWrite, input: state.totals.input, output: state.totals.output };
}

// Tool calls newest first; `running` = no result yet. A codemode call (a long bash command) is named
// by its result's details.title, else by its latest bash-titles session entry, else by `titles`
// (bash-titles.json, for older sessions and running scripts, once infoKeyTitles keyed the call;
// a title ending in "…" was cut by an old limit: none), else by its own arg.
export function infoTools(state, titles = null) {
  return state.order.slice().reverse().map((id) => {
    const c = state.tools.get(id);
    const fromFile = (key) => { const x = titles?.[key]; return typeof x === "string" && x && !x.endsWith("…") ? x : null; };
    let arg = c.title ?? c.lateTitle ?? c.arg;
    if (c.titleKey && !c.titled) arg = fromFile(c.titleKey) ?? arg;
    const nested = titles && c.nested ? c.nested.map((sub) => (sub.titleKey && fromFile(sub.titleKey) ? { ...sub, arg: fromFile(sub.titleKey) } : sub)) : c.nested;
    return { id: c.id, kind: c.kind, name: c.name, arg, full: c.full ?? c.arg, path: c.path, started: c.started, duration: c.duration, error: c.error, running: c.duration === null,
      threw: c.threw ?? null, nested: nested ?? null,
      args: c.args, result: c.result, resultCut: c.resultCut, finished: c.finished, diff: c.diff ?? null };
  });
}

const INFO_KINDS = { bash: ["bash"], read: ["read"], edit: ["edit", "write"], ask: ["ask"] };

// A listed call under a kind filter ("all", "bash", "read", "edit", "ask", "errors"): null when
// left out. A script is kept for the calls it made, with only those as its sub-rows.
export function infoKeep(c, kind) {
  const kinds = INFO_KINDS[kind];
  if (kind !== "errors" && !kinds) return c;
  const pick = kind === "errors" ? (n) => n.error : (n) => kinds.includes(n.kind);
  const matched = c.nested?.filter(pick) ?? [];
  if (kind === "errors" ? !c.error : !kinds.includes(c.kind) && !matched.length) return null;
  return c.nested ? { ...c, nested: matched } : c;
}

const INFO_DETAILS = ["context", "activity", "lines"];
const INFO_FILTERS = ["all", "bash", "read", "edit", "ask", "errors"];

// The panel's state after a nix-info.<verb> command (keys, scripts): { detail, kind, sel, all },
// or null for a command it doesn't know. detail:<key> ("detail:" the overview), kind:<key>,
// select:<call id> ("select:" none), all, back (as Esc).
export function infoViewCommand(view, command) {
  const home = { detail: null, kind: "all", sel: null, all: false };
  const i = command.indexOf(":"), verb = i < 0 ? command : command.slice(0, i), arg = i < 0 ? null : command.slice(i + 1);
  if (verb === "detail" && arg === "") return home;
  if (verb === "detail") return INFO_DETAILS.includes(arg) ? { ...home, detail: arg } : null;
  if (verb === "kind") return INFO_FILTERS.includes(arg) ? { ...view, detail: "activity", kind: arg, sel: null, all: false } : null;
  if (verb === "select" && arg !== null) return arg ? { ...view, detail: view.detail ?? "activity", sel: arg } : { ...view, sel: null };
  if (command === "all") return { ...view, all: true };
  if (command === "back") return view.sel ? { ...view, sel: null } : home;
  return null;
}

// The rows listed: each call at level 0, a script's calls under it at level 1, in call order.
export function infoRows(calls) {
  return calls.flatMap((c) => [{ ...c, level: 0 }, ...(c.nested ?? []).map((n) => ({
    id: n.id, parent: c.id, level: 1, name: n.name, kind: n.kind, arg: n.arg, full: n.full, path: n.path, duration: n.duration,
    error: n.error, threw: n.error, running: false, started: null, finished: null, args: n.args, result: n.result, resultCut: n.resultCut, diff: null, nested: null,
  }))]);
}

// Works out the bash-titles.json keys of up to `max` calls that lack a title (infoTools looks them
// up): the sha256 is slow under Herdr's JS, which interrupts a mod busy too long between two
// awaits, so a session of hundreds of scripts is keyed a few at a time. Whether some are left.
export function infoKeyTitles(state, max = Infinity) {
  let n = 0;
  for (const id of state.order) {
    const c = state.tools.get(id);
    if (c.needsTitle && !c.titled && !c.titleKey) {
      if (n++ >= max) return true;
      c.titleKey = c.name === "codemode" ? infoScriptKey(c.full) : infoCommandKey(c.full);
    }
    for (const sub of c.nested ?? []) {
      if (!sub.wants || sub.titleKey) continue;
      if (n++ >= max) return true;
      sub.titleKey = infoCommandKey(sub.full);
    }
  }
  return false;
}

// Whether bash-titles.json could name a call: some codemode call has no title of its own.
export function infoNeedsTitles(state) {
  return state.untitled > 0 || state.untitledNested > 0;
}

export function infoRunning(state) {
  return infoTools(state).filter((c) => c.running);
}

// When the latest tool call started (ms), or null.
export function infoLastCall(state) {
  const id = state.order.at(-1);
  return id ? state.tools.get(id).started ?? null : null;
}

// The files edits and writes touched, most changed first: { path, rel, added, removed }.
export function infoFiles(state) {
  return [...state.files].filter(([, d]) => d.added || d.removed)
    .map(([path, d]) => ({ path, rel: rel(path, state.cwd), added: d.added, removed: d.removed }))
    .sort((a, b) => b.added + b.removed - (a.added + a.removed) || a.rel.localeCompare(b.rel));
}

export const INFO_CATEGORIES = ["Code", "Tests", "Config", "Docs", "Styles"];

// A path's category, first match wins.
export function infoCategory(path) {
  const p = String(path), file = p.split("/").pop() ?? "";
  if (/(^|\/)(tests?|__tests__)\//.test(p) || /\.(test|spec)\.[^/]+$/.test(file) || /_test\.[^/]+$/.test(file)) return "Tests";
  if (/\.(md|mdx|txt)$/i.test(file) || /(^|\/)docs\//.test(p)) return "Docs";
  if (/\.(css|scss|less)$/i.test(file)) return "Styles";
  if (/\.(nix|json|toml|ya?ml|lock|ini)$/i.test(file) || /\.env/.test(file) || file.startsWith(".") || /(^|\/)layouts\//.test(p)) return "Config";
  return "Code";
}

// Lines per category, in the fixed order, without the empty ones; and the files touched.
export function infoLines(state) {
  const by = new Map(INFO_CATEGORIES.map((c) => [c, { category: c, files: 0, added: 0, removed: 0 }]));
  for (const [path, d] of state.files) {
    if (!d.added && !d.removed) continue;
    const row = by.get(infoCategory(path));
    row.files++; row.added += d.added; row.removed += d.removed;
  }
  const rows = [...by.values()].filter((r) => r.files);
  return { rows, files: rows.reduce((n, r) => n + r.files, 0) };
}

export const FIVE_HOURS = 5 * 3600 * 1000;
export const SEVEN_DAYS = 7 * 86400 * 1000;

// The normal pace: how much of a window has gone by (0–1), from when it resets; null when unknown.
export function infoPace(resetsAt, length, now = Date.now()) {
  if (typeof resetsAt !== "number" || !(length > 0)) return null;
  return Math.max(0, Math.min(1, 1 - (resetsAt - now) / length));
}

// ~/.pi/agent/claude-usage.json (herdr-session's) as the panel reads it. Utilization is 0–1;
// stale when the file is older than 10 minutes. Each window has its pace, how far usage
// is ahead of it (negative: under it), and the tokens left herdr-session estimated (`left`,
// null when it estimated nothing; `tokens` null until its fit has enough data).
export function infoUsage(record, now = Date.now()) {
  if (!record || (!record.fiveHour && !record.sevenDay)) return null;
  const stale = now - (record.at ?? 0) > 10 * 60 * 1000;
  const window = (w, length) => {
    if (!w || typeof w.utilization !== "number") return null;
    const resetsAt = typeof w.resetsAt === "number" ? w.resetsAt * 1000 : null;
    const pace = infoPace(resetsAt, length, now);
    const e = w.estimate;
    const left = e && typeof e === "object" ? { tokens: typeof w.tokensLeft === "number" ? w.tokensLeft : null, spread: e.spread ?? null, stretches: e.stretches ?? 0, needed: e.needed ?? 0 } : null;
    return { ratio: w.utilization, resetsAt, pace, ahead: pace === null ? null : w.utilization - pace, left };
  };
  return { at: record.at ?? null, stale, fiveHour: window(record.fiveHour, FIVE_HOURS), sevenDay: window(record.sevenDay, SEVEN_DAYS), overage: record.usingOverage === true, overageStatus: record.overageStatus ?? null };
}

// A window's tokens left as its row shows them: a short text and a one-sentence tooltip;
// null when nothing was estimated. `limit` names the window ("5-hour", "weekly").
export function infoTokensLeft(left, limit) {
  if (!left) return null;
  if (left.tokens === null) {
    return { text: "estimating…", tip: `Estimating the tokens left before the ${limit} limit: ${left.stretches} of the ${left.needed} stretches of 5 points it needs so far` };
  }
  const spread = left.spread === null ? "" : ` (±${Math.round(left.spread * 100)}%)`;
  return {
    text: `≈ ${infoTokens(left.tokens)} left`,
    tip: `About ${infoTokens(left.tokens)} tokens${spread} before the ${limit} limit, at the token mix of your last 5 hours, cache reads included, from ${left.stretches} stretches of your past usage`,
  };
}

// ---- Formatting ----------------------------------------------------------------------

// 412000 → "412k", 1400000 → "1.4M", 8600 → "8.6k" (one decimal under 10).
export function infoTokens(n) {
  if (n === null || n === undefined) return "—";
  const unit = (v, s) => `${v < 10 ? (Math.round(v * 10) / 10).toString() : Math.round(v)}${s}`;
  if (n >= 1_000_000) return unit(n / 1_000_000, "M");
  if (n >= 1000) return unit(n / 1000, "k");
  return String(n);
}

// 120 → "0.1s", 2400 → "2.4s", 242000 → "4m 02s", 3 h → "3h 05m".
export function infoDuration(msec) {
  if (msec === null || msec === undefined) return "";
  // Instant calls say nothing; the column keeps its width.
  if (msec < 100) return "";
  const s = msec / 1000;
  if (s < 60) return `${s < 10 ? (Math.round(s * 10) / 10).toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(Math.floor(s % 60)).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

// A span from now: "2h 10m", "4d", "35m"; for "in …" or "… ago".
export function infoSpan(msec) {
  const m = Math.max(0, Math.round(msec / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// The session's age: "3h", "2d", "12m".
export function infoAge(msec) {
  const m = Math.max(0, Math.floor(msec / 60000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}
