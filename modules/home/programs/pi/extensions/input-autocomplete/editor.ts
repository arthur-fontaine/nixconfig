import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteProvider,
	CURSOR_MARKER,
	type Component,
	type EditorTheme,
	type OverlayHandle,
	type OverlayOptions,
	renderFakeCursor,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { commandName, paintCommand } from "./command.ts";
import { ReplayFilter } from "./history.ts";
import { wantsPrediction } from "./prediction.ts";
import type { Predictor } from "./predictor.ts";

// Long enough that typing through a sentence doesn't fire a request at every
// space: each one spawns `claude -p` and spends subscription quota.
export const DEBOUNCE_MS = 1_200;
// Where Pi's editor draws the cursor when it sits after the last character.
const END_CURSOR = CURSOR_MARKER + renderFakeCursor(" ");
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

// What Pi's Editor keeps of its last render; private in its types, plain fields at run time.
interface RenderedRows {
	renderedAutocompleteHeight: number;
}

export interface GhostOptions {
	predictor: Predictor;
	style: (text: string) => string;
	// For a slash command Pi knows, like Claude Code's prompt input.
	commandStyle: (text: string) => string;
}

export class GhostEditor extends CustomEditor {
	// Plain fields: Pi's Editor constructor may already call the overrides below.
	private ghost?: GhostOptions;
	private keys: KeybindingsManager;
	private suggestions: string[] = [];
	private selected = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private pending?: AbortController;
	private accepting = false;
	private paused = false;
	private disposed = false;
	private replay = new ReplayFilter([]);
	private provider?: AutocompleteProvider;
	private commands = new Map<string, boolean>();
	private popupRows = 0;
	private popup?: { handle: OverlayHandle; options: OverlayOptions; lines: string[]; editorRows: number };

	constructor(tui: TUI, theme: EditorTheme, keys: KeybindingsManager, options: GhostOptions) {
		// As Pi builds its own editor; padding, autocomplete provider and border
		// color are copied over by Pi once the factory returns.
		super(tui, theme, keys, { embedWorkingStatus: true });
		this.keys = keys;
		this.ghost = options;
	}

	// The branch's prompts, oldest first, then Pi's replay of `inContext` is skipped.
	seedHistory(all: readonly string[], inContext: readonly string[]): void {
		for (const text of all) super.addToHistory(text);
		this.replay = new ReplayFilter(inContext);
	}

	override addToHistory(text: string): void {
		if (!this.replay?.skip(text)) super.addToHistory(text);
	}

	override handleInput(data: string): void {
		this.replay.disarm();
		const shown = this.visibleSuggestion();
		if (shown !== undefined) {
			if (this.keys.matches(data, "tui.editor.cursorUp") && this.selected > 0) {
				this.selected--;
				this.tui.requestRender();
				return;
			}
			if (this.keys.matches(data, "tui.editor.cursorDown") && this.suggestions.length > 1) {
				this.selected = (this.selected + 1) % this.suggestions.length;
				this.tui.requestRender();
				return;
			}
			if (this.keys.matches(data, "tui.input.tab") || this.keys.matches(data, "tui.editor.cursorRight")) {
				this.accepting = true;
				try {
					this.insertTextAtCursor(shown);
				} finally {
					this.accepting = false;
				}
				this.tui.requestRender();
				return;
			}
		}
		this.cancel();
		const before = this.getText();
		super.handleInput(data);
		if (this.getText() !== before) this.changed();
	}

	override setText(text: string): void {
		super.setText(text);
		this.changed();
	}

	override insertTextAtCursor(text: string): void {
		super.insertTextAtCursor(text);
		this.changed();
	}

