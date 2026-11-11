// Test-only: what /rewind does to the session, without its picker (which needs the TUI).
// /test-rewind-cancel: the picker opened and closed, nothing applied (no navigation).
// /test-rewind-apply: "Restore conversation" on the first prompt: abort if running, then
// navigateTree to it, as rewind/extension.ts does.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("test-rewind-cancel", { handler: async () => {} });
	pi.registerCommand("test-rewind-apply", {
		handler: async (_args, ctx) => {
			if (!ctx.isIdle()) {
				ctx.abort();
				await ctx.waitForIdle();
			}
			const first = ctx.sessionManager
				.getBranch()
				.find((e) => e.type === "message" && (e as { message: { role: string } }).message.role === "user");
			if (first) await ctx.navigateTree(first.id);
		},
	});
}
