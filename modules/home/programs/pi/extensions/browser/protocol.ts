// The wire protocol between Claude Code and the Claude in Chrome native host,
// as Claude Code 2.1.322 speaks it. See README.md for the full description.
import { lstat, readdir, stat } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";

/** The native host drops a client that announces more (its own limit). */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;
/** What Claude Code sends as `client_id`; the extension knows it. */
export const CLIENT_ID = "claude-code";

/** A frame: a 4-byte little-endian length, then that many bytes of UTF-8 JSON. */
export function encodeFrame(message: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	const head = Buffer.alloc(4);
	head.writeUInt32LE(body.length, 0);
	return Buffer.concat([head, body]);
}

/** Splits a byte stream into frames; whatever is left over waits for the next chunk. */
export class FrameDecoder {
	private buffer = Buffer.alloc(0);

	/** The JSON messages completed by `chunk`. Throws on a length the host would also refuse. */
	push(chunk: Buffer): unknown[] {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
		const out: unknown[] = [];
		while (this.buffer.length >= 4) {
			const length = this.buffer.readUInt32LE(0);
			if (length === 0 || length > MAX_FRAME_BYTES) throw new Error(`Invalid frame length ${length}`);
			if (this.buffer.length < 4 + length) break;
			const body = this.buffer.subarray(4, 4 + length);
			this.buffer = this.buffer.subarray(4 + length);
			out.push(JSON.parse(body.toString("utf8")));
		}
		return out;
	}

	get pending(): number {
		return this.buffer.length;
	}
}

export type PermissionMode = "ask" | "skip_all_permission_checks" | "follow_a_plan";

export type CallOptions = {
	permissionMode?: PermissionMode;
	/** Answer the extension's permission prompts over the socket instead of in the browser. */
	handlePermissionPrompts?: boolean;
	/** Each session gets its own tab group, as Claude Code's sessions do. */
	sessionScope?: { sessionId: string; tabGroupId?: number };
};

export type ToolRequest = {
	method: "execute_tool";
	params: {
		client_id: string;
		tool: string;
		args: Record<string, unknown>;
		tool_use_id: string;
		permission_mode?: PermissionMode;
		handle_permission_prompts?: true;
		session_scope?: { sessionId: string; tabGroupId?: number };
	};
};

export function toolRequest(tool: string, args: Record<string, unknown>, toolUseId: string, options: CallOptions = {}): ToolRequest {
	return {
		method: "execute_tool",
		params: {
			client_id: CLIENT_ID,
			tool,
			args,
			tool_use_id: toolUseId,
			...(options.permissionMode && { permission_mode: options.permissionMode }),
			...(options.handlePermissionPrompts && { handle_permission_prompts: true as const }),
			...(options.sessionScope && { session_scope: options.sessionScope }),
		},
	};
}

export type ContentBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string } | { type: string; [key: string]: unknown };

/** What the extension answers: a tool result, or an error, tagged with the request's id. */
export type ToolResponse = {
	tool_use_id?: string;
	result?: { content?: ContentBlock[] | string; isError?: boolean; is_error?: boolean; [key: string]: unknown };
	error?: { content?: ContentBlock[] | string; [key: string]: unknown };
};

export type Notification = { method: string; params?: Record<string, unknown> };

export type Incoming = { kind: "response"; response: ToolResponse } | { kind: "notification"; notification: Notification } | { kind: "unknown"; message: unknown };

/** Sorts what the host relays: the host strips its `type`, leaving a response or a notification. */
export function classify(message: unknown): Incoming {
	if (message && typeof message === "object") {
		const m = message as Record<string, unknown>;
		if (typeof m.method === "string") return { kind: "notification", notification: m as Notification };
		if ("result" in m || "error" in m) return { kind: "response", response: m as ToolResponse };
	}
	return { kind: "unknown", message };
}

export function permissionResponse(requestId: string, allowed: boolean): Notification {
	return { method: "permission_response", params: { request_id: requestId, allowed } };
}

// The host listens on /tmp/claude-mcp-browser-bridge-<user>/<pid>.sock (/tmp, not
// $TMPDIR, so every process of the user finds it). One host runs per browser
// profile that has the extension.
export function socketDir(user = userName()): string {
	return `/tmp/claude-mcp-browser-bridge-${user}`;
}

function userName(): string {
	try {
		return userInfo().username || "default";
	} catch {
		return process.env.USER || process.env.USERNAME || "default";
	}
}

export type SocketCandidate = { path: string; pid: number; mtimeMs: number };

/**
 * The host sockets, newest first, after Claude Code's checks: the folder is a real
 * 0700 folder of ours and each socket is a 0600 socket of ours. A socket whose
 * process is gone is left out (the host removes those when it next starts).
 */
export async function findSockets(dir = socketDir(), isAlive = processAlive): Promise<SocketCandidate[]> {
	let info;
	try {
		info = await lstat(dir);
	} catch {
		return [];
	}
	const uid = process.getuid?.();
	if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${dir} is not a directory`);
	if ((info.mode & 0o777) !== 0o700) throw new Error(`${dir} has mode ${(info.mode & 0o777).toString(8)}, expected 700`);
	if (uid !== undefined && info.uid !== uid) throw new Error(`${dir} is not owned by this user`);
	const out: SocketCandidate[] = [];
	for (const name of await readdir(dir)) {
		const match = /^(\d+)\.sock$/.exec(name);
		if (!match) continue;
		const path = join(dir, name);
		const s = await stat(path).catch(() => null);
		if (!s?.isSocket() || (s.mode & 0o777) !== 0o600 || (uid !== undefined && s.uid !== uid)) continue;
		const pid = Number(match[1]);
		if (!isAlive(pid)) continue;
		out.push({ path, pid, mtimeMs: s.mtimeMs });
	}
	return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** The text of a response's content, joined. */
export function contentText(content: ContentBlock[] | string | undefined): string {
	if (typeof content === "string") return content;
	return (content ?? [])
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof (block as { text?: unknown }).text === "string")
		.map((block) => block.text)
		.join("\n");
}
