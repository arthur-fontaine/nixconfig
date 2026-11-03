import assert from "node:assert/strict";
import { test } from "node:test";

import { NvimDecoder, NvimHandle, nvimBase64, nvimDecode, nvimEncode, nvimUtf8Decode, nvimUtf8Encode } from "../nvim.js";

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
