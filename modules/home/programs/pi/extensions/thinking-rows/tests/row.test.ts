import assert from "node:assert/strict";
import { test } from "node:test";
import { faint as toolFaint, fadeOf as toolFadeOf } from "../../tool-rows-faint/faint.ts";
import { fadeOf, faint } from "../faint.ts";
import { displayMessage, duration, paintRow, pulseLines, renderMarkdown, RUNNING_DOT, runningDot, rowText, tokens } from "../row.ts";

const sig = { thinkingSignature: "x".repeat(10) };

test("figures read short", () => {
	assert.equal(tokens(1), "1 token");
	assert.equal(tokens(170), "170 tokens");
	assert.equal(tokens(3240), "3.2k tokens");
	assert.equal(tokens(16000), "16k tokens");
	assert.equal(duration(400), "1s");
	assert.equal(duration(12_300), "12s");
	assert.equal(duration(125_000), "2m 5s");
	assert.equal(rowText({ running: true }), "⦁ Thinking…");
	assert.equal(rowText({ running: false, tokens: 3240, ms: 12_000 }), "⦁ Thinking (3.2k tokens · 12s)");
	assert.equal(rowText({ running: false }), "⦁ Thinking");
});

test("an empty signed thinking block becomes a row with the response's tokens and its time", () => {
	const message = {
		role: "assistant",
		usage: { reasoning: 170 },
		content: [{ type: "thinking", thinking: "", ...sig, durationMs: 6000 }, { type: "text", text: "Done." }],
	};
	const shown = displayMessage(message, false);
	assert.equal(shown.content.length, 2);
	assert.equal(renderMarkdown(shown.content[0]!.thinking!), "⦁ Thinking (170 tokens · 6s)");
	assert.equal(shown.content[0]!.thinkingSignature, sig.thinkingSignature);
	// The session's message is untouched.
	assert.equal(message.content[0]!.thinking, "");
	// Drawn again from Pi's last message: the same row, not a row of a row.
	assert.deepEqual(displayMessage(shown, false), shown);
});

test("a run still streaming says so; one followed by text has ended", () => {
	const streaming = displayMessage({ role: "assistant", content: [{ type: "thinking", thinking: "" }] }, true);
	assert.equal(renderMarkdown(streaming.content[0]!.thinking!), "⦁ Thinking…");
	const after = displayMessage({ role: "assistant", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Hi" }] }, true);
	assert.equal(renderMarkdown(after.content[0]!.thinking!), "⦁ Thinking");
});

test("a run opens on its thinking text; several runs share no token count", () => {
	const shown = displayMessage({
		role: "assistant",
		usage: { reasoning: 900 },
		content: [
			{ type: "thinking", thinking: "First idea." },
			{ type: "thinking", thinking: "Second." },
			{ type: "toolCall", id: "1" },
			{ type: "thinking", thinking: "", durationMs: 2000 },
		],
	}, false, (run) => run === 0);
	assert.equal(shown.content.length, 3);
	assert.equal(renderMarkdown(shown.content[0]!.thinking!), "⦁ Thinking\n\nFirst idea.\n\nSecond.");
	assert.equal(renderMarkdown(shown.content[2]!.thinking!), "⦁ Thinking (2s)");
});

test("other Markdown is left alone", () => {
	assert.equal(renderMarkdown("plain *thinking*"), "plain *thinking*");
});

test("a closed run shows its row alone", () => {
	const shown = displayMessage({ role: "assistant", content: [{ type: "thinking", thinking: "Long reasoning.", durationMs: 3000 }] }, false);
	assert.equal(renderMarkdown(shown.content[0]!.thinking!), "⦁ Thinking (3s)");
});

// What compact-tools' summary view does to thinking before this extension's transformer.
const summarized = (markdown: string) => {
	const first = markdown.split("\n").find((line) => line.trim()) ?? "";
	const plain = first.replace(/[*_~`]/gu, "").replace(/\s+/gu, " ").trim();
	return `\x1b[1m${plain}\x1b[22m`;
};

test("an opened run's thinking gets past compact-tools' summary, after the row's style", () => {
	const thinking = "Check `row.ts` *first*.\n\n- then __tests__ ~ é";
	const shown = displayMessage({ role: "assistant", content: [{ type: "thinking", thinking, durationMs: 2000 }] }, false, () => true);
	assert.equal(renderMarkdown(summarized(shown.content[0]!.thinking!)), `\x1b[1m⦁ Thinking (2s)\x1b[22m\n\n${thinking}`);
	const closed = displayMessage({ role: "assistant", content: [{ type: "thinking", thinking, durationMs: 2000 }] }, false);
	assert.equal(renderMarkdown(summarized(closed.content[0]!.thinking!)), "\x1b[1m⦁ Thinking (2s)\x1b[22m");
});

test("the row is painted in a tool row's colors, its figures as a tool row's details", () => {
	const tags = { fg: (token: string, text: string) => `<${token}>${text}</>`, bold: (text: string) => `<b>${text}</b>` };
	assert.equal(paintRow({ running: false, tokens: 86, ms: 2000 }, tags), "\x1b[22;23m<success>⦁</> <toolTitle><b>Thinking</b></><toolOutput> (86 tokens · 2s)</>");
	// Running: a mark where the dot goes, painted when the row is drawn (pulseLines).
	assert.equal(paintRow({ running: true }, tags, (text) => `~${text}~`), `\x1b[22;23m~<muted>${RUNNING_DOT}</> <toolTitle><b>Thinking</b></><toolOutput>…</>~`);
});

// A theme as Pi's in true color, for both fades.
const theme = { getFgAnsi: (token: string) => (token === "text" ? "\x1b[38;2;222;224;225m" : "\x1b[38;2;119;126;133m"), appearance: "dark" };

test("a running row's dot is compact-tools' running dot for this frame, faded as tool-rows-faint fades a tool row", () => {
	const frames = ["\x1b[38;2;60;64;70m⦁\x1b[39m", "\x1b[38;2;120;126;133m⦁\x1b[39m"];
	let frame = 0;
	const painted: string[] = [];
	const pulse = { paint: (_theme: unknown, id: string) => (painted.push(id), frames[frame]!), stop() {} };
	const fade = (text: string) => faint(text, fadeOf(theme, 0.3)!);
	const toolRow = (dot: string) => toolFaint(dot, toolFadeOf(theme, 0.3)!);
	assert.equal(runningDot(pulse, theme, "thinking:1", fade), toolRow(frames[0]!));
	frame = 1;
	assert.equal(runningDot(pulse, theme, "thinking:1", fade), toolRow(frames[1]!));
	assert.deepEqual(painted, ["thinking:1", "thinking:1"]);
	// Without compact-tools, the dot stays as the row painted it (muted).
	assert.equal(runningDot(undefined, theme, "thinking:1", fade), "⦁");
});

test("the mark is replaced in the drawn lines, which are left alone without one", () => {
	const lines = [` \x1b[38;2;1;2;3m${RUNNING_DOT}\x1b[39m Thinking…`, "text"];
	assert.deepEqual(pulseLines(lines, () => "<dot>"), [" \x1b[38;2;1;2;3m<dot>\x1b[39m Thinking…", "text"]);
	const none = ["a", "b"];
	assert.equal(pulseLines(none, () => { throw new Error("not painted"); }), none);
});
