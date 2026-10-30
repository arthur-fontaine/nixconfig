import assert from "node:assert/strict";
import { test } from "node:test";
import { withoutOnboarding } from "../lines.ts";

const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;

test("drops the onboarding paragraph and the blank line above it", () => {
	const lines = [" π  ctrl+c interrupt", dim(" Press ctrl+o to show full startup help."), "", dim(" Pi can explain its own features and look up"), dim(" its docs. Ask it how to use or extend Pi.")];
	assert.deepEqual(withoutOnboarding(lines), lines.slice(0, 2));
});

test("keeps what follows the paragraph", () => {
	const lines = ["logo", "", dim("Pi can explain its own features and look up its docs."), "", "more"];
	assert.deepEqual(withoutOnboarding(lines), ["logo", "", "more"]);
});

test("leaves a header without it unchanged", () => {
	const lines = ["logo", "hints"];
	assert.deepEqual(withoutOnboarding(lines), lines);
});
