import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteProvider,
	CURSOR_MARKER,
	type Component,
	type EditorTheme,
	isKeyRelease,
	matchesKey,
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
import { arbitrate, cycle, type Step } from "./keys.ts";
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
// The fullscreen renderer's selection, public on Pi's alt-screen TUI but not on the TUI type.
interface Selection {
	hasActiveSelection?(): boolean;
	copyActiveSelectionToClipboard?(): Promise<boolean>;
	resetTextSelection?(): void;
}
interface AutocompleteControl {
	updateAutocomplete(): void;
}

export interface GhostOptions {
	predictor: Predictor;
	style: (text: string) => string;
	// For a slash command Pi knows, like Claude Code's prompt input.
	commandStyle: (text: string) => string;
	// Commands typed under another extension's name: `/from …` runs `/to …`.
	commandAliases: () => Record<string, string>;
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
	// Down or Left at the empty prompt may have moved into FleetView, which owns Up and Down from then on.
	private yielded = false;
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
		// Pi hands its submit handler over by assigning onSubmit, an own field of its
		// Editor, so an accessor here sees what is sent before Pi's commands do.
		let submit: ((text: string) => void) | undefined;
		Object.defineProperty(this, "onSubmit", {
			configurable: true,
			enumerable: true,
			get: () => submit && ((text: string) => submit?.(this.aliased(text))),
			set: (handler?: (text: string) => void) => {
				submit = handler;
			},
		});
	}

	private copySelection(): boolean {
		const screen = this.tui as unknown as Selection;
		if (!screen.hasActiveSelection?.() || !screen.copyActiveSelectionToClipboard) return false;
		// Dropped once copied, so the next Ctrl+C clears or exits as usual.
		void screen.copyActiveSelectionToClipboard().finally(() => screen.resetTextSelection?.());
		return true;
	}

	private aliased(text: string): string {
		const name = commandName(text.trimStart());
		const target = name && this.ghost?.commandAliases()[name];
		return target ? text.trimStart().replace(`/${name}`, `/${target}`) : text;
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
		// Ctrl+C copies a selection, as in Claude Code; with none it clears and exits as in Pi.
		if (this.keys.matches(data, "app.clear") && this.copySelection()) return;
		this.replay.disarm();
		const shown = this.visibleSuggestion();
		if (shown !== undefined) {
			const next = cycle(this.step(data), this.suggestions.length, this.selected);
			if (next !== undefined) {
				this.selected = next;
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
		if (this.getText() !== before) {
			// Some of Pi's edits (Cmd+Delete, to the start of the line) leave the popup on
			// what was deleted; Backspace refreshes it, these don't.
			if (this.isShowingAutocomplete()) (this as unknown as AutocompleteControl).updateAutocomplete();
			this.changed();
		}
	}

	// For a terminal input listener, which Pi runs before the focused editor: true when the
	// key was handled here and must go no further. See keys.ts.
	takeKey(data: string): boolean {
		if (isKeyRelease(data)) return false;
		const step = this.step(data);
		const action = arbitrate({
			idle: this.focused && this.getText() === "",
			cycles: this.visibleSuggestion() !== undefined && cycle(step, this.suggestions.length, this.selected) !== undefined,
			entersList: matchesKey(data, "down") || matchesKey(data, "left"),
			leavesList: matchesKey(data, "escape"),
		});
		if (action === "take") {
			this.handleInput(data);
			return true;
		}
		if (action === "yield") {
			// FleetView consumes the key, so the editor wouldn't clear the suggestion itself.
			this.yielded = true;
			this.cancel();
			this.tui.requestRender();
		}
		if (action === "return" && this.yielded) {
			this.yielded = false;
			this.schedule();
		}
		return false;
	}

	private step(data: string): Step | undefined {
		if (this.keys.matches(data, "tui.editor.cursorDown")) return "next";
		if (this.keys.matches(data, "tui.editor.cursorUp")) return "previous";
		return undefined;
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
		this.yielded = false;
		this.cancel();
		// An accepted suggestion is a finished thought: wait for the next keystroke.
		if (!this.accepting) this.schedule();
	}

	private schedule(): void {
		this.cancel();
		const predictor = this.ghost?.predictor;
		if (!predictor || this.paused || this.yielded || this.disposed || !predictor.ready() || !this.atEnd()) return;
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
