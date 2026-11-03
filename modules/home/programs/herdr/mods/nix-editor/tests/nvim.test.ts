import assert from "node:assert/strict";
import { test } from "node:test";

import { NvimDecoder, NvimHandle, nvimBase64, nvimBase64Decode, nvimConnection, nvimDecode, nvimEncode, nvimUtf8Decode, nvimUtf8Encode } from "../nvim.js";

const roundTrip = (v: unknown) => nvimDecode(Uint8Array.from(nvimEncode(v)));

test("scalars survive a round trip at every width", () => {
  for (const v of [null, true, false, 0, 1, 127, 128, 255, 256, 65535, 65536, 4294967295, 4294967296, 2 ** 53 - 1,
    -1, -32, -33, -128, -129, -32768, -32769, -2147483648, -2147483649, -(2 ** 53 - 1), 1.5, -0.25, 1e300]) {
    assert.equal(roundTrip(v), v, String(v));
  }
});

test("strings are UTF-8 at every length, surrogate pairs included", () => {
  for (const s of ["", "a", "é", "日本", "😀 ok", "x".repeat(31), "x".repeat(32), "y".repeat(300), "z".repeat(70000)]) {
    assert.equal(roundTrip(s), s);
    assert.equal(nvimUtf8Decode(Uint8Array.from(nvimUtf8Encode(s))), s);
    assert.deepEqual(nvimUtf8Encode(s), [...Buffer.from(s, "utf8")]);
  }
});

test("arrays, maps, bin and handles", () => {
  const v = { a: [1, "two", [3, null]], big: Array.from({ length: 20 }, (_, i) => i), m: { x: true } };
  assert.deepEqual(roundTrip(v), v);
  assert.deepEqual(roundTrip(new Uint8Array([0, 1, 255])), new Uint8Array([0, 1, 255]));
  const h = roundTrip([new NvimHandle(0, 1), new NvimHandle(1, 1000), new NvimHandle(2, 70000)]) as NvimHandle[];
  assert.deepEqual(h.map((x) => [x.type, x.id]), [[0, 1], [1, 1000], [2, 70000]]);
});

test("decodes Neovim's own float32 and fixext encodings", () => {
  assert.equal(nvimDecode(Uint8Array.from([0xca, 0x3f, 0xc0, 0x00, 0x00])), 1.5);
  // Window 1001 as fixext2 type 1 with a uint16 payload would not fit; Neovim sends cd 03 e9 in ext 3 bytes.
  const win = nvimDecode(Uint8Array.from([0xc7, 3, 1, 0xcd, 0x03, 0xe9])) as NvimHandle;
  assert.deepEqual([win.type, win.id], [1, 1001]);
});

test("a stream split anywhere yields whole messages, in order", () => {
  const messages = [[2, "redraw", [["grid_line", [1, 0, 0, [["héllo", 1, 3]], false]], ["flush"]]], [1, 7, null, "ok"], [2, "herdr_status", [{ file: "/a.ts", errors: 2 }]]];
  const bytes = messages.flatMap((m) => nvimEncode(m));
  for (const size of [1, 2, 3, 7, 64]) {
    const d = new NvimDecoder();
    const got: unknown[] = [];
    for (let i = 0; i < bytes.length; i += size) got.push(...d.feed(Uint8Array.from(bytes.slice(i, i + size))));
    assert.deepEqual(got, messages, `chunks of ${size}`);
  }
});

test("base64 matches Node's", () => {
  for (const n of [0, 1, 2, 3, 4, 5, 100]) {
    const b = Array.from({ length: n }, (_, i) => (i * 37) & 255);
    assert.equal(nvimBase64(b), Buffer.from(b).toString("base64"));
  }
});

test("base64 decodes what it encodes, at every padding", () => {
  const bytes = Uint8Array.from({ length: 300 }, (_, i) => (i * 37) % 256);
  for (const n of [0, 1, 2, 3, 4, 299, 300]) {
    assert.deepEqual([...nvimBase64Decode(nvimBase64(bytes.subarray(0, n)))], [...bytes.subarray(0, n)]);
  }
});

// A bridge in memory: /send's bytes come back from /recv as nvim's answers.
function fakeBridge(answer: (message: unknown[]) => unknown[] | null) {
  const out: number[] = [];
  const sent: string[] = [];
  let wake: (() => void) | null = null;
  const reply = (status: number, text: string) => Promise.resolve({ status, text: () => Promise.resolve(text) });
  const post = (url: string, options: { body: string }) => {
    const route = url.split("/").pop();
    const body = JSON.parse(options.body);
    sent.push(route!);
    if (route === "send") {
      const decoder = new NvimDecoder();
      for (const m of decoder.feed(nvimBase64Decode(body.data))) {
        const r = answer(m as unknown[]);
        if (r) out.push(...nvimEncode(r));
      }
      wake?.();
      return reply(200, "{\"ok\":true}");
    }
    if (route === "recv") {
      if (out.length) return reply(200, nvimBase64(out.splice(0)));
      return new Promise((resolve) => { wake = () => { wake = null; resolve(reply(200, nvimBase64(out.splice(0)))); }; });
    }
    if (route === "close") { wake = null; return reply(200, "{\"ok\":true}"); }
    return reply(404, "");
  };
  return { post, sent };
}

test("a connection answers requests through /send and /recv, in order", async () => {
  const bridge = fakeBridge((m) => (m[0] === 0 ? [1, m[1], null, `${m[2]}:${(m[3] as unknown[]).join(",")}`] : null));
  const c = nvimConnection({ config: { http: 1, token: "t" }, id: "x", post: bridge.post, onRedraw: () => {}, onNotify: () => {} });
  c.pump();
  const [a, b] = await Promise.all([c.request("one", 1), c.request("two", 2)]);
  assert.equal(a, "one:1");
  assert.equal(b, "two:2");
  c.close();
});

test("a connection hands redraws and notifications on, and ends on 410", async () => {
  const seen: string[] = [];
  let ended!: () => void;
  const done = new Promise<void>((r) => { ended = r; });
  const queue = [nvimBase64(nvimEncode([2, "redraw", [["flush"]]])), nvimBase64(nvimEncode([2, "herdr_status", [{ file: "a" }]]))];
  const post = (url: string) => {
    const route = url.split("/").pop();
    if (route !== "recv") return Promise.resolve({ status: 200, text: () => Promise.resolve("{}") });
    const next = queue.shift();
    return Promise.resolve(next ? { status: 200, text: () => Promise.resolve(next) } : { status: 410, text: () => Promise.resolve("") });
  };
  const c = nvimConnection({ config: { http: 1, token: "t" }, id: "x", post,
    onRedraw: (e: unknown[]) => seen.push(`redraw ${JSON.stringify(e)}`),
    onNotify: (name: string) => { seen.push(name); if (name === "nvim_closed") ended(); } });
  c.pump();
  await done;
  assert.deepEqual(seen, ['redraw [["flush"]]', "herdr_status", "nvim_closed"]);
  await assert.rejects(c.request("late"), /closed/);
});
