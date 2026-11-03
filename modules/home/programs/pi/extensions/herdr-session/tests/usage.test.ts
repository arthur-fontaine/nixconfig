import assert from "node:assert/strict";
import { test } from "node:test";
import { usageOf } from "../usage.ts";

test("the latest rate-limit diagnostic of a message is its usage", () => {
	const details = { unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: 1 } } };
	const message = { role: "assistant", diagnostics: [{ type: "claude-code.native-assistant.v1" }, { type: "claude-code.rate-limit", details }] };
	assert.deepEqual(usageOf(message), details);
	assert.equal(usageOf({ role: "assistant" }), undefined);
});
