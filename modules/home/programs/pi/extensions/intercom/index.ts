// pi-intercom, reduced to one gesture: `@<session> message` sends the message to that Pi
// session. The package is installed by Pi (settings.json) with its own extension disabled;
// this loads it without its commands, and adds the `@` completion and routing.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import path from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, type AutocompleteProvider, Text } from "@earendil-works/pi-tui";
import { addressees, matchingPeers, mentionAt, type Peer } from "./mentions.ts";

const PACKAGE = path.join(getAgentDir(), "npm", "node_modules", "pi-intercom", "index.ts");
// The @ mention replaces them: /intercom and alt+m open the send overlay, /alias names the
// session (the session-name extension does), /handover summarises it away.
const HIDDEN_COMMANDS = new Set(["intercom", "intercom-id", "intercom-pool", "alias", "handover"]);
const HIDDEN_SHORTCUTS = new Set(["alt+m"]);
// pi-intercom's public extension API (extension-api.ts).
const REGISTER = "intercom:extension-register";
const OUTBOX_REQUEST = "intercom:outbox-request";
const OUTBOX_RESULT = "intercom:outbox-result";
const MESSAGE_TYPE = "intercom-mention";

// Set PI_INTERCOM_MENTIONS_DEBUG to a file path to log what the mentions see.
function debug(...args: unknown[]) {
	const file = process.env.PI_INTERCOM_MENTIONS_DEBUG;
	if (file) appendFileSync(file, `${new Date().toISOString()} ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
}

interface OutboxResult {
	requestId: string;
	status: "sent" | "rejected" | "blocked" | "failed";
	detail?: string;
}

function withoutCommands(pi: ExtensionAPI): ExtensionAPI {
	return new Proxy(pi, {
		get(target, key) {
			if (key === "registerCommand") {
				return (name: string, options: any) => HIDDEN_COMMANDS.has(name) || target.registerCommand(name, options);
			}
			if (key === "registerShortcut") {
				return (shortcut: any, options: any) => HIDDEN_SHORTCUTS.has(shortcut) || target.registerShortcut(shortcut, options);
			}
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

export default async function intercom(pi: ExtensionAPI) {
	let load: (pi: ExtensionAPI) => unknown;
	try {
		load = (await import(PACKAGE)).default;
	} catch (error) {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify(`intercom: pi-intercom is not installed (${PACKAGE}): ${(error as Error).message}`, "warning");
		});
		return;
	}
	load(withoutCommands(pi));

	let peers: Peer[] = [];
	let listSessions: (() => Promise<any[]>) | undefined;
	let listedAt = 0;

	const toPeer = (s: any): Peer | undefined =>
		s.pid === process.pid || !s.name ? undefined : { name: s.name, cwd: s.cwd, status: s.status, unnamed: s.runtimeFallbackAlias };
	async function refresh() {
		if (!listSessions) return;
		try {
			peers = (await listSessions()).map(toPeer).filter((p): p is Peer => !!p);
			listedAt = Date.now();
		} catch (error) {
			debug("listSessions failed", (error as Error).message);
		}
		debug("peers", peers);
	}

	pi.events.emit(REGISTER, {
		namespace: "mentions",
		ownerEligible: false,
		onReady(channel: { listSessions(): Promise<any[]> }) {
			listSessions = () => channel.listSessions();
			void refresh();
		},
		onEvent(event: { type: string; connected?: boolean }) {
			if (event.type === "connection" ? event.connected : event.type.startsWith("session_") || event.type === "presence_update") void refresh();
		},
	});

	const pending = new Map<string, (result: OutboxResult) => void>();
	pi.events.on(OUTBOX_RESULT, (payload) => {
		const result = payload as OutboxResult;
		pending.get(result?.requestId)?.(result);
	});
	function send(to: string, message: string): Promise<OutboxResult> {
		const requestId = randomUUID();
		return new Promise((resolve) => {
			const timer = setTimeout(() => settle({ requestId, status: "failed", detail: "intercom did not answer" }), 15_000);
			function settle(result: OutboxResult) {
				clearTimeout(timer);
				pending.delete(requestId);
				resolve(result);
			}
			pending.set(requestId, settle);
			pi.events.emit(OUTBOX_REQUEST, { version: 1, requestId, extensionId: MESSAGE_TYPE, extensionName: "@ mentions", to, message });
		});
	}

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.addAutocompleteProvider((current): AutocompleteProvider => {
			const ours = new WeakSet<AutocompleteItem>();
			return {
				...current,
				triggerCharacters: [...new Set([...(current.triggerCharacters ?? []), "@"])],
				async getSuggestions(lines, cursorLine, cursorCol, options) {
					const token = mentionAt(lines[cursorLine] ?? "", cursorCol);
					const theirs = current.getSuggestions(lines, cursorLine, cursorCol, options);
					if (!token) return theirs;
					if (Date.now() - listedAt > 2000) await refresh();
					const items = matchingPeers(peers, token).map((p) => {
						const item = { value: `@${p.name}`, label: `@${p.name}`, description: [p.unnamed ? "unnamed session" : "session", p.status, p.cwd].filter(Boolean).join(" · ") };
						ours.add(item);
						return item;
					});
					const files = await theirs;
					if (items.length === 0) return files;
					return { prefix: token, items: [...items, ...(files?.prefix === token ? files.items : [])] };
				},
				applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
					if (!ours.has(item)) return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
					const line = lines[cursorLine] ?? "";
					const start = cursorCol - prefix.length;
					const next = [...lines];
					next[cursorLine] = `${line.slice(0, start)}${item.value} ${line.slice(cursorCol)}`;
					return { lines: next, cursorLine, cursorCol: start + item.value.length + 1 };
				},
			};
		});
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension" || !event.text.includes("@")) return { action: "continue" };
		await refresh();
		// A file of that name wins: `@notes` stays Pi's file reference when ./notes exists.
		const reachable = peers.filter((p) => !existsSync(path.resolve(ctx.cwd, p.name)));
		const addressed = addressees(event.text, reachable);
		if (!addressed) return { action: "continue" };
		void deliver(addressed.to, addressed.message, event.text, (event.images?.length ?? 0) > 0, ctx);
		return { action: "handled" };
	});

	async function deliver(to: string[], message: string, original: string, hadImages: boolean, ctx: ExtensionContext) {
		const results = await Promise.all(to.map((name) => send(name, message).then((result) => ({ name, result }))));
		const sent = results.filter((r) => r.result.status === "sent").map((r) => r.name);
		for (const { name, result } of results) {
			if (result.status !== "sent") ctx.ui.notify(`Not sent to @${name}: ${result.detail ?? result.status}`, "error");
		}
		if (hadImages && sent.length) ctx.ui.notify("intercom sends text only: the images were not sent.", "warning");
		if (sent.length === 0) {
			if (!ctx.ui.getEditorText().trim()) ctx.ui.setEditorText(original);
			return;
		}
		// In the conversation too, so this session's agent understands the replies.
		pi.sendMessage(
			{
				customType: MESSAGE_TYPE,
				content: `The user sent this message to the Pi session${sent.length > 1 ? "s" : ""} ${sent.map((n) => `"${n}"`).join(", ")} through intercom:\n\n${message}`,
				display: true,
				details: { to: sent, message },
			},
			ctx.isIdle() ? { triggerTurn: false } : { deliverAs: "nextTurn" },
		);
	}

	pi.registerMessageRenderer<{ to: string[]; message: string }>(MESSAGE_TYPE, (message, options, theme) => {
		const details = message.details;
		if (!details) return undefined;
		const head = theme.fg("accent", `→ ${details.to.map((n) => `@${n}`).join(" ")}`);
		return new Text(`${head} ${details.message}`, options.outputPad, 0);
	});
}
