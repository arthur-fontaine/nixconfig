import assert from "node:assert/strict";
import { test } from "node:test";
import { escapes, sliceVisible, spliceVisible } from "../ansi.ts";
import { overlay } from "../overlay.ts";
import { fakePaint, markup, stripAnsi } from "./paint.ts";

const paint = fakePaint();
const title = (text: string) => paint.fg("toolTitle", `\x1b[1m${text}\x1b[22m`);
const out = (text: string) => paint.fg("toolOutput", text);

test("slicing keeps the styles in effect at the start", () => {
	const line = `${paint.fg("syntaxFunction", "git")} ${paint.fg("syntaxType", "--short")}`;
	assert.equal(markup(sliceVisible(line, 6, 10)), "[type:shor]");
	assert.equal(stripAnsi(sliceVisible(line, 0, 3)), "git");
});

test("splicing restores the line's own styles after the replacement", () => {
	const line = `${title("$ ls")}${paint.fg("muted", " (timeout 5s)")}  `;
	const spliced = spliceVisible(line, 2, 4, paint.fg("syntaxFunction", "ls"));
	assert.equal(stripAnsi(spliced), "$ ls (timeout 5s)  ");
	assert.equal(markup(spliced), "[title:$ ][function:ls][muted: (timeout 5s)]  ");
	// The title's bold doesn't reach the replacement, and comes back after it only if it was on.
	assert.ok(escapes(spliced).indexOf("\x1b[22;23;24;27;29m") < escapes(spliced).indexOf("\x1b[38;5;115m"));
});

test("a command is recolored where the renderer drew it, around its prompt and suffix", () => {
	const doc = { plain: ["git status --short"], styled: [`${paint.fg("syntaxFunction", "git")}${paint.fg("toolTitle", " status ")}${paint.fg("syntaxType", "--short")}`] };
	const drawn = [`${title("$ git status --short")}${paint.fg("muted", " (timeout 5s)")}   `];
	const lead = { text: "$ ", styled: paint.fg("bashMode", "$") + " " };
	const [line] = overlay(drawn, doc, { match: "run", lead });
	assert.equal(stripAnsi(line!), stripAnsi(drawn[0]!));
	assert.equal(markup(line!), "[bashMode:$] [function:git][title: status ][type:--short][muted: (timeout 5s)]   ");
});

test("a wrapped multi-line command is followed across lines", () => {
	const doc = {
		plain: ["echo aaaa bbbb", "", "ls -la"],
		styled: [`${paint.fg("syntaxFunction", "echo")}${paint.fg("toolTitle", " aaaa bbbb")}`, "", `${paint.fg("syntaxFunction", "ls")} ${paint.fg("syntaxType", "-la")}`],
	};
	// As Pi's Text wraps it at 10 columns: the break's space dropped, styles reopened.
	const drawn = [title("$ echo aaaa"), title("bbbb"), "", title("ls -la"), paint.fg("muted", "Took 1.0s")];
	assert.deepEqual(overlay(drawn, doc, { match: "run" }).map(markup), [
		"[title:$ ][function:echo][title: aaaa]",
		"[title:bbbb]",
		"",
		"[function:ls] [type:-la]",
		"[muted:Took 1.0s]",
	]);
});

test("output lines are recolored only when drawn as plain output", () => {
	const doc = {
		plain: ["line 1", "ERROR: a long line that wraps", "line 3"],
		styled: [out("line 1"), `${paint.fg("error", "ERROR:")}${out(" a long line that wraps")}`, out("line 3")],
	};
	const accept = (line: string) => escapes(line).every((code) => code === paint.open("toolOutput") || code === "\x1b[39m");
	const drawn = [
		"",
		paint.fg("muted", "... (1 earlier lines, ctrl+o to expand)"),
		paint.open("toolOutput") + "ERROR: a long",
		paint.open("toolOutput") + "line that" + "\x1b[39m",
		paint.open("toolOutput") + "wraps",
		out("line 3") + "    ",
		paint.fg("toolDiffAdded", "+line 3"),
		paint.fg("muted", "Took 0.1s"),
	];
	assert.deepEqual(overlay(drawn, doc, { match: "line", accept }).map(markup), [
		"",
		"[muted:... (1 earlier lines, ctrl+o to expand)]",
		"[error:ERROR:][output: a long]",
		"[output:line that]",
		"[output:wraps]",
		"[output:line 3]    ",
		"[diffAdded:+line 3]",
		"[muted:Took 0.1s]",
	]);
});

test("drawn text that isn't in the document is left alone", () => {
	const doc = { plain: ["abc"], styled: [paint.fg("syntaxString", "abc")] };
	const drawn = [title("$ something else")];
	assert.deepEqual(overlay(drawn, doc, { match: "run" }), drawn);
	assert.deepEqual(overlay([out("xyz")], doc, { match: "line" }), [out("xyz")]);
});
