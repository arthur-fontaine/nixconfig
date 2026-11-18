// Round 3c (brief-r3c.md), pure.
import assert from "node:assert/strict";
import { test } from "node:test";
import { infoContext, infoContextChart, infoFeed, infoNewSession } from "../model.js";

const line = (o) => JSON.stringify(o) + "\n";
const it = (type, input, read, write, model) => ({ type, input_tokens: input, cache_read_input_tokens: read, cache_creation_input_tokens: write, ...(model ? { model } : {}) });
// Pi's claude-code provider sums every API request of a turn into one usage; the carrier keeps them
// apart (iterations), the advisor's as "advisor_message". As in the info-nested session (0abb5d39).
const reply = (ts, usage, iterations) => line({ type: "message", id: ts, timestamp: ts, message: { role: "assistant", usage, content: [],
  ...(iterations ? { diagnostics: [{ type: "claude-code.native-assistant.v1", details: { carrier: { message: { usage: { iterations } } } } }] } : {}) } });

// ---- 4. the conversation's context, not a turn's sum ------------------------------------------

test("a turn that consulted the advisor: its context is the last request of the conversation, not the sum", () => {
  const s = infoNewSession("f");
  infoFeed(s, reply("2026-11-17T17:20:00Z", { input: 2, cacheRead: 276_000, cacheWrite: 2000, output: 10 })
    + reply("2026-11-17T17:23:29Z", { input: 4, cacheRead: 553_830, cacheWrite: 3778, output: 302 },
      [it("message", 2, 275_543, 2744), it("advisor_message", 281_430, 0, 0, "claude-fable-5-2"), it("message", 2, 278_287, 1034)]));
  assert.equal(s.requests.at(-1).context, 279_323);
  assert.equal(infoContext(s).used, 279_323);
  assert.equal(infoContextChart(s).ceiling, "peak 279k");
});

test("a turn without iterations keeps its usage as its context", () => {
  const s = infoNewSession("f");
  infoFeed(s, reply("2026-11-17T17:20:00Z", { input: 3, cacheRead: 100, cacheWrite: 7, output: 1 }));
  assert.equal(s.requests.at(-1).context, 110);
});
