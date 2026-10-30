// input-autocomplete for Pi: ghost text in the editor with five guesses at
// what you'll type next, or at how your draft goes on, from Claude Haiku
// through the claude-code provider. Tab or Right accepts, Down/Up switch.
// Also keeps the editor's up-arrow history complete for the session branch.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { prompts } from "./context.ts";
import { GhostEditor } from "./editor.ts";
import { MODEL, PROVIDER, Predictor } from "./predictor.ts";

export default function (pi: ExtensionAPI) {
	let predictor: Predictor | undefined;
	let editor: GhostEditor | undefined;

	// A fresh editor each time: Pi's history can only be added to, and after
	// /tree it has to hold the new branch's prompts.
	function install(ctx: ExtensionContext, current: Predictor) {
		ctx.ui.setEditorComponent((tui, theme, keys) => {
			const next = new GhostEditor(tui, theme, keys, {
				predictor: current,
				style: (text) => ctx.ui.theme.fg("dim", text),
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
	});

	pi.on("session_shutdown", async () => {
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
