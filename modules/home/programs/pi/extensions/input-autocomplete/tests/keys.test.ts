import assert from "node:assert/strict";
import { test } from "node:test";
import { type Arrival, arbitrate, cycle } from "../keys.ts";

test("cycle: Down wraps around, and needs a second suggestion", () => {
	assert.equal(cycle("next", 5, 0), 1);
	assert.equal(cycle("next", 5, 4), 0);
	assert.equal(cycle("next", 1, 0), undefined);
	assert.equal(cycle("next", 0, 0), undefined);
});

test("cycle: Up goes back, and leaves the first one to the history", () => {
	assert.equal(cycle("previous", 5, 3), 2);
	assert.equal(cycle("previous", 5, 0), undefined);
	assert.equal(cycle(undefined, 5, 2), undefined);
});

const key = (fields: Partial<Arrival>): Arrival => ({ idle: true, cycles: false, entersList: false, leavesList: false, ...fields });

test("arbitrate: the suggestions take Down and Up before FleetView", () => {
	assert.equal(arbitrate(key({ cycles: true, entersList: true })), "take");
	assert.equal(arbitrate(key({ cycles: true })), "take");
});

test("arbitrate: Down with nothing to cycle, and Left, go to FleetView", () => {
	assert.equal(arbitrate(key({ entersList: true })), "yield");
});

test("arbitrate: Escape brings the suggestions back", () => {
	assert.equal(arbitrate(key({ leavesList: true })), "return");
});

test("arbitrate: other keys, and any key away from an empty focused prompt, pass", () => {
	assert.equal(arbitrate(key({})), undefined);
	assert.equal(arbitrate(key({ idle: false, cycles: true, entersList: true })), undefined);
	assert.equal(arbitrate(key({ idle: false, leavesList: true })), undefined);
});
