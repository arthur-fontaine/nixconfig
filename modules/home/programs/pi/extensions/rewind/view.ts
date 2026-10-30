// The Rewind and Restore screens: a picker of prompts, then a confirmation
// with the options. Drawn full width with the Pi theme's tokens.
import { DOUBLE_PRESS_MS } from "./escape.ts";
import { firstLine, quoted, rowSummary, type Stats } from "./listing.ts";
import { CURRENT, FOOTER, LABELS, type Option, PLACEHOLDER, POINTER, ROW, SUMMARIZING } from "./text.ts";

export type Token = "accent" | "dim" | "muted" | "error" | "success" | "warning" | "text";
export type Paint = { fg(token: Token, text: string): string; bold(text: string): string; italic(text: string): string };
export type Ui = {
	truncate(text: string, width: number): string;
	wrap(text: string, width: number): string[];
	// Pi's key id for the input ("up", "ctrl+p", "j", "enter"…), if any.
	key(data: string): string | undefined;
	// The text a key types, if it types any.
	printable(data: string): string | undefined;
	rows(): number;
	render(): void;
};

export type Row = {
	id: string;
	text: string;
	time: number;
	// A dim line above the row when it starts a group (Restore's branches).
	group?: string;
};

export type Confirm = {
	sentence: string;
	text: string;
	age: string;
	options: Option[];
	// The dim lines under the quote for the focused option.
	describe(option: Option): string[];
	// Claude Code shows its warning whenever the code can be restored.
	warnings: string[];
};

// What happens on Enter: an error to show, or the dialog's result.
export type Outcome<R> = { error: string } | { result: R };