	// Pi's provider lists every command it offers (built-in, extensions, skills, prompts),
	// which its exports don't, so it answers whether a name is one.
	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.provider = provider;
		this.commands = new Map();
		super.setAutocompleteProvider(provider);
	}

	override render(width: number): string[] {
		const lines = this.paintCommand(super.render(width));
		this.drawGhost(lines, width);
		return this.popupAbove(lines, width);
	}

	// Pi draws the slash and @ popup under the editor, inside its height, which pushes
	// the input line and the chat up while it's open. Instead it floats over the chat,
	// just above the editor; where the editor's place on screen is unknown, it's drawn
	// above the top border, which still keeps the input line in place.
	private popupAbove(lines: string[], width: number): string[] {
		this.popupRows = (this as unknown as RenderedRows).renderedAutocompleteHeight ?? 0;
		if (this.popupRows <= 0) {
			this.hidePopup();
			return lines;
		}
		const editor = lines.slice(0, lines.length - this.popupRows);
		const popup = lines.slice(editor.length);
		const top = this.screenTop(editor.length, width);
		if (top === undefined) {
			this.hidePopup();
			return [...popup, ...editor];
		}
		const row = Math.max(0, top - popup.length);
		if (this.popup) {
			Object.assign(this.popup.options, { row, width });
			this.popup.lines = popup;
			this.popup.editorRows = editor.length;
		} else {
			const options: OverlayOptions = { row, col: 0, width, nonCapturing: true };
			const view: Component = {
				render: () => this.popup?.lines ?? [],
				invalidate() {},
				// The list's own rows, where Pi's Editor expects them: under its rows.
				handleMouse: (event) => super.handleMouse({ ...event, y: (this.popup?.editorRows ?? 0) + event.y }),
			};
			this.popup = { options, lines: popup, editorRows: editor.length, handle: this.tui.showOverlay(view, options) };
		}
		return editor;
	}

	// The editor's first row on screen in fullscreen mode, where Pi docks it at the
	// bottom: the terminal's height less its rows and those of what Pi docks under it.
	private screenTop(editorRows: number, width: number): number | undefined {
		if (this.tui.mode !== "fullscreen") return undefined;
		const docked = this.tui.children;
		const index = docked.findIndex((child) => child === this || (child as { children?: Component[] }).children?.includes(this));
		if (index < 0) return undefined;
		const below = docked.slice(index + 1).reduce((rows, child) => rows + child.render(width).length, 0);
		return this.tui.terminal.rows - below - editorRows;
	}

	private hidePopup(): void {
		this.popup?.handle.hide();
		this.popup = undefined;
	}

	// Rows as Pi's Editor laid them out, when the popup is drawn above the top border.
	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const popup = this.popupRows;
		if (popup <= 0 || this.popup || !this.isShowingAutocomplete()) return super.handleMouse(event);
		const editorRows = event.height - popup;
		return super.handleMouse({ ...event, y: event.y < popup ? editorRows + event.y : event.y - popup });
	}

	private drawGhost(lines: string[], width: number): void {
		const text = this.suggestions[this.selected] ?? (this.pending ? "…" : "");
		if (!text || !this.ghost || this.isShowingAutocomplete() || !this.atEnd()) return;
		const row = lines.findIndex((line) => line.includes(END_CURSOR));
		if (row < 0) return;
		const line = lines[row]!;
		const head = line.slice(0, line.indexOf(END_CURSOR));
		const [first = ""] = text.split("\n", 1);
		const whole = (text.includes("\n") ? `${first} ↵` : first).replace(/\t/gu, "    ");
		const preview = truncateToWidth(whole, width - visibleWidth(head), "…");
		if (!preview) return;
		// The cursor sits on the suggestion's first character, where Tab will
		// insert it, rather than on a blank cell that shifts it right by one.
		const cell = graphemes.segment(preview)[Symbol.iterator]().next().value?.segment ?? "";
		const drawn = head + CURSOR_MARKER + this.ghost.style(renderFakeCursor(cell) + preview.slice(cell.length));
		lines[row] = drawn + " ".repeat(Math.max(0, width - visibleWidth(drawn)));
	}

	private paintCommand(lines: string[]): string[] {
		const name = commandName(this.getLines()[0] ?? "");
		if (!name || !this.ghost) return lines;
		const known = this.commands.get(name);
		if (known === undefined) this.lookUpCommand(name);
		// Row 0 is the top border; row 1 shows the first line unless the editor scrolled.
		const painted = known && lines[1] !== undefined ? paintCommand(lines[1], name, this.ghost.commandStyle) : undefined;
		if (painted !== undefined) lines[1] = painted;
		return lines;
	}

	private lookUpCommand(name: string): void {
		const provider = this.provider;
		if (!provider) return;
		this.commands.set(name, false);
		const draft = `/${name}`;
		provider
			.getSuggestions([draft], 0, draft.length, { signal: AbortSignal.timeout(2_000) })
			.then((found) => {
				if (this.provider !== provider || !found?.items.some((item) => item.value === name)) return;
				this.commands.set(name, true);
				this.tui.requestRender();
			})
			.catch(() => this.commands.delete(name));
	}

	pause(): void {
		this.paused = true;
		this.cancel();
		this.ghost?.predictor.clear();
	}

	resume(): void {
		if (this.disposed) return;
		this.paused = false;
		this.schedule();
	}

	dispose(): void {
		this.disposed = true;
		this.hidePopup();
		this.pause();
	}

	private visibleSuggestion(): string | undefined {
		if (this.isShowingAutocomplete() || !this.atEnd()) return undefined;
		return this.suggestions[this.selected];
	}

	private atEnd(): boolean {
		const lines = this.getLines();
		const cursor = this.getCursor();
		return cursor.line === lines.length - 1 && cursor.col === (lines[cursor.line]?.length ?? 0);
	}

	private changed(): void {
		if (!this.ghost) return;
		this.cancel();
		// An accepted suggestion is a finished thought: wait for the next keystroke.
		if (!this.accepting) this.schedule();
	}

	private schedule(): void {
		this.cancel();
		const predictor = this.ghost?.predictor;
		if (!predictor || this.paused || this.disposed || !predictor.ready() || !this.atEnd()) return;
		// A popup from another provider owns the moment; its ghost would stay hidden.
		if (this.isShowingAutocomplete()) return;
		const draft = this.getText();
		if (!wantsPrediction(draft)) return;
		const payload = predictor.payload(draft);
		// Nothing to go on yet; a guess would only spend quota.
		if (!draft && payload.conversation.length === 0) return;
		const known = predictor.lookup(payload);
		if (known) {
			this.suggestions = known;
			this.tui.requestRender();
			return;
		}
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.isShowingAutocomplete()) return;
			const request = new AbortController();
			this.pending = request;
			this.tui.requestRender();
			predictor
				.predict(payload, request.signal)
				.then((suggestions) => {
					if (this.pending !== request || this.getText() !== draft) return;
					this.suggestions = suggestions;
					this.selected = 0;
				})
				.catch(() => {})
				.finally(() => {
					if (this.pending !== request) return;
					this.pending = undefined;
					this.tui.requestRender();
				});
		}, DEBOUNCE_MS);
	}

	private cancel(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		this.pending?.abort();
		this.pending = undefined;
		this.suggestions = [];
		this.selected = 0;
	}
}
