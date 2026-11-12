// What Claude Code does around a Claude in Chrome call before and after the
// extension runs it: the parts of each tool that live in the client.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import type { BridgeClient } from "./client.ts";
import { type CallOptions, type ContentBlock, contentText, findSockets, type ToolResponse } from "./protocol.ts";
import { stripSaveToDisk } from "./tools.ts";

const run = promisify(execFile);

// Claude Code's per-call timeouts: a batch gets longer.
export function timeoutFor(tool: string): number {
	return tool === "browser_batch" ? 90_000 : 60_000;
}

export type PiContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** The extension's blocks as Pi's: MCP-style images, or Anthropic-style ones with a `source`. */
export function toPiContent(content: ContentBlock[] | string | undefined): PiContent[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	const out: PiContent[] = [];
	for (const block of content ?? []) {
		const b = block as Record<string, any>;
		if (b.type === "text" && typeof b.text === "string") out.push({ type: "text", text: b.text });
		else if (b.type === "image" && typeof b.data === "string") out.push({ type: "image", data: b.data, mimeType: b.mimeType ?? b.mime_type ?? "image/png" });
		else if (b.type === "image" && b.source?.type === "base64") out.push({ type: "image", data: b.source.data, mimeType: b.source.media_type ?? "image/png" });
	}
	return out;
}

export class ToolError extends Error {
	override name = "ToolError";
}

/** A result's content, or a ToolError with its text when the extension refused or failed. */
export function unwrap(response: ToolResponse): PiContent[] {
	if (response.error) throw new ToolError(contentText(response.error.content) || "The browser extension returned an error");
	const result = response.result;
	if (!result) throw new ToolError("The browser extension returned no result");
	const content = toPiContent(result.content);
	if (result.isError || result.is_error) throw new ToolError(content.filter((c) => c.type === "text").map((c) => c.text).join("\n") || "The tool failed");
	return content;
}

/** The tab list in a tabs_context_mcp reply, if there is one. */
export function tabContext(content: PiContent[]): { tabId?: number; tabGroupId?: number; json: string } | undefined {
	for (const block of content) {
		if (block.type !== "text") continue;
		try {
			const parsed = JSON.parse(block.text) as { availableTabs?: { tabId?: unknown }[]; tabGroupId?: unknown };
			if (!Array.isArray(parsed.availableTabs)) continue;
			const tabId = parsed.availableTabs.find((t) => typeof t?.tabId === "number")?.tabId as number | undefined;
			return { tabId, tabGroupId: typeof parsed.tabGroupId === "number" ? parsed.tabGroupId : undefined, json: block.text };
		} catch {}
	}
	return undefined;
}

const MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".pdf": "application/pdf",
	".txt": "text/plain",
	".csv": "text/csv",
	".json": "application/json",
	".html": "text/html",
	".zip": "application/zip",
};
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** file_upload's `paths`, read here and sent as `files`, as Claude Code does. */
export async function readUploads(paths: unknown): Promise<{ data: string; name: string; mimeType: string }[]> {
	if (!Array.isArray(paths) || paths.length === 0) throw new ToolError("file_upload needs `paths`: absolute paths of the files to upload.");
	let total = 0;
	const files = [];
	for (const path of paths) {
		if (typeof path !== "string" || !path.startsWith("/")) throw new ToolError(`Not an absolute path: ${JSON.stringify(path)}`);
		const info = await stat(path).catch(() => null);
		if (!info?.isFile()) throw new ToolError(`No such file: ${path}`);
		total += info.size;
		if (total > MAX_UPLOAD_BYTES) throw new ToolError("The combined size of all files in a single call must stay under 10 MB.");
		files.push({ data: (await readFile(path)).toString("base64"), name: basename(path), mimeType: MIME[extname(path).toLowerCase()] ?? "application/octet-stream" });
	}
	return files;
}