export type Screens<R> = {
	title: string;
	subtitle: string;
	nothing: string;
	rows: Row[];
	// Where "(current)" goes: after the prompts (Rewind) or before them (Restore).
	currentFirst: boolean;
	stats(row: Row): Promise<Stats | undefined>;
	open(row: Row): Promise<Outcome<Confirm>>;
	choose(row: Row, option: Option, context: string | undefined): Promise<Outcome<R>>;
	done(result: R | undefined): void;
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MAX_OPTIONS = 5;
const INPUT_OPTIONS = new Set<Option>(["summarize", "summarize_up_to"]);
// Rows per prompt in the picker: the prompt, its code changes, a blank line.
const ROW_LINES = 3;

export class Dialog<R> {
	#screens: Screens<R>;
	#paint: Paint;
	#ui: Ui;
	// The picker's entries: the prompts and "(current)" (undefined).
	#entries: (Row | undefined)[];
	#focus: number;
	#top = 0;
	#stats = new Map<string, Stats | undefined>();
	#error: string[] = [];
	#confirm: { row: Row; model: Confirm; focus: number; top: number; inputs: Map<Option, string> } | undefined;
	#busy: { label?: string; frame: number; timer?: ReturnType<typeof setInterval> } | undefined;
	#closed = false;

	constructor(screens: Screens<R>, paint: Paint, ui: Ui) {
		this.#screens = screens;
		this.#paint = paint;
		this.#ui = ui;
		this.#entries = screens.currentFirst ? [undefined, ...screens.rows] : [...screens.rows, undefined];
		this.#focus = screens.currentFirst ? 0 : this.#entries.length - 1;
		this.loaded = this.loadStats();
	}

	// Settles once every row's code changes are drawn.
	readonly loaded: Promise<void>;

	private async loadStats() {
		// Newest first, as Claude Code: those are the ones on screen.
		for (const row of [...this.#screens.rows].reverse()) {
			if (this.#closed) return;
			try {
				this.#stats.set(row.id, await this.#screens.stats(row));
			} catch {
				this.#stats.set(row.id, undefined);
			}
			this.#ui.render();
		}
	}

	invalidate() {}

	dispose() {
		this.#closed = true;
		if (this.#busy?.timer) clearInterval(this.#busy.timer);
	}

	handleInput(data: string) {
		if (this.#busy) return;
		const key = this.#ui.key(data);
		if (this.#confirm) this.confirmInput(data, key);
		else this.pickerInput(key);
		this.#ui.render();
	}

	private pickerInput(key: string | undefined) {
		const last = this.#entries.length - 1;
		const page = this.visibleRows();
		if (key === "escape") return this.finish(undefined);
		if (key === "up" || key === "k" || key === "ctrl+p") this.#focus = Math.max(0, this.#focus - 1);
		else if (key === "down" || key === "j" || key === "ctrl+n") this.#focus = Math.min(last, this.#focus + 1);
		else if (key === "pageUp") this.#focus = Math.max(0, this.#focus - page);
		else if (key === "pageDown") this.#focus = Math.min(last, this.#focus + page);
		else if (key === "home") this.#focus = 0;
		else if (key === "end") this.#focus = last;
		else if (key === "enter") {
			const row = this.#entries[this.#focus];
			if (!row) return this.finish(undefined);
			void this.run(async () => {
				const opened = await this.#screens.open(row);
				if ("error" in opened) this.#error = opened.error.split("\n");
				else this.#confirm = { row, model: opened.result, focus: 0, top: 0, inputs: new Map() };
			});
		}
	}

	private confirmInput(data: string, key: string | undefined) {
		const confirm = this.#confirm!;
		const options = confirm.model.options;
		const focused = options[confirm.focus]!;
		const typing = INPUT_OPTIONS.has(focused);
		const move = (to: number) => {
			confirm.focus = Math.max(0, Math.min(options.length - 1, to));
			if (confirm.focus < confirm.top) confirm.top = confirm.focus;
			if (confirm.focus >= confirm.top + MAX_OPTIONS) confirm.top = confirm.focus - MAX_OPTIONS + 1;
		};
		if (key === "escape") {
			this.#confirm = undefined;
			return;
		}
		if (key === "up" || key === "ctrl+p" || (!typing && key === "k")) return move(confirm.focus - 1);
		if (key === "down" || key === "ctrl+n" || (!typing && key === "j")) return move(confirm.focus + 1);
		if (key === "pageUp") return move(confirm.focus - MAX_OPTIONS);
		if (key === "pageDown") return move(confirm.focus + MAX_OPTIONS);
		if (!typing && key === "home") return move(0);
		if (!typing && key === "end") return move(options.length - 1);
		if (key === "enter") return this.select(focused);
		if (typing) {
			const value = confirm.inputs.get(focused) ?? "";
			if (key === "backspace") confirm.inputs.set(focused, value.slice(0, -1));
			else {
				const text = this.#ui.printable(data);
				if (text) confirm.inputs.set(focused, value + text);
			}
			return;
		}
		// Digits pick an option at once, as in Claude Code.
		if (key && /^[1-9]$/u.test(key)) {
			const option = options[Number(key) - 1];
			if (option) this.select(option);
		}
	}

	private select(option: Option) {
		const confirm = this.#confirm!;
		if (option === "nevermind") {
			this.#confirm = undefined;
			return;
		}
		const context = confirm.inputs.get(option)?.trim() || undefined;
		void this.run(async () => {
			const outcome = await this.#screens.choose(confirm.row, option, context);
			if ("result" in outcome) return this.finish(outcome.result);
			// As Claude Code: a failure goes back to the picker, with the error.
			this.#confirm = undefined;
			this.#error = outcome.error.split("\n");
		}, INPUT_OPTIONS.has(option) ? SUMMARIZING : undefined);
	}

	private async run(work: () => Promise<void>, label?: string) {
		this.#error = [];
		const busy: NonNullable<typeof this.busy> = { label, frame: 0 };
		if (label) {
			busy.timer = setInterval(() => {
				busy.frame++;
				this.#ui.render();
			}, 80);
		}
		this.#busy = busy;
		this.#ui.render();
		try {
			await work();
		} catch (error) {
			this.#confirm = undefined;
			this.#error = String((error as Error)?.message ?? error).split("\n");
		} finally {
			if (busy.timer) clearInterval(busy.timer);
			this.#busy = undefined;
			this.#ui.render();
		}
	}

	private get busy() {
		return this.#busy;
	}

	private finish(result: R | undefined) {
		if (this.#closed) return;
		this.#closed = true;
		this.#screens.done(result);
	}

	private visibleRows() {
		return Math.max(2, Math.floor((this.#ui.rows() - 12) / ROW_LINES));
	}

	render(width: number): string[] {
		const p = this.#paint;
		const fit = (line: string) => this.#ui.truncate(line, width);
		const lines = [fit(p.fg("accent", "─".repeat(width))), fit(p.bold(p.fg("accent", this.#screens.title))), ""];
		for (const line of this.#error) lines.push(...this.#ui.wrap(p.fg("error", line), width));
		if (this.#error.length) lines.push("");
		if (this.#confirm) lines.push(...this.renderConfirm(width));
		else lines.push(...this.renderPicker(width));
		return lines.map(fit);
	}

	private renderPicker(width: number): string[] {
		const p = this.#paint;
		if (this.#screens.rows.length === 0) return [this.#screens.nothing, "", p.italic(p.fg("dim", FOOTER))];
		const lines = [this.#screens.subtitle, ""];
		const visible = this.visibleRows();
		if (this.#focus < this.#top) this.#top = this.#focus;
		if (this.#focus >= this.#top + visible) this.#top = this.#focus - visible + 1;
		const end = Math.min(this.#entries.length, this.#top + visible);
		if (this.#top > 0) lines.push(p.fg("dim", ` ↑ ${this.#top} more`), "");
		for (let i = this.#top; i < end; i++) {
			const row = this.#entries[i];
			const focused = i === this.#focus;
			const pointer = focused ? `${p.fg("accent", POINTER)} ` : "  ";
			if (row?.group) lines.push(p.fg("dim", `  ${row.group}`));
			if (!row) {
				lines.push(pointer + p.italic(focused ? p.fg("accent", CURRENT) : CURRENT), "", "");
				continue;
			}
			const label = this.#ui.truncate(firstLine(row.text), Math.max(1, width - 10));
			lines.push(pointer + (focused ? p.fg("accent", label) : label), `  ${this.statsLine(row, focused)}`, "");
		}
		lines.pop();
		if (end < this.#entries.length) lines.push("", p.fg("dim", ` ↓ ${this.#entries.length - end} more`));
		while (lines.at(-1) === "") lines.pop();
		lines.push("", p.italic(p.fg("dim", FOOTER)));
		return lines;
	}

	private statsLine(row: Row, focused: boolean): string {
		const p = this.#paint;
		if (!this.#stats.has(row.id)) return "";
		const summary = rowSummary(this.#stats.get(row.id));
		if (summary === "noRestore") return p.fg("warning", `⚠ ${ROW.noRestore}`);
		const tone: Token = focused ? "muted" : "dim";
		return [p.fg(tone, summary.label), counts(p, summary.added, summary.removed)].filter(Boolean).join(" ");
	}

	private renderConfirm(width: number): string[] {
		const p = this.#paint;
		const confirm = this.#confirm!;
		const model = confirm.model;
		const bar = p.fg("dim", "│ ");
		const lines = [...this.#ui.wrap(model.sentence, width), ""];
		for (const line of quoted(model.text)) for (const part of this.#ui.wrap(line, Math.max(1, width - 2))) lines.push(bar + part);
		lines.push(bar + p.fg("dim", `(${model.age})`), "");
		const focused = model.options[confirm.focus]!;
		for (const line of model.describe(focused)) lines.push(...this.#ui.wrap(p.fg("dim", line), width));
		lines.push("");
		if (this.#busy?.label) {
			lines.push(`${p.fg("accent", SPINNER[this.#busy.frame % SPINNER.length]!)} ${this.#busy.label}`);
		} else {
			const end = Math.min(model.options.length, confirm.top + MAX_OPTIONS);
			for (let i = confirm.top; i < end; i++) {
				const option = model.options[i]!;
				const isFocused = i === confirm.focus;
				let lead = isFocused ? p.fg("accent", POINTER) : " ";
				if (!isFocused && i === end - 1 && end < model.options.length) lead = p.fg("dim", "↓");
				if (!isFocused && i === confirm.top && confirm.top > 0) lead = p.fg("dim", "↑");
				let label = `${i + 1}. ${LABELS[option]}`;
				if (INPUT_OPTIONS.has(option)) {
					const value = confirm.inputs.get(option) ?? "";
					if (value) label += `: ${value}`;
					else if (isFocused) label += `: ${p.fg("dim", PLACEHOLDER)}`;
				}
				lines.push(`${lead} ${isFocused ? p.fg("accent", label) : label}`);
			}
		}
		if (model.warnings.length) {
			lines.push("");
			for (const warning of model.warnings) lines.push(...this.#ui.wrap(p.fg("dim", warning), width));
		}
		return lines;
	}
}

// "+N -M" in the diff colors, a zero side left out.
export function counts(p: Paint, added: number, removed: number): string {
	return [added ? p.fg("success", `+${added}`) : "", removed ? p.fg("error", `-${removed}`) : ""].filter(Boolean).join(" ");
}

export { DOUBLE_PRESS_MS };
