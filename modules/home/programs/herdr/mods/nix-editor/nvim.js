// The editor's backend: `nvim --embed` reached through the local bridge (lsp-bridge/
// bridge.js), spoken to in msgpack-RPC as GUI frontends do. Joined into main.js by the
// nix bundle, so nothing here imports local files; names are prefixed to stay apart from
// main.js's. Runtime: "fs/promises" and the global fetch. Not "net": Herdr's script
// runtime crashes with a socket read pending under load, fetch holds up.
import * as nvimFs from "fs/promises";

// --- UTF-8 and base64 (the runtime has no TextEncoder, TextDecoder or btoa) -----------

export function nvimUtf8Encode(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

export function nvimUtf8Decode(bytes, start = 0, end = bytes.length) {
  let s = "";
  for (let i = start; i < end;) {
    const b = bytes[i++];
    let c;
    if (b < 0x80) c = b;
    else if (b < 0xe0) c = ((b & 31) << 6) | (bytes[i++] & 63);
    else if (b < 0xf0) c = ((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    else c = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    if (c >= 0x10000) { c -= 0x10000; s += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 1023)); }
    else s += String.fromCharCode(c);
  }
  return s;
}

const NVIM_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
export function nvimBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    s += NVIM_B64[(n >> 18) & 63] + NVIM_B64[(n >> 12) & 63]
      + (i + 1 < bytes.length ? NVIM_B64[(n >> 6) & 63] : "=") + (i + 2 < bytes.length ? NVIM_B64[n & 63] : "=");
  }
  return s;
}

const NVIM_B64_INDEX = new Uint8Array(128);
for (let i = 0; i < 64; i++) NVIM_B64_INDEX[NVIM_B64.charCodeAt(i)] = i;
export function nvimBase64Decode(text) {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const n = (NVIM_B64_INDEX[clean.charCodeAt(i)] << 18) | (NVIM_B64_INDEX[clean.charCodeAt(i + 1)] << 12)
      | (NVIM_B64_INDEX[clean.charCodeAt(i + 2)] << 6) | NVIM_B64_INDEX[clean.charCodeAt(i + 3)];
    out[o++] = n >> 16;
    if (i + 2 < clean.length) out[o++] = (n >> 8) & 255;
    if (i + 3 < clean.length) out[o++] = n & 255;
  }
  return out;
}

// --- msgpack ---------------------------------------------------------------------------

// A Buffer, Window or Tabpage handle (ext types 0, 1, 2), as Neovim sends and takes them.
export class NvimHandle {
  constructor(type, id) { this.type = type; this.id = id; }
}