/** save_to_disk: the screenshot goes in a file and its path in the result. */
export function saveImages(content: PiContent[], dir = join(tmpdir(), "pi-browser-screenshots")): PiContent[] {
	const out: PiContent[] = [...content];
	for (const block of content) {
		if (block.type !== "image") continue;
		const bytes = Buffer.from(block.data, "base64");
		const ext = block.mimeType === "image/jpeg" ? "jpg" : block.mimeType.split("/")[1] ?? "png";
		const path = join(dir, `screenshot-${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.${ext}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(path, bytes);
		out.push({ type: "text", text: `Saved screenshot to ${path}` });
	}
	return out;
}

/** The browsers reachable here: one native host per browser profile that has the extension. */
export async function listBrowsers(): Promise<{ deviceId: string; name: string; socket: string }[]> {
	const sockets = await findSockets();
	const out = [];
	for (const socket of sockets) {
		// The host's parent is the browser that started it.
		const parent = await run("/bin/ps", ["-o", "ppid=", "-p", String(socket.pid)]).catch(() => null);
		const ppid = parent?.stdout.trim();
		const command = ppid ? await run("/bin/ps", ["-o", "comm=", "-p", ppid]).catch(() => null) : null;
		const app = /\/([^/]+)\.app\//.exec(command?.stdout ?? "")?.[1] ?? "Chrome";
		out.push({ deviceId: `local-${socket.pid}`, name: app, socket: socket.path });
	}
	return out;
}

export type CallContext = {
	client: BridgeClient;
	options: () => CallOptions & { onPermissionRequest?: (p: Record<string, unknown>) => boolean | Promise<boolean> };
	signal?: AbortSignal;
	/** Called with the tab a call acts on, once known (for the live view). */
	onTab?: (tabId: number) => void;
	/** Keeps the tab group the extension reports, for later calls' scope. */
	onTabGroup?: (tabGroupId: number) => void;
	selectBrowser?: (socket: string | undefined) => void;
};

/** Runs one tool as Claude Code would, returning Pi content or throwing a ToolError. */
export async function callBrowserTool(tool: string, input: Record<string, unknown>, ctx: CallContext): Promise<PiContent[]> {
	if (tool === "list_connected_browsers") {
		const browsers = await listBrowsers();
		return [{ type: "text", text: JSON.stringify({ browsers: browsers.map(({ deviceId, name }) => ({ deviceId, name, isLocal: true, onThisComputer: true })) }) }];
	}
	if (tool === "select_browser") {
		const browser = (await listBrowsers()).find((b) => b.deviceId === input.deviceId);
		if (!browser) throw new ToolError(`No connected browser with deviceId ${JSON.stringify(input.deviceId)}. Call list_connected_browsers.`);
		ctx.selectBrowser?.(browser.socket);
		return [{ type: "text", text: `Selected ${browser.name} (${browser.deviceId}).` }];
	}
	if (tool === "switch_browser") {
		const browsers = await listBrowsers();
		return [
			{
				type: "text",
				text: `This session reaches browsers through their local native host, so there is no connection request to send. Connected: ${browsers.map((b) => `${b.name} (${b.deviceId})`).join(", ") || "none"}. Use select_browser with one of these deviceIds.`,
			},
		];
	}

	const { args: stripped, wantsSave } = stripSaveToDisk(tool, input);
	let args = stripped;
	if (tool === "file_upload") args = { ...args, files: await readUploads(args.paths) };

	const call = (name: string, a: Record<string, unknown>) =>
		ctx.client.callTool(name, a, { ...ctx.options(), timeoutMs: timeoutFor(name), signal: ctx.signal });

	// navigate without a tab: the session's first tab, made if need be, and its list appended.
	let appended: string | undefined;
	if (tool === "navigate" && args.tabId == null) {
		const url = typeof args.url === "string" ? args.url.trim().toLowerCase() : "";
		if (url === "back" || url === "forward") throw new ToolError('tabId is required for url:"back"/"forward". Call tabs_context_mcp first to get a tab ID.');
		if (url) {
			const found = tabContext(unwrap(await call("tabs_context_mcp", { createIfEmpty: true })));
			if (found?.tabGroupId !== undefined) ctx.onTabGroup?.(found.tabGroupId);
			if (found?.tabId !== undefined) {
				args = { ...args, tabId: found.tabId };
				appended = found.json;
			}
		}
	}
	if (typeof args.tabId === "number") ctx.onTab?.(args.tabId);
	else if (tool === "browser_batch") {
		const first = (args.actions as { input?: { tabId?: unknown } }[] | undefined)?.find((a) => typeof a?.input?.tabId === "number");
		if (first) ctx.onTab?.(first.input!.tabId as number);
	}

	let content = unwrap(await call(tool, args));
	if (tool === "tabs_context_mcp" || tool === "tabs_create_mcp") {
		const found = tabContext(content);
		if (found?.tabGroupId !== undefined) ctx.onTabGroup?.(found.tabGroupId);
	}
	if (appended) content = [...content, { type: "text", text: `\n\nTab context (tabs_context_mcp{createIfEmpty:true} was called for you):\n${appended}` }];
	if (wantsSave) content = saveImages(content);
	return content;
}
