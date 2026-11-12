// The extension's permission mode for one call, chosen as Claude Code 2.1.322's
// Chrome tools choose it (their `call`):
// - the session's permission system (here Pi's auto-mode classifier) let this call
//   through, its target host is known and no deny rule applies: the extension's
//   site checks are lifted for this one call (`skip_all_permission_checks`);
// - a known host otherwise: `follow_a_plan` with the allowed hosts, and the
//   extension's prompts answered by the client;
// - no host: `follow_a_plan` with the hosts allowed so far, or `ask`.
// Never session-wide: each call carries its own mode.
import type { PermissionHandler } from "./bridge.ts";
import type { PermissionMode } from "./protocol.ts";

export type CallPermissions = { permissionMode: PermissionMode; allowedDomains?: string[]; onPermissionRequest?: PermissionHandler };

export function callPermissions(input: {
	classifierAllowed: boolean;
	host: string | undefined;
	deniedHosts: readonly string[];
	allowedHosts?: readonly string[];
	onPermissionRequest: PermissionHandler;
}): CallPermissions {
	const { classifierAllowed, host, deniedHosts, onPermissionRequest } = input;
	if (classifierAllowed && host !== undefined && deniedHosts.length === 0) return { permissionMode: "skip_all_permission_checks" };
	const allowed = [...new Set([...(input.allowedHosts ?? []), ...(host !== undefined ? [host] : [])])];
	if (host !== undefined) return { permissionMode: "follow_a_plan", allowedDomains: allowed, onPermissionRequest };
	if (allowed.length > 0) return { permissionMode: "follow_a_plan", allowedDomains: allowed };
	return { permissionMode: "ask" };
}

/** The page a call acts on: navigate's URL (https:// when it has none), a batch's own navigate, else the tab's. */
export function targetUrl(tool: string, args: Record<string, unknown>, tabUrl: string | undefined): string | undefined {
	const navigateTo = (url: unknown) => {
		if (typeof url !== "string") return undefined;
		const u = url.trim();
		if (!u || u === "back" || u === "forward") return undefined;
		return /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`;
	};
	if (tool === "navigate") return navigateTo(args.url) ?? tabUrl;
	if (tool === "browser_batch" && Array.isArray(args.actions)) {
		for (const action of args.actions as { name?: unknown; input?: { url?: unknown } }[]) {
			if (action?.name === "navigate") {
				const url = navigateTo(action.input?.url);
				if (url) return url;
			}
		}
	}
	return tabUrl;
}

/** host[:port] of a web URL; none for chrome://, about:, file: and the like. */
export function hostOf(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		const u = new URL(url);
		return u.protocol === "http:" || u.protocol === "https:" ? u.host.toLowerCase() : undefined;
	} catch {
		return undefined;
	}
}
