import type { TUI } from "@earendil-works/pi-tui";

/** What the fullscreen renderer's link clicks and terminal input go through. */
export interface TuiHooks {
	/** Opens `url` and returns true, or returns false to leave it to Pi. */
	openUrl(url: string): boolean;
	/** Runs `next`, Pi's handling of one input sequence. */
	input(data: string, next: () => void): void;
}

// Global so that a reloaded extension finds the wrappers an earlier load put
// on the same renderer.
const HOOKED = Symbol.for("pi-extension-image-view.tui-hooks");

type Hooked = { hooks: TuiHooks | undefined };

// Both members are private in pi-tui's types. `openUrl` is the option Pi passes
// TuiAltScreen (`openBrowser`, so `open`) and calls on a click on an OSC 8 link.
// `handleTerminalInput` gets every input sequence before the renderer's own
// mouse handling, which consumes mouse sequences ahead of any
// `ctx.ui.onTerminalInput` listener.
type RendererInternals = {
	readonly mode: TUI["mode"];
	openUrl?: (url: string) => void;
	handleTerminalInput: (data: string) => void;
	[HOOKED]?: Hooked;
};

/**
 * Routes the fullscreen renderer's link clicks and input through `hooks`, or
 * back to Pi alone when undefined. Each renderer is wrapped once: switching
 * modes makes a new one, and a reload only swaps the hooks.
 */
export function hookTui(tui: TUI, hooks: TuiHooks | undefined): void {
	const renderer = tui as unknown as RendererInternals;
	if (renderer.mode !== "fullscreen") return;
	const hooked = renderer[HOOKED];
	if (hooked) {
		hooked.hooks = hooks;
		return;
	}
	if (!hooks) return;
	const state: Hooked = { hooks };
	renderer[HOOKED] = state;
	// Checked rather than trusted: a Pi release may rename either.
	const openUrl = typeof renderer.openUrl === "function" ? renderer.openUrl.bind(renderer) : undefined;
	const handleTerminalInput = typeof renderer.handleTerminalInput === "function" ? renderer.handleTerminalInput.bind(renderer) : undefined;
	if (openUrl) {
		renderer.openUrl = (url) => {
			if (!state.hooks?.openUrl(url)) openUrl(url);
		};
	}
	if (handleTerminalInput) {
		renderer.handleTerminalInput = (data) => {
			if (state.hooks) state.hooks.input(data, () => handleTerminalInput(data));
			else handleTerminalInput(data);
		};
	}
}
