import assert from "node:assert/strict";
import test from "node:test";
import { infoRowTime, infoCallMeta, infoNewSession, infoFeed, infoTools } from "../model.js";

test("the call view of a running call counts too; without a marker it says Running", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  assert.equal(infoCallMeta({ ranFrom: now - 12_340 }, "running", null, now), "Running for 12.3s");
  assert.equal(infoCallMeta({ ranFrom: null }, "running", null, now), "Running");
});

const now = Date.parse("2026-11-18T12:00:00Z");

test("a running call's time column is its elapsed time to the tenth, from its start marker", () => {
  assert.equal(infoRowTime({ ranFrom: now - 12_340 }, "running", now), "12.3s");
  assert.equal(infoRowTime({ ranFrom: now - 40 }, "running", now), "0.0s");
  assert.equal(infoRowTime({ ranFrom: now - 65_250 }, "running", now), "1m 05.2s");
  assert.equal(infoRowTime({ ranFrom: now + 500 }, "running", now), "0.0s");
});

test("without a marker it says \"running\", never the message's time; done and stopped unchanged", () => {
  assert.equal(infoRowTime({ started: now - 20_000, ranFrom: null }, "running", now), "running");
  assert.equal(infoRowTime({ duration: 3100 }, "done", now), "3.1s");
  assert.equal(infoRowTime({ duration: null }, "no-result", now), "stopped");
});

test("the call-start entry reaches the call, before or after its message", () => {
  const msg = { type: "message", timestamp: new Date(now - 20_000).toISOString(), message: { role: "assistant", timestamp: now - 20_000, content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "sleep 9" } }] } };
  const mark = { type: "custom", customType: "call-start", timestamp: new Date(now - 3_000).toISOString(), data: { toolCallId: "t1", at: now - 3_000 } };
  for (const lines of [[msg, mark], [mark, msg]]) {
    const s = infoNewSession();
    infoFeed(s, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const c = infoTools(s).find((x) => x.id === "t1");
    assert.equal(c.ranFrom, now - 3_000);
    assert.equal(c.started, now - 20_000);
    assert.equal(infoRowTime(c, "running", now), "3.0s");
  }
});
