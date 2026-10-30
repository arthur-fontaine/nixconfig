// Esc pressed twice on an empty, idle prompt opens Rewind, as in Claude Code.
// The hook sits on the editor's onEscape, which Pi calls only for an Escape no
// popup took, so the slash/@ popup and Pi's dialogs keep theirs.

export const DOUBLE_PRESS_MS = 800;

export class DoublePress {
	#last: number | undefined;
	readonly #window: number;
	readonly #now: () => number;

	constructor(window = DOUBLE_PRESS_MS, now = Date.now) {
		this.#window = window;
		this.#now = now;
	}

	// True on the second counted press within the window.
	press(counts: boolean): boolean {
		const now = this.#now();
		if (!counts) {
			this.#last = undefined;
			return false;
		}
		if (this.#last !== undefined && now - this.#last <= this.#window) {
			this.#last = undefined;
			return true;
		}
		this.#last = now;
		return false;
	}

	reset() {
		this.#last = undefined;
	}
}

const CURSOR_MARKER = "\x1b_pi:c\x07";
// CSI, OSC and APC sequences, which draw nothing.
const SEQUENCES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/gu;

// Whether the editor's last frame drew something after the cursor of its empty
// input: input-autocomplete's ghost suggestion (or its "…"). The Escape that
// clears it is for the suggestion, not a first press.
export function drawsAfterCursor(lines: readonly string[] | undefined): boolean {
	const row = lines?.find((line) => line.includes(CURSOR_MARKER));
	if (row === undefined) return false;
	return row.slice(row.indexOf(CURSOR_MARKER) + CURSOR_MARKER.length).replace(SEQUENCES, "").trim() !== "";
}

type Editor = {
	render(width: number): string[];
	getText(): string;
	onEscape?: () => void;
};

export type EscapeHook = {
	// Whether Rewind may open now (idle, nothing queued, no dialog of ours open).
	ready(): boolean;
	open(): void;
};

const HOOKED = Symbol.for("pi-rewind.escape-hook");

// Wraps the editor's onEscape in place. Pi assigns onEscape after the factory
// returns, when the editor has none; the accessor keeps that assignment and
// runs the double-press check before it.
export function hookEditor(editor: Editor, hook: EscapeHook, press = new DoublePress()) {
	const target = editor as Editor & { [HOOKED]?: true };
	if (target[HOOKED]) return;
	target[HOOKED] = true;
	let lines: string[] | undefined;
	const render = editor.render.bind(editor);
	editor.render = (width: number) => {
		lines = render(width);
		return lines;
	};
	let assigned = editor.onEscape;
	Object.defineProperty(editor, "onEscape", {
		configurable: true,
		enumerable: true,
		get: () =>
			assigned &&
			(() => {
				const counts = editor.getText() === "" && !drawsAfterCursor(lines) && hook.ready();
				// The second press is Rewind's alone: Pi's own double-Escape (/tree) never sees it.
				if (press.press(counts)) {
					hook.open();
					return;
				}
				assigned?.();
			}),
		set: (handler?: () => void) => {
			assigned = handler;
		},
	});
}
