// Pi's startup header without its "Pi can explain its own features…" line. No setting
// hides only that line (quietStartup hides the whole header), so this wraps Pi's own
// header and leaves the rest of it as Pi draws it: logo, key hints, Ctrl+O expansion.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { withoutOnboarding } from "./lines.ts";

interface BuiltInHeader extends Component {
	onLogoClick?: unknown;
	setExpanded?(expanded: boolean): void;
}

// Pi's header is the only component with a logo click handler; its class isn't exported.
function findHeader(component: Component): BuiltInHeader | undefined {
	if ("onLogoClick" in component) return component;
	for (const child of (component as { children?: Component[] }).children ?? []) {
		const found = findHeader(child);
		if (found) return found;
	}
	return undefined;
}

export default function startupHeader(pi: ExtensionAPI) {
	// Kept across sessions: once replaced, Pi's header is no longer in the tree.
	let builtIn: BuiltInHeader | undefined;
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		let missing = false;
		ctx.ui.setHeader((tui: TUI) => {
			builtIn ??= findHeader(tui);
			const header = builtIn;
			if (!header) {
				missing = true;
				return { render: () => [], invalidate() {} };
			}
			return {
				render: (width) => withoutOnboarding(header.render(width)),
				invalidate: () => header.invalidate(),
				handleMouse: header.handleMouse?.bind(header),
				setExpanded: (expanded: boolean) => header.setExpanded?.(expanded),
			} as Component;
		});
		// Pi drew no header (quietStartup): give the slot back.
		if (missing) ctx.ui.setHeader(undefined);
	});
}
