import assert from "node:assert/strict";
import test from "node:test";
import { infoMeterRight } from "../model.js";

const now = 1_800_000_000_000, MIN = 60_000, H = 60 * MIN;

test("a limit meter's right side gives the gap to a steady pace, then the reset", () => {
  assert.equal(infoMeterRight({ resetsAt: now + 1 * H + 59 * MIN, ahead: 0.13 }, "five", { now }), "13% ahead · resets in 1h 59m");
  assert.equal(infoMeterRight({ resetsAt: now + 3 * 24 * H, ahead: -0.04 }, "week", { now }), "4% behind · resets in 3 days");
});

test("no gap shown when on pace, unknown, or the figure can't be vouched for", () => {
  assert.equal(infoMeterRight({ resetsAt: now + 2 * H, ahead: 0.004 }, "five", { now }), "resets in 2h");
  assert.equal(infoMeterRight({ resetsAt: now + 2 * H, ahead: null }, "five", { now }), "resets in 2h");
  assert.equal(infoMeterRight({ resetsAt: now + 2 * H, ahead: 0.13 }, "five", { now, staleFor: 12 * MIN }), "updated 12m ago");
  assert.equal(infoMeterRight({ resetsAt: now - 5 * MIN, ahead: 0.13 }, "five", { now }), "reset 5m ago");
});