export function nvimEncode(value) {
  const out = [];
  const u16 = (n) => out.push((n >> 8) & 255, n & 255);
  const u32 = (n) => out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
  const bytes = (b) => { for (const x of b) out.push(x); };
  const int = (n) => {
    if (n >= 0) {
      if (n < 128) out.push(n);
      else if (n < 256) out.push(0xcc, n);
      else if (n < 65536) { out.push(0xcd); u16(n); }
      else if (n < 4294967296) { out.push(0xce); u32(n); }
      else { out.push(0xcf); u32(Math.floor(n / 4294967296)); u32(n >>> 0); }
    } else if (n >= -32) out.push(n & 255);
    else if (n >= -128) out.push(0xd0, n & 255);
    else if (n >= -32768) { out.push(0xd1); u16(n & 65535); }
    else if (n >= -2147483648) { out.push(0xd2); u32(n >>> 0); }
    else { out.push(0xd3); const hi = Math.floor(n / 4294967296); u32(hi >>> 0); u32((n - hi * 4294967296) >>> 0); }
  };
  const ext = (type, payload) => {
    const n = payload.length;
    const fixed = { 1: 0xd4, 2: 0xd5, 4: 0xd6, 8: 0xd7, 16: 0xd8 }[n];
    if (fixed) out.push(fixed, type);
    else if (n < 256) out.push(0xc7, n, type);
    else if (n < 65536) { out.push(0xc8); u16(n); out.push(type); }
    else { out.push(0xc9); u32(n); out.push(type); }
    bytes(payload);
  };
  const walk = (v) => {
    if (v === null || v === undefined) out.push(0xc0);
    else if (v === false) out.push(0xc2);
    else if (v === true) out.push(0xc3);
    else if (typeof v === "number") {
      if (Number.isSafeInteger(v)) int(v);
      else { out.push(0xcb); const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, v); bytes(new Uint8Array(dv.buffer)); }
    } else if (typeof v === "string") {
      const b = nvimUtf8Encode(v), n = b.length;
      if (n < 32) out.push(0xa0 | n);
      else if (n < 256) out.push(0xd9, n);
      else if (n < 65536) { out.push(0xda); u16(n); }
      else { out.push(0xdb); u32(n); }
      bytes(b);
    } else if (v instanceof Uint8Array) {
      const n = v.length;
      if (n < 256) out.push(0xc4, n);
      else if (n < 65536) { out.push(0xc5); u16(n); }
      else { out.push(0xc6); u32(n); }
      bytes(v);
    } else if (v instanceof NvimHandle) ext(v.type, nvimEncode(v.id));
    else if (Array.isArray(v)) {
      const n = v.length;
      if (n < 16) out.push(0x90 | n);
      else if (n < 65536) { out.push(0xdc); u16(n); }
      else { out.push(0xdd); u32(n); }
      for (const x of v) walk(x);
    } else if (typeof v === "object") {
      const keys = Object.keys(v).filter((k) => v[k] !== undefined), n = keys.length;
      if (n < 16) out.push(0x80 | n);
      else if (n < 65536) { out.push(0xde); u16(n); }
      else { out.push(0xdf); u32(n); }
      for (const k of keys) { walk(k); walk(v[k]); }
    } else throw new Error(`msgpack: cannot encode ${typeof v}`);
  };
  walk(value);
  return out;
}

const NVIM_MORE = { more: true };

// Decodes one value at `pos`; throws NVIM_MORE when the bytes end mid-value.
function nvimDecodeAt(b, pos) {
  let p = pos;
  const need = (n) => { if (p + n > b.length) throw NVIM_MORE; };
  const u8 = () => { need(1); return b[p++]; };
  const u16 = () => { need(2); const v = (b[p] << 8) | b[p + 1]; p += 2; return v; };
  const u32 = () => { need(4); const v = ((b[p] << 24) >>> 0) + ((b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]); p += 4; return v; };
  const float = (n) => { need(n); const dv = new DataView(b.buffer, b.byteOffset + p, n); p += n; return n === 4 ? dv.getFloat32(0) : dv.getFloat64(0); };
  const str = (n) => { need(n); const s = nvimUtf8Decode(b, p, p + n); p += n; return s; };
  const bin = (n) => { need(n); const v = b.slice(p, p + n); p += n; return v; };
  const arr = (n) => { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = value(); return a; };
  const map = (n) => { const m = {}; for (let i = 0; i < n; i++) { const k = value(); m[k] = value(); } return m; };
  const ext = (n) => {
    const type = u8(); need(n);
    const payload = b.subarray(p, p + n); p += n;
    // Neovim's handles carry their id as a msgpack integer.
    return type <= 2 ? new NvimHandle(type, nvimDecodeAt(payload, 0).value) : { ext: type, data: payload.slice() };
  };
  const value = () => {
    const t = u8();
    if (t < 0x80) return t;
    if (t < 0x90) return map(t & 15);
    if (t < 0xa0) return arr(t & 15);
    if (t < 0xc0) return str(t & 31);
    if (t >= 0xe0) return t - 256;
    switch (t) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return bin(u8());
      case 0xc5: return bin(u16());
      case 0xc6: return bin(u32());
      case 0xc7: return ext(u8());
      case 0xc8: return ext(u16());
      case 0xc9: return ext(u32());
      case 0xca: return float(4);
      case 0xcb: return float(8);
      case 0xcc: return u8();
      case 0xcd: return u16();
      case 0xce: return u32();
      case 0xcf: { const hi = u32(), lo = u32(); return hi * 4294967296 + lo; }
      case 0xd0: { const v = u8(); return v > 127 ? v - 256 : v; }
      case 0xd1: { const v = u16(); return v > 32767 ? v - 65536 : v; }
      case 0xd2: { const v = u32(); return v > 2147483647 ? v - 4294967296 : v; }
      case 0xd3: { const hi = u32(), lo = u32(); return (hi > 2147483647 ? hi - 4294967296 : hi) * 4294967296 + lo; }
      case 0xd4: return ext(1);
      case 0xd5: return ext(2);
      case 0xd6: return ext(4);
      case 0xd7: return ext(8);
      case 0xd8: return ext(16);
      case 0xd9: return str(u8());
      case 0xda: return str(u16());
      case 0xdb: return str(u32());
      case 0xdc: return arr(u16());
      case 0xdd: return arr(u32());
      case 0xde: return map(u16());
      case 0xdf: return map(u32());
      default: throw new Error(`msgpack: bad byte 0x${t.toString(16)}`);
    }
  };
  return { value: value(), end: p };
}

