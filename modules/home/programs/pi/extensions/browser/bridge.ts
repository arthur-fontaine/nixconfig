// A client of Anthropic's Claude in Chrome bridge, as Claude Code 2.1.322's own
// (its createChromeContext sets a bridgeConfig and no local pairing): a WebSocket
// to wss://bridge.claudeusercontent.com/chrome/<account uuid>, signed in with
// Claude Code's OAuth token, relaying tool calls to the extension paired with
// the same claude.ai account. See README.md.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BrowserNotConnectedError, DisconnectedMidCallError, ToolTimeoutError } from "./client.ts";
import type { CallOptions, ToolResponse } from "./protocol.ts";

export const BRIDGE_URL = "wss://bridge.claudeusercontent.com";
const CLIENT_TYPE = "claude-code";
const CONNECT_TIMEOUT_MS = 10_000;
const DISCOVERY_WAIT_MS = 10_000;
const KEEPALIVE_MS = 30_000;
const DEAD_AFTER_MS = 90_000;

export type SocketLike = {
	send(data: string): void;
	close(): void;
	addEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void;
};

export type BridgeCredentials = { accessToken: string; accountUuid: string };

export type Extension = { deviceId: string; name?: string; osPlatform?: string; connectedAt: number };

export type PermissionHandler = (params: Record<string, unknown>) => Promise<boolean> | boolean;

export type CallToolOptions = CallOptions & { timeoutMs?: number; signal?: AbortSignal; onPermissionRequest?: PermissionHandler };

/** What calls.ts needs from a transport: this client, or the native socket's. */
export interface BrowserTransport {
	callTool(tool: string, args: Record<string, unknown>, options?: CallToolOptions): Promise<ToolResponse>;
	close(): void;
}

export type BridgeOptions = {
	credentials: () => Promise<BridgeCredentials>;
	createSocket?: (url: string) => SocketLike;
	/** The bridge device ids of this computer's browsers, preferred when several are on the bridge. */
	localDeviceIds?: () => Promise<Set<string>>;
	discoveryWaitMs?: number;
	log?: (message: string) => void;
};

