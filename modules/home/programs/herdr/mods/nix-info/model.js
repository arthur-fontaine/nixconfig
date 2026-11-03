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
    default:
      return { ...base, kind: call.name, arg: firstLine(Object.values(a).find((v) => typeof v === "string") ?? "") };
  }
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

function countLines(state, call) {
  const a = call.arguments ?? {};
  if (!a.path) return;
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
    d = infoLineDiff(state.written.get(a.path) ?? "", a.content ?? "");
    state.written.set(a.path, a.content ?? "");
  }
  if (!d) return;
  const f = state.files.get(a.path) ?? { added: 0, removed: 0 };
  f.added += d.added; f.removed += d.removed;
  state.files.set(a.path, f);
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
    }
  } else if (m.role === "toolResult") {
    const call = state.tools.get(m.toolCallId);
    if (!call) return;
    call.error = m.isError === true;
    call.finished = ms(m.timestamp) ?? t;
    call.duration = typeof m.durationMs === "number" ? m.durationMs : call.finished - (call.started ?? t);
    const text = resultText(m.content);
    call.result = text.length > RESULT_CAP ? text.slice(0, RESULT_CAP) : text;
    call.resultCut = text.length > RESULT_CAP;
    // Lines count once the edit or write went through.
    if (!call.error) countLines(state, call.call);
    delete call.call;
  }
}

// ---- What the inspector keeps per call: capped, so hundreds of calls stay small ---------

// The stored text of one call's result (and of each long argument string) stops here.
export const RESULT_CAP = 64 * 1024;
const ARG_STRING_CAP = 16 * 1024;

function resultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b?.type === "text" ? b.text ?? "" : b?.type === "image" ? "[image]" : "")).join("\n");
}

// Arguments as given, long strings cut (a write's content, an edit's text).
export function infoCapValue(value) {
  if (typeof value === "string") return value.length > ARG_STRING_CAP ? `${value.slice(0, ARG_STRING_CAP)}…` : value;
  if (Array.isArray(value)) return value.map(infoCapValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, infoCapValue(v)]));
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

// The first `max` lines of a result, and how many more there are.
export function infoResultLines(text, max = 200) {
  const lines = String(text ?? "").replace(/\n$/, "").split("\n");
  return { lines: lines.slice(0, max), more: Math.max(0, lines.length - max) };
}

// "16:48:27.954", local time.
export function infoClock(msec) {
  if (!msec) return "—";
  const d = new Date(msec), p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
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

// Tool calls newest first; `running` = no result yet.
export function infoTools(state) {
  return state.order.slice().reverse().map((id) => {
    const c = state.tools.get(id);
    return { id: c.id, kind: c.kind, name: c.name, arg: c.arg, full: c.full ?? c.arg, path: c.path, started: c.started, duration: c.duration, error: c.error, running: c.duration === null,
      args: c.args, result: c.result, resultCut: c.resultCut, finished: c.finished };
  });
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

// ~/.pi/agent/claude-usage.json (herdr-session's) as the panel reads it. Utilization is 0–1;
// stale when the file is older than 10 minutes.
export function infoUsage(record, now = Date.now()) {
  if (!record || (!record.fiveHour && !record.sevenDay)) return null;
  const stale = now - (record.at ?? 0) > 10 * 60 * 1000;
  const window = (w) => (w && typeof w.utilization === "number"
    ? { ratio: w.utilization, resetsAt: typeof w.resetsAt === "number" ? w.resetsAt * 1000 : null }
    : null);
  return { at: record.at ?? null, stale, fiveHour: window(record.fiveHour), sevenDay: window(record.sevenDay), overage: record.usingOverage === true, overageStatus: record.overageStatus ?? null };
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