export function nvimDecode(bytes) {
  return nvimDecodeAt(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes), 0).value;
}

// A stream of msgpack values arriving in chunks of any size.
export class NvimDecoder {
  constructor() { this.buf = new Uint8Array(0); }
  // The complete values the bytes so far hold; the rest waits for the next chunk.
  feed(chunk) {
    if (chunk.length) {
      const joined = new Uint8Array(this.buf.length + chunk.length);
      joined.set(this.buf); joined.set(chunk, this.buf.length);
      this.buf = joined;
    }
    const values = [];
    let pos = 0;
    while (pos < this.buf.length) {
      let r;
      try { r = nvimDecodeAt(this.buf, pos); } catch (e) { if (e === NVIM_MORE) break; throw e; }
      values.push(r.value);
      pos = r.end;
    }
    if (pos) this.buf = this.buf.slice(pos);
    return values;
  }
}

// --- RPC over the bridge -----------------------------------------------------------------

// No `async` from here on: Herdr's script runtime frees closures made inside an async
// function once it returns (they crash Herdr when called later), and a connection's
// closures live as long as the editor. So these are promise chains, and a connection's
// state lives on its object.

// The bridge's token and ports, written by the bridge at its start.
function nvimBridgeConfig(home, readFile) {
  return readFile(`${home}/.config/herdr-app/lsp-bridge.json`, "utf8").then((text) => JSON.parse(text)).catch(() => null);
}

// A POST to the bridge's HTTP side: the token and `body` as JSON.
function nvimPost(config, route, body, post) {
  return post(`http://127.0.0.1:${config.http}/${route}`, { method: "POST", body: JSON.stringify({ token: config.token, ...body }) })
    .then((r) => r.text().then((text) => ({ status: r.status, text })));
}

