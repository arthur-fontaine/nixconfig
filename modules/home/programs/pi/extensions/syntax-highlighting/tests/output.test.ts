import assert from "node:assert/strict";
import { test } from "node:test";
import { outputKind, styleLogLine, styleOutput } from "../output.ts";
import { fakePaint, markup, stripAnsi } from "./paint.ts";

const log = (line: string) => markup(styleLogLine(fakePaint(), line));

test("levels at the start of a line, after a time and tags", () => {
	assert.equal(log("2024-05-01T10:00:00Z [api] ERROR: boom"), "[dim:2024-05-01T10:00:00Z][output: [api] ][error:ERROR:][output: boom]");
	assert.equal(log("WARNING disk almost full"), "[warning:WARNING][output: disk almost full]");
	assert.equal(log("fatal: not a git repository"), "[error:fatal:][output: not a git repository]");
	assert.equal(log("error[E0382]: borrow of moved value"), "[error:error[E0382]:][output: borrow of moved value]");
	assert.equal(log("Tests PASSED"), "[output:Tests ][success:PASSED]");
	assert.equal(log("step 3 [FAIL] lint"), "[output:step 3 [][error:FAIL][output:] lint]");
	// Words inside a sentence are not levels.
	assert.equal(log("no error here"), "[output:no error here]");
});

test("HTTP requests, statuses, exit codes and addresses", () => {
	assert.equal(log("GET /health HTTP/1.1 200"), "[accent:GET][output: /health HTTP/1.1 ][success:200]");
	assert.equal(log("HTTP/2 404"), "[output:HTTP/2 ][error:404]");
	assert.equal(log("HTTP/1.1 301 Moved"), "[output:HTTP/1.1 ][warning:301][output: Moved]");
	assert.equal(log("Command exited with code 2"), "[output:Command exited with code ][error:2]");
	assert.equal(log("exit 0"), "[output:exit 0]");
	assert.equal(log("listening on 127.0.0.1:8080, not 1.2.3.4.5"), "[output:listening on ][accent:127.0.0.1:8080][output:, not 1.2.3.4.5]");
});

test("what kind of output it is", () => {
	assert.equal(outputKind(['{"a": [1, 2]}']), "json");
	assert.equal(outputKind(["[", "  1", "]"]), "json");
	assert.equal(outputKind(["{not json"]), "log");
	assert.equal(outputKind(["diff --git a/x.ts b/x.ts", "--- a/x.ts", "+++ b/x.ts", "@@ -1 +1 @@", "-a", "+b"]), "diff");
	assert.equal(outputKind(["@@ -1 +1 @@ but nothing else"]), "log");
});

test("JSON is highlighted as JSON", () => {
	const paint = fakePaint();
	const lines = ["{", '  "a": 1', "}"];
	assert.deepEqual(styleOutput(paint, lines).map(markup), ["[keyword:{]", '[output:  ][keyword:"a":][output: 1]', "[keyword:}]"]);
	assert.deepEqual(paint.calls, ['json:{\n  "a": 1\n}']);
});

test("a diff: headers, hunks counted from their header, code in the file's language", () => {
	const paint = fakePaint();
	const lines = [
		"commit abc",
		"diff --git a/x.ts b/x.ts",
		"index 1..2 100644",
		"--- a/x.ts",
		"+++ b/x.ts",
		"@@ -1,3 +1,3 @@ function f() {",
		" const a = 1;",
		"---- old",
		"+const b = 2;",
		"",
		"\\ No newline at end of file",
		"ERROR: after the diff",
	];
	assert.deepEqual(styleOutput(paint, lines).map(markup), [
		"[output:commit abc]",
		"[title:diff --git a/x.ts b/x.ts]",
		"[muted:index 1..2 100644]",
		"[title:--- a/x.ts]",
		"[title:+++ b/x.ts]",
		"[accent:@@ -1,3 +1,3 @@][muted: function f() {]",
		"[diffContext: ][keyword:const][diffContext: a = 1;]",
		"[diffRemoved:---- old]",
		"[diffAdded:+const b = 2;]",
		"",
		"[muted:\\ No newline at end of file]",
		"[error:ERROR:][output: after the diff]",
	]);
	assert.deepEqual(paint.calls, ["typescript:const a = 1;"]);
});

test("styled output keeps the text", () => {
	const samples = [["a\tb", "  x"], ['{"x": "y"}'], ["--- a/f", "+++ b/f", "@@ -1 +1 @@", "-x", "+y"]];
	for (const lines of samples) assert.deepEqual(styleOutput(fakePaint(), lines).map(stripAnsi), lines);
});