type Pending = {
	resolve: (r: ToolResponse) => void;
	reject: (e: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	timeoutMs: number;
	onPermissionRequest?: PermissionHandler;
};

export class BridgeWsClient implements BrowserTransport {
	private socket: SocketLike | null = null;
	private ready: Promise<void> | null = null;
	private readonly pending = new Map<string, Pending>();
	private listWaiters: ((list: Extension[]) => void)[] = [];
	private peerWaiters: (() => void)[] = [];
	private keepAlive: ReturnType<typeof setInterval> | undefined;
	private lastPong = 0;
	private selected: string | undefined;
	private chosen: string | undefined;
	private readonly options: BridgeOptions;

	constructor(options: BridgeOptions) {
		this.options = options;
	}

	/** select_browser's choice, kept for the next calls. */
	select(deviceId: string | undefined) {
		this.chosen = deviceId;
		this.selected = deviceId;
	}

	get selectedDeviceId() {
		return this.selected;
	}

	ensureConnected(): Promise<void> {
		this.ready ??= this.connect().catch((error) => {
			this.ready = null;
			throw error;
		});
		return this.ready;
	}

	private async connect(): Promise<void> {
		const { accessToken, accountUuid } = await this.options.credentials();
		const socket = (this.options.createSocket ?? ((url) => new WebSocket(url) as unknown as SocketLike))(`${BRIDGE_URL}/chrome/${accountUuid}`);
		this.socket = socket;
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new BrowserNotConnectedError("The Claude in Chrome bridge did not answer in time.")), CONNECT_TIMEOUT_MS);
			let settled = false;
			const settle = (error?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				error ? reject(error) : resolve();
			};
			socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "connect", client_type: CLIENT_TYPE, oauth_token: accessToken })));
			socket.addEventListener("message", (event) => {
				let message: any;
				try {
					message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
				} catch {
					return;
				}
				if (message.type === "paired" || message.type === "waiting") settle();
				this.handle(message);
			});
			socket.addEventListener("close", (event) => {
				settle(new BrowserNotConnectedError(`The Claude in Chrome bridge closed the connection (code ${event?.code ?? "?"}). Check that Claude Code is signed in (run \`claude\` once).`));
				this.lost(socket);
			});
			socket.addEventListener("error", () => settle(new BrowserNotConnectedError("Could not reach the Claude in Chrome bridge.")));
		});
		this.lastPong = Date.now();
		this.keepAlive = setInterval(() => {
			if (Date.now() - this.lastPong > DEAD_AFTER_MS) {
				this.options.log?.("bridge: no pong, reconnecting");
				socket.close();
				this.lost(socket);
				return;
			}
			this.send({ type: "ping" });
		}, KEEPALIVE_MS);
		this.keepAlive.unref?.();
	}

	private lost(socket: SocketLike) {
		if (this.socket !== socket) return;
		this.socket = null;
		this.ready = null;
		clearInterval(this.keepAlive);
		this.selected = this.chosen;
		for (const [id, call] of this.pending) {
			clearTimeout(call.timer);
			this.pending.delete(id);
			call.reject(new DisconnectedMidCallError("The Claude in Chrome bridge connection closed before the tool responded"));
		}
	}

	private send(message: unknown): boolean {
		if (!this.socket) return false;
		this.socket.send(JSON.stringify(message));
		return true;
	}

	private handle(m: any) {
		switch (m.type) {
			case "ping":
				this.send({ type: "pong" });
				break;
			case "pong":
				this.lastPong = Date.now();
				break;
			case "extensions_list": {
				const waiters = this.listWaiters;
				this.listWaiters = [];
				for (const w of waiters) w(Array.isArray(m.extensions) ? m.extensions : []);
				break;
			}
			case "peer_connected": {
				const waiters = this.peerWaiters;
				this.peerWaiters = [];
				for (const w of waiters) w();
				break;
			}
			case "peer_disconnected":
				if (m.deviceId && m.deviceId === this.selected) this.selected = this.chosen === m.deviceId ? this.chosen : undefined;
				break;
			case "tool_result":
				this.result(m);
				break;
			case "permission_request":
				this.permission(m);
				break;
			case "error":
				this.options.log?.(`bridge error: ${String(m.error)}`);
				break;
		}
	}

	private result(m: any) {
		const id = m.tool_use_id;
		const call = typeof id === "string" ? this.pending.get(id) : undefined;
		if (!call) return;
		this.pending.delete(id);
		clearTimeout(call.timer);
		// Claude Code's normalizeBridgeResponse: {content, is_error} becomes a result or an error.
		if (m.result || m.error) call.resolve({ tool_use_id: id, ...(m.result && { result: m.result }), ...(m.error && { error: m.error }) });
		else if (m.is_error) call.resolve({ tool_use_id: id, error: { content: m.content } });
		else call.resolve({ tool_use_id: id, result: { content: m.content ?? [] } });
	}

	private permission(m: any) {
		const call = typeof m.tool_use_id === "string" ? this.pending.get(m.tool_use_id) : undefined;
		// Not our call (Claude Code's, another session's): theirs to answer.
		if (!call?.onPermissionRequest || typeof m.request_id !== "string") return;
		clearTimeout(call.timer);
		const { type: _type, ...params } = m;
		void Promise.resolve(call.onPermissionRequest(params))
			.catch(() => false)
			.then((allowed) => {
				this.send({ type: "permission_response", request_id: m.request_id, allowed, ...(this.selected && { target_device_id: this.selected }) });
				if (this.pending.get(m.tool_use_id) === call) call.timer = this.timer(m.tool_use_id, call.timeoutMs);
			});
	}

	/** The extensions on the bridge for this account, one per device. */
	async listExtensions(): Promise<Extension[]> {
		await this.ensureConnected();
		const list = await new Promise<Extension[]>((resolve) => {
			const timer = setTimeout(() => resolve([]), 5_000);
			this.listWaiters.push((l) => {
				clearTimeout(timer);
				resolve(l);
			});
			this.send({ type: "list_extensions" });
		});
		const byDevice = new Map<string, Extension>();
		for (const e of list) {
			if (typeof e?.deviceId !== "string") continue;
			const seen = byDevice.get(e.deviceId);
			if (!seen || (e.connectedAt ?? 0) > seen.connectedAt) byDevice.set(e.deviceId, { ...e, connectedAt: e.connectedAt ?? 0 });
		}
		return [...byDevice.values()];
	}

	private async pick(): Promise<string> {
		if (this.selected) return this.selected;
		let list = await this.listExtensions();
		if (list.length === 0) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, this.options.discoveryWaitMs ?? DISCOVERY_WAIT_MS);
				this.peerWaiters.push(() => {
					clearTimeout(timer);
					resolve();
				});
			});
			list = await this.listExtensions();
		}
		if (list.length === 0)
			throw new BrowserNotConnectedError(
				"No browser with the Claude extension is connected for this claude.ai account. Open Some Browser (the extension must be signed in to the same account as Claude Code) and retry.",
			);
		let pick = list.length === 1 ? list[0] : undefined;
		if (!pick) {
			const local = (await this.options.localDeviceIds?.().catch(() => undefined)) ?? new Set<string>();
			const mine = list.filter((e) => local.has(e.deviceId));
			const candidates = mine.length > 0 ? mine : list.filter((e) => e.osPlatform === "macOS");
			pick = (candidates.length > 0 ? candidates : list).sort((a, b) => b.connectedAt - a.connectedAt)[0];
		}
		this.selected = pick!.deviceId;
		return this.selected;
	}

	private timer(id: string, timeoutMs: number) {
		return setTimeout(() => {
			const call = this.pending.get(id);
			if (!call) return;
			this.pending.delete(id);
			call.reject(new ToolTimeoutError(`Tool request timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	}

	async callTool(tool: string, args: Record<string, unknown>, options: CallToolOptions = {}): Promise<ToolResponse> {
		await this.ensureConnected();
		const target = await this.pick();
		const id = randomUUID();
		const timeoutMs = options.timeoutMs ?? 60_000;
		const frame = {
			type: "tool_call",
			tool_use_id: id,
			client_type: CLIENT_TYPE,
			tool,
			args,
			supports_tool_result_notices: true,
			supports_tool_result_error_code: true,
			target_device_id: target,
			permission_mode: options.permissionMode ?? "ask",
			...(options.onPermissionRequest && { handle_permission_prompts: true }),
			...(options.sessionScope && { session_scope: options.sessionScope }),
		};
		const { signal } = options;
		if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
		return new Promise<ToolResponse>((resolve, reject) => {
			const abort = () => {
				const call = this.pending.get(id);
				if (!call) return;
				clearTimeout(call.timer);
				this.pending.delete(id);
				reject(signal?.reason ?? new Error("Aborted"));
			};
			signal?.addEventListener("abort", abort, { once: true });
			const done =
				<T>(fn: (v: T) => void) =>
				(v: T) => {
					signal?.removeEventListener("abort", abort);
					fn(v);
				};
			this.pending.set(id, { resolve: done(resolve), reject: done(reject), timer: this.timer(id, timeoutMs), timeoutMs, onPermissionRequest: options.onPermissionRequest });
			if (!this.send(frame)) {
				clearTimeout(this.pending.get(id)!.timer);
				this.pending.delete(id);
				done(reject)(new BrowserNotConnectedError("The Claude in Chrome bridge is not connected"));
			}
		});
	}

	close() {
		const socket = this.socket;
		if (socket) {
			this.lost(socket);
			socket.close();
		}
	}
}

/**
 * The claude.ai account the bridge URL names: Claude Code's own record of its login
 * (`oauthAccount.accountUuid` in ~/.claude.json, or $CLAUDE_CONFIG_DIR/.claude.json).
 */
export async function claudeAccountUuid(): Promise<string> {
	const dir = process.env.CLAUDE_CONFIG_DIR;
	const files = dir ? [path.join(dir, ".claude.json")] : [path.join(os.homedir(), ".claude.json"), path.join(os.homedir(), ".claude", ".claude.json")];
	for (const file of files) {
		try {
			const uuid = JSON.parse(await readFile(file, "utf8"))?.oauthAccount?.accountUuid;
			if (typeof uuid === "string" && uuid) return uuid;
		} catch {}
	}
	if (process.env.CLAUDE_CODE_ACCOUNT_UUID) return process.env.CLAUDE_CODE_ACCOUNT_UUID;
	throw new Error("No Claude Code account found. Run `claude` and /login first.");
}
