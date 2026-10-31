// input-autocomplete for Pi: ghost text in the editor with five guesses at
// what you'll type next, or at how your draft goes on, from Claude Haiku
// through the claude-code provider. Tab or Right accepts, Down/Up switch.
// Also keeps the editor's up-arrow history complete for the session branch.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { prompts } from "./context.ts";
import { GhostEditor } from "./editor.ts";
import { MODEL, PROVIDER, Predictor } from "./predictor.ts";

export default function (pi: ExtensionAPI) {
	let predictor: Predictor | undefined;
	let editor: GhostEditor | undefined;
	let stopKeys: (() => void) | undefined;

	// /rename (the session-name extension) replaces Pi's /name: typing /name runs it,
	// and only /rename is offered.
	let hidingAliases = false;
	const aliases = (): Record<string, string> => (pi.getCommands().some((command) => command.name === "rename") ? { name: "rename" } : {});

	// A fresh editor each time: Pi's history can only be added to, and after
	// /tree it has to hold the new branch's prompts.
	function install(ctx: ExtensionContext, current: Predictor) {
		ctx.ui.setEditorComponent((tui, theme, keys) => {
			const next = new GhostEditor(tui, theme, keys, {
				predictor: current,
				style: (text) => ctx.ui.theme.fg("dim", text),
				commandStyle: (text) => ctx.ui.theme.fg("accent", text),
				commandAliases: aliases,
			});
			const session = ctx.sessionManager;
			next.seedHistory(prompts(session.getBranch()), prompts(session.buildContextEntries()));
			if (!ctx.isIdle()) next.pause();
			editor?.dispose();
			editor = next;
			return next;
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		editor?.dispose();
		editor = undefined;
		predictor = undefined;
		if (ctx.mode !== "tui") return;
		predictor = new Predictor(ctx);
		install(ctx, predictor);
		// Pi runs input listeners in the order they were added, and loads this directory's
		// extensions before packages': this one sees Down ahead of pi-subagents' FleetView,
		// which adds its own in its session_start. One it adds again later goes last.
		stopKeys?.();
		stopKeys = ctx.ui.onTerminalInput((data) => (editor?.takeKey(data) ? { consume: true } : undefined));
		if (hidingAliases) return;
		hidingAliases = true;
		// Pi's provider is a class: its methods are passed on one by one, not spread.
		ctx.ui.addAutocompleteProvider(
			(current): AutocompleteProvider => ({
				triggerCharacters: current.triggerCharacters,
				applyCompletion: (...args) => current.applyCompletion(...args),
				shouldTriggerFileCompletion: current.shouldTriggerFileCompletion?.bind(current),
				async getSuggestions(lines, line, col, options) {
					const found = await current.getSuggestions(lines, line, col, options);
					if (!found?.prefix.startsWith("/") || found.prefix.includes(" ")) return found;
					const hidden = aliases();
					const items = found.items.filter((item) => !(item.value in hidden));
					return items.length > 0 ? { ...found, items } : null;
				},
			}),
		);
	});

	pi.on("session_shutdown", async () => {
		stopKeys?.();
		stopKeys = undefined;
		editor?.dispose();
		editor = undefined;
		predictor = undefined;
	});

	pi.on("agent_start", async () => {
		editor?.pause();
	});

	pi.on("agent_settled", async (_event, ctx) => {
		if (ctx.isIdle()) editor?.resume();
	});

	pi.on("session_tree", async (_event, ctx) => {
		if (!predictor || ctx.mode !== "tui") return;
		predictor.reset();
		install(ctx, predictor);
	});

	pi.registerCommand("autocomplete-context", {
		description: `Show what the last autocomplete request sent to ${PROVIDER}/${MODEL}, or a preview for a draft`,
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/autocomplete-context needs the interactive terminal", "error");
				return;
			}
			const shown = predictor ?? new Predictor(ctx);
			await ctx.ui.editor("Autocomplete request (edits are discarded)", shown.describe(args.trim()));
		},
	});
}
