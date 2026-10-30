// Run: node --test 'modules/home/programs/pi/extensions/footer/tests/*.test.ts'
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanStatus, type FooterState, footerLines, formatCwd, type Measure, type Paint, plain, shortenings } from "../layout.ts";

const CODES = { dim: 90, muted: 37, warning: 33, error: 31 } as const;
const paint: Paint = (tone, text) => `\x1b[${CODES[tone]}m${text}\x1b[39m`;
const fg = (tone: keyof typeof CODES, text: string) => paint(tone, text);

// pi-tui's, for plain characters.
const measure: Measure = {
	visibleWidth: (text) => [...plain(text)].length,
	truncateToWidth(text, width, ellipsis = "…") {
		if (this.visibleWidth(text) <= width) return text;
		const room = Math.max(0, width - this.visibleWidth(ellipsis));
		let out = "";
		let seen = 0;
		for (const part of text.split(/(\x1b\[[0-9;]*m)/)) {
			if (part.startsWith("\x1b[")) {
				out += part;
				continue;
			}
			for (const ch of part) {
				if (seen >= room) break;
				out += ch;
				seen++;
			}
		}
		return out + ellipsis;
	},
};

const HOME = "/Users/me";
const CWD = "/Users/me/Developer/code/github.com/arthur-fontaine/nixconfig/main";
const state = (change: Partial<FooterState> = {}): FooterState => ({
	cwd: CWD,
	home: HOME,
	branch: "main",
	sessionName: "sous-agents-pi-setup",
	model: "claude-opus-5-5",
	thinking: "high",
	contextPercent: 12,
	cost: undefined,
	statuses: [],
	...change,
});
const lines = (s: FooterState, width = 100) => footerLines(s, width, paint, measure).map(plain);

test("line 1: path, branch and session name; line 2: model and thinking", () => {
	assert.deepEqual(lines(state()), [
		"~/Developer/code/github.com/arthur-fontaine/nixconfig/main (main)  @sous-agents-pi-setup",
		`${" ".repeat(100 - 30)}claude-opus-5-5  high thinking`,
	]);
});

test("each item gets its own color", () => {
	const [one, two] = footerLines(state(), 100, paint, measure);
	assert.equal(one, `${fg("dim", "~/Developer/code/github.com/arthur-fontaine/nixconfig/main")} ${fg("dim", "(main)")}  ${fg("muted", "@sous-agents-pi-setup")}`);
	assert.ok(two.endsWith(`${fg("dim", "claude-opus-5-5")}  ${fg("dim", "high thinking")}`));
});

test("no repo, no name: the path alone; a detached HEAD says so", () => {
	assert.equal(lines(state({ branch: null, sessionName: undefined }))[0], "~/Developer/code/github.com/arthur-fontaine/nixconfig/main");
	assert.equal(lines(state({ branch: "detached", sessionName: undefined }))[0], "~/Developer/code/github.com/arthur-fontaine/nixconfig/main (detached)");
});

test("always two lines, the second blank when there is nothing to say", () => {
	assert.deepEqual(lines(state({ model: undefined, thinking: undefined }), 100), [lines(state())[0], ""]);
});

test("thinking: the level, off, or nothing for a model that doesn't reason", () => {
	assert.match(lines(state({ thinking: "xhigh" }))[1]!, /claude-opus-5-5  xhigh thinking$/);
	assert.match(lines(state({ thinking: "off" }))[1]!, /claude-opus-5-5  thinking off$/);
	assert.match(lines(state({ thinking: undefined }))[1]!, /claude-opus-5-5$/);
});

test("context shows from half full, a warning from 70%, an error above 90%", () => {
	const context = (contextPercent: number | null) => footerLines(state({ contextPercent, model: undefined, thinking: undefined }), 100, paint, measure)[1];
	assert.equal(context(49.4), "");
	assert.equal(context(null), "");
	assert.equal(context(64), fg("dim", "context 64% full"));
	assert.equal(context(70), fg("warning", "context 70% full"));
	assert.equal(context(84.2), fg("warning", "context 84% full"));
	assert.equal(context(90), fg("warning", "context 90% full"));
	assert.equal(context(93), fg("error", "context 93% full"));
});

test("cost on API billing only, once something was spent", () => {
	const cost = (value: number | undefined) => lines(state({ cost: value, model: undefined, thinking: undefined }))[1];
	assert.equal(cost(undefined), "");
	assert.equal(cost(0), "");
	assert.equal(cost(0.004), "<$0.01 so far");
	assert.equal(cost(0.0412), "$0.04 so far");
	assert.equal(cost(12.5), "$12.50 so far");
});

const statuses: [string, string][] = [
	["zz-other", "goal: ship it"],
	["background-tools", fg("muted", "3 commands in background")],
	["cache-timer", fg("warning", "cache expires in 3 min")],
	["remote-control", fg("warning", "remote control offline")],
	["cache-warmer", fg("dim", "keeping cache warm")],
	["auto-mode", fg("dim", "auto mode")],
];

test("line 2 orders the statuses, the footer's own items between them, unknown ones last", () => {
	assert.equal(
		lines(state({ statuses, contextPercent: 84, cost: 0.04, model: undefined, thinking: undefined }), 200)[1],
		"auto mode   remote control offline   context 84% full   cache expires in 3 min   keeping cache warm   3 commands in background   $0.04 so far   goal: ship it",
	);
});

test("an unknown status is dimmed, keeping its own colors", () => {
	const [, two] = footerLines(state({ statuses: [["x", `a ${fg("error", "b")}`]], model: undefined, thinking: undefined }), 100, paint, measure);
	assert.equal(two, fg("dim", `a ${fg("error", "b")}`));
});

test("the old `│ ` bar is stripped, painted or not, and newlines flattened", () => {
	assert.equal(cleanStatus(`${fg("dim", "│ ")}${fg("dim", "auto mode")}`), `\x1b[90m\x1b[39m${fg("dim", "auto mode")}`);
	assert.equal(plain(cleanStatus(`\x1b[2m│ cache 42:10\x1b[22m`)), "cache 42:10");
	assert.equal(cleanStatus("│ RC"), "RC");
	assert.equal(cleanStatus("one\ntwo\t three"), "one two three");
	// Statuses that are only a bar or blank take no slot.
	assert.equal(lines(state({ statuses: [["a", "│ "], ["b", "  "]], model: undefined, thinking: undefined }))[1], "");
});

test("the mockups at 100 columns", () => {
	assert.deepEqual(lines(state({ statuses: [["auto-mode", fg("dim", "auto mode")], ["remote-control", fg("dim", "remote control on")]] })), [
		"~/Developer/code/github.com/arthur-fontaine/nixconfig/main (main)  @sous-agents-pi-setup",
		`auto mode   remote control on${" ".repeat(100 - 29 - 30)}claude-opus-5-5  high thinking`,
	]);
	const busy = state({
		statuses: [
			["auto-mode", fg("dim", "auto mode")],
			["remote-control", fg("warning", "remote control offline")],
			["cache-timer", fg("warning", "cache expires in 3 min")],
		],
		contextPercent: 84,
	});
	const left = "auto mode   remote control offline   context 84% full   cache expires in 3 min";
	assert.equal(lines(busy)[1], `${left}${" ".repeat(100 - left.length - 15)}claude-opus-5-5`);
});

test("narrow line 2 drops thinking, model, cost, `remote control on`, then `auto mode`", () => {
	const s = state({
		statuses: [
			["auto-mode", fg("dim", "auto mode")],
			["remote-control", fg("dim", "remote control on")],
			["background-tools", fg("muted", "1 command in background")],
		],
		contextPercent: 93,
		cost: 1.5,
	});
	const all = "auto mode   remote control on   context 93% full   1 command in background   $1.50 so far";
	assert.equal(lines(s, all.length + 2 + 30)[1], `${all}  claude-opus-5-5  high thinking`);
	assert.equal(lines(s, all.length + 2 + 29)[1], `${all}${" ".repeat(16)}claude-opus-5-5`);
	assert.equal(lines(s, all.length + 2 + 14)[1], all);
	assert.equal(lines(s, all.length - 1)[1], "auto mode   remote control on   context 93% full   1 command in background");
	assert.equal(lines(s, 70)[1], "auto mode   context 93% full   1 command in background");
	assert.equal(lines(s, 50)[1], "context 93% full   1 command in background");
	// What's never dropped is cut at the end as a last resort.
	assert.equal(lines(s, 30)[1], "context 93% full   1 command …");
});

test("warnings, `checking` and `auto mode off` are never dropped", () => {
	const s = state({
		statuses: [
			["auto-mode", fg("muted", "auto mode: checking")],
			["remote-control", fg("warning", "remote control offline")],
		],
	});
	assert.equal(lines(s, 46)[1], "auto mode: checking   remote control offline");
	const off = state({ statuses: [["auto-mode", fg("muted", "auto mode off")]] });
	assert.equal(lines(off, 14)[1], "auto mode off");
});

test("line 1 shortens the path first, from the front", () => {
	const s = state({ sessionName: undefined });
	assert.equal(lines(s, 60)[0], "…/code/github.com/arthur-fontaine/nixconfig/main (main)");
	assert.equal(lines(s, 30)[0], "…/nixconfig/main (main)");
	assert.equal(lines(s, 15)[0], "…/main (main)");
	assert.deepEqual(shortenings("~/a/b/c"), ["…/a/b/c", "…/b/c", "…/c"]);
});

test("then cuts the session name, never below 12 characters, and keeps the branch", () => {
	assert.equal(lines(state(), 80)[0], "…/code/github.com/arthur-fontaine/nixconfig/main (main)  @sous-agents-pi-setup");
	assert.equal(lines(state(), 36)[0], "…/main (main)  @sous-agents-pi-setup");
	assert.equal(lines(state(), 30)[0], "…/main (main)  @sous-agents-p…");
	assert.equal(lines(state(), 28)[0], "…/main (main)  @sous-agents…");
	// Below that the line itself is cut.
	assert.equal(lines(state(), 24)[0], "…/main (main)  @sous-ag…");
});

test("home is shown as ~, other paths as they are", () => {
	assert.equal(formatCwd("/Users/me/x", HOME), "~/x");
	assert.equal(formatCwd("/Users/me", HOME), "~");
	assert.equal(formatCwd("/Users/meow", HOME), "/Users/meow");
	assert.equal(formatCwd("/tmp", undefined), "/tmp");
});
