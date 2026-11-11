import assert from "node:assert/strict";
import { test } from "node:test";
import { type Paint, spokenLines, spokenRow, statusText, type Tui } from "../view.ts";

// Plain-text stand-ins for pi-tui's helpers (the real ones handle ANSI; none is used here).
const tui: Tui = {
	truncateToWidth: (text, width, ellipsis = "…") => (text.length <= width ? text : text.slice(0, Math.max(0, width - ellipsis.length)) + ellipsis),
	visibleWidth: (text) => text.length,
	wrapTextWithAnsi: (text, width) => {
		const out: string[] = [];
		let line = "";
		for (const word of text.split(" ")) {
			if (line && line.length + 1 + word.length > width) {
				out.push(line);
				line = word;
			} else line = line ? `${line} ${word}` : word;
		}
		if (line) out.push(line);
		return out;
	},
	MouseRegion: class {
		child: { render(w: number): string[] };
		onMouse: (e: unknown) => unknown;
		constructor(child: { render(w: number): string[] }, onMouse: (e: unknown) => unknown) {
			this.child = child;
			this.onMouse = onMouse;
		}
		render(w: number) {
			return this.child.render(w);
		}
		handleMouse(e: unknown) {
			return this.onMouse(e);
		}
		invalidate() {}
	} as unknown as Tui["MouseRegion"],
};
const plain: Paint = { fg: (_c, t) => t };
const said = { text: "J'ai trouvé la cause : le footer lisait l'ancienne clé de configuration. Tu veux que je fasse le commit ?", interrupted: false, durationMs: 11_600 };

test("the row is one line when collapsed, with the first words and the hint", () => {
	const [line, ...rest] = spokenLines(tui, said, false, 80, plain);
	assert.equal(rest.length, 0);
	assert.ok(line!.startsWith("⦁ Spoke 12s · « J'ai trouvé la cause"), line);
	assert.ok(line!.endsWith("(click to expand)"), line);
	assert.ok(line!.length <= 80);
});

test("expanded, the row shows the whole spoken text", () => {
	const lines = spokenLines(tui, said, true, 40, plain);
	assert.equal(lines[0], "⦁ Spoke 12s");
	assert.equal(lines.slice(1).map((l) => l.trim()).join(" "), said.text);
});

test("an interrupted answer says so", () => {
	assert.ok(spokenLines(tui, { ...said, interrupted: true }, false, 80, plain)[0]!.includes("Spoke 12s, interrupted"));
});

test("a click opens and closes the row; Ctrl+O (expanded) opens it", () => {
	const open = { value: false };
	const row = spokenRow(tui, said, false, open, plain) as unknown as { render(w: number): string[]; handleMouse(e: unknown): unknown };
	assert.equal(row.render(60).length, 1);
	assert.deepEqual(row.handleMouse({ type: "click", button: "left" }), { handled: true });
	assert.ok(row.render(60).length > 1);
	row.handleMouse({ type: "click", button: "left" });
	assert.equal(row.render(60).length, 1);
	assert.equal(row.handleMouse({ type: "move", button: "none" }), undefined, "only clicks");
	assert.ok((spokenRow(tui, said, true, { value: false }, plain) as unknown as { render(w: number): string[] }).render(60).length > 1);
});

test("the footer item follows the call", () => {
	assert.equal(statusText({ active: false, mine: false }), undefined);
	assert.equal(statusText({ active: true, mine: true, state: "listening" }), "listening");
	assert.equal(statusText({ active: true, mine: true, state: "user_speaking", partial: "fais un commit" }), "« fais un commit »");
	assert.equal(statusText({ active: true, mine: true, state: "pi_speaking" }), "Pi is speaking");
	assert.equal(statusText({ active: true, mine: true, loading: true }), "loading voice models…");
	assert.equal(statusText({ active: true, mine: false, owner: "nixconfig" }), "call in nixconfig");
});
