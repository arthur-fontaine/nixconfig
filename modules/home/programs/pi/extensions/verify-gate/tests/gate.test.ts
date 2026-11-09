// Run: node --test 'modules/home/programs/pi/extensions/verify-gate/tests/*.test.ts'
import assert from "node:assert/strict";
import { test } from "node:test";
import { Gate, onlyLooks, reminderText } from "../gate.ts";

test("reading, searching and committing only look", () => {
	assert.equal(onlyLooks("rg -n foo src | head -20"), true);
	assert.equal(onlyLooks("cd app && git diff --stat && git add -A && git commit -m x"), true);
	assert.equal(onlyLooks("sed -n 1,40p a.swift; wc -l a.swift"), true);
	assert.equal(onlyLooks("FOO=1 cat x"), true);
});

test("builds, tests, the program and requests are checks", () => {
	assert.equal(onlyLooks("pnpm test"), false);
	assert.equal(onlyLooks("cd ios && xcodebuild -scheme App build | tail -5"), false);
	assert.equal(onlyLooks("xcrun devicectl device capture screenshot --device X --destination a.png"), false);
	assert.equal(onlyLooks("curl -fsS localhost:3000/health"), false);
	assert.equal(onlyLooks("./bin/tool --dry-run"), false);
	assert.equal(onlyLooks("git push"), false);
});

test("a heredoc's body isn't read as commands", () => {
	assert.equal(onlyLooks("cat > a.txt <<'EOF'\npnpm test\nEOF"), true);
	assert.equal(onlyLooks("python3 - <<'EOF'\nprint(1)\nEOF"), false);
});

test("a change with nothing run after it gets one reminder naming the files", () => {
	const gate = new Gate();
	gate.record("read", undefined, undefined);
	gate.record("edit", undefined, ["a.ts"]);
	gate.record("bash", "git diff", undefined);
	assert.deepEqual(gate.reminder(), ["a.ts"]);
	assert.equal(gate.reminder(), undefined, "only once per run");
});

test("a check after the last change means no reminder", () => {
	const gate = new Gate();
	gate.record("edit", undefined, ["a.ts"]);
	gate.record("bash", "pnpm test", undefined);
	assert.equal(gate.reminder(), undefined);
});

test("a change after the check brings the reminder back", () => {
	const gate = new Gate();
	gate.record("bash", "pnpm test", undefined);
	gate.record("edit", undefined, ["a.ts"]);
	gate.record("bash", "python3 fix.py", ["b.ts"]);
	assert.equal(gate.reminder(), undefined, "the script that changed b.ts also ran something");
	gate.record("write", undefined, ["c.ts"]);
	assert.deepEqual(gate.reminder(), ["a.ts", "b.ts", "c.ts"]);
});

test("no change, no reminder", () => {
	const gate = new Gate();
	gate.record("bash", "rg x", undefined);
	assert.equal(gate.reminder(), undefined);
});

test("the reminder names a few files and leaves a way out", () => {
	const text = reminderText(Array.from({ length: 10 }, (_, i) => `f${i}.ts`));
	assert.match(text, /f0\.ts, .*f7\.ts, and 2 more/);
	assert.match(text, /run-and-verify/);
	assert.match(text, /not verified/);
});