// The RPC session with the nvim the bridge runs as `id`. `onRedraw(batches)` gets each
// "redraw" notification's arguments; `onNotify(method, args)` the others (rpcnotify(0, …)
// from init.lua, and "nvim_closed" when the process ends).
export function nvimConnection({ config, id, post, onRedraw, onNotify }) {
  const c = { closed: false, nextId: 1, pending: new Map(), queued: [], sending: false, decoder: new NvimDecoder() };
  // Messages go out in order; those queued while a request is out go together in the next.
  c.flush = () => {
    if (c.sending || c.closed || !c.queued.length) return;
    const data = nvimBase64(c.queued);
    c.queued = [];
    c.sending = true;
    nvimPost(config, "send", { id, data }, post).catch(() => null).then(() => { c.sending = false; c.flush(); });
  };
  c.send = (message) => {
    for (const b of nvimEncode(message)) c.queued.push(b);
    c.flush();
  };
  c.request = (method, ...args) => {
    if (c.closed) return Promise.reject(new Error("nvim is closed"));
    const n = c.nextId++;
    return new Promise((resolve, reject) => { c.pending.set(n, { resolve, reject }); c.send([0, n, method, args]); });
  };
  c.notify = (method, ...args) => { if (!c.closed) c.send([2, method, args]); };
  c.handle = (message) => {
    const kind = message[0];
    if (kind === 1) {
      const p = c.pending.get(message[1]);
      if (!p) return;
      c.pending.delete(message[1]);
      const error = message[2];
      if (error) p.reject(new Error(Array.isArray(error) ? String(error[1]) : String(error)));
      else p.resolve(message[3]);
    } else if (kind === 2) {
      if (message[1] === "redraw") onRedraw?.(message[2]);
      else onNotify?.(message[1], message[2]);
    } else if (kind === 0) {
      // Neovim asking us something (rpcrequest): nothing is served here.
      c.send([1, message[1], [0, `herdr: ${message[2]} is not supported`], null]);
    }
  };
  c.finish = () => {
    if (c.ended) return;
    c.ended = c.closed = true;
    for (const p of c.pending.values()) p.reject(new Error("nvim is closed"));
    c.pending.clear();
    onNotify?.("nvim_closed", []);
  };
  // One /recv out at a time; each answer is handled, then the next asked for.
  c.pump = () => {
    if (c.closed) return c.finish();
    nvimPost(config, "recv", { id }, post).then((r) => {
      if (r.status === 410) return c.finish();
      if (r.status !== 200) throw new Error(`the bridge answered ${r.status}`);
      if (r.text) for (const m of c.decoder.feed(nvimBase64Decode(r.text))) c.handle(m);
      c.pump();
    }).catch((e) => { onNotify?.("nvim_error", [String(e?.message ?? e)]); c.finish(); });
  };
  c.input = (keys) => c.notify("nvim_input", keys);
  c.inputMouse = (button, action, modifier, grid, row, col) => c.notify("nvim_input_mouse", button, action, modifier, grid, row, col);
  c.resize = (w, h) => c.notify("nvim_ui_try_resize", w, h);
  c.close = () => { c.closed = true; nvimPost(config, "close", { id }, post).catch(() => null); };
  return c;
}

// Starts `nvim --embed` for `file` in `cwd`, attaches a `width`×`height` UI and opens the
// file: the connection, or null when the bridge or nvim isn't there. `home` is Herdr's
// home() (where the bridge's config and init.lua live); `post` (fetch) and `readFile` are
// for tests.
export function startNvim({ file, cwd, width, height, onRedraw, onNotify, home, appHome, config = "init.lua",
  post = (url, options) => fetch(url, options), readFile = nvimFs.readFile }) {
  // init.lua for the editor, diff.lua for nix-diff's editable diff, in Herdr's own home
  // (HERDR_APP_HOME's when set: a test window has its own).
  const init = `${appHome ?? `${home}/.config/herdr-app`}/nix-editor/${config}`;
  return nvimBridgeConfig(home, readFile).then((config) => {
    if (!config?.token || !config.http) return null;
    return nvimPost(config, "run", { cwd, cmd: ["nvim", "--embed", "-n", "-i", "NONE", "-u", init] }, post).then((r) => {
      const answer = JSON.parse(r.text);
      if (!answer.ok) return null;
      const c = nvimConnection({ config, id: answer.id, post, onRedraw, onNotify });
      c.pump();
      // ext_messages and ext_cmdline: no message area and so no hit-enter prompt; the view
      // shows messages in its status strip and the cmdline as its own line. ext_multigrid:
      // each window is its own grid, so the view draws floats (hover, diagnostics) itself.
      return c.request("nvim_ui_attach", width, height, { ext_linegrid: true, ext_multigrid: true, ext_popupmenu: true, ext_messages: true, ext_cmdline: true, ext_hlstate: false, rgb: true })
        .then(() => (file ? c.request("nvim_cmd", { cmd: "edit", args: [file] }, {}) : null))
        .then(() => c, (e) => { c.close(); throw e; });
    });
  }).catch(() => null);
}
