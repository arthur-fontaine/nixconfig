import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Subagents (@tintinweb/pi-subagents) are sessions inside this Pi, with every extension
// loaded but no UI, that record their parent session. Claude Code's mods only ran in the
// main session; here they would warm, classify or compact each subagent's session too.
export function isSubagentSession(ctx: ExtensionContext): boolean {
	return !ctx.hasUI && (Boolean(ctx.sessionManager.getHeader()?.parentSession) || !ctx.sessionManager.getSessionFile());
}

// The extension's handlers, skipped for the whole of a subagent's session.
export function mainSessionOnly(pi: ExtensionAPI): ExtensionAPI {
	let subagent = false;
	return new Proxy(pi, {
		get(target, key) {
			if (key === "on") {
				return (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
					(target.on as (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => void)(event, (payload, ctx) => {
						if (event === "session_start") subagent = isSubagentSession(ctx);
						return subagent ? undefined : handler(payload, ctx);
					});
			}
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
