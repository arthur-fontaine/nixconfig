// A client of the Claude in Chrome native host's socket, as Claude Code's own.
// The host relays every reply to every client connected to it, so replies are
// matched to calls by tool_use_id and the others' are ignored: Claude Code and
// several Pi sessions share one host.
import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import {
	type CallOptions,
	classify,
	encodeFrame,
	FrameDecoder,
	findSockets,
	type Notification,
	permissionResponse,
	type SocketCandidate,
	type ToolResponse,
	toolRequest,
} from "./protocol.ts";

export const DEFAULT_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 5_000;

export class BrowserNotConnectedError extends Error {
	override name = "BrowserNotConnectedError";
}

export class ToolTimeoutError extends Error {
	override name = "ToolTimeoutError";
}

export class DisconnectedMidCallError extends Error {
	override name = "DisconnectedMidCallError";
}

type Pending = {
	resolve: (response: ToolResponse) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
	timeoutMs: number;
	onPermissionRequest?: (params: Record<string, unknown>) => Promise<boolean> | boolean;
};

export type ClientOptions = {
	/** Where to look for sockets; tests point it at their own folder. */
	findSockets?: () => Promise<SocketCandidate[]>;
	log?: (message: string) => void;
	/** Sees every frame both ways (fixtures, debugging). */
	tap?: (direction: "out" | "in", message: unknown) => void;
};

export class BridgeClient {
	private socket: Socket | null = null;
	private connecting: Promise<Socket> | null = null;
	private readonly pending = new Map<string, Pending>();
	private readonly listeners = new Set<(n: Notification) => void>();
	private decoder = new FrameDecoder();
	socketPath: string | undefined;
	/** select_browser's choice: dialled first while it is alive. */
	preferredSocket: string | undefined;
	private readonly options: ClientOptions;

	constructor(options: ClientOptions = {}) {
		this.options = options;
	}

	get connected(): boolean {
		return !!this.socket && !this.socket.destroyed;
	}

	onNotification(listener: (n: Notification) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Connects to the newest live host socket, or throws BrowserNotConnectedError. */
	async ensureConnected(): Promise<Socket> {
		if (this.socket && !this.socket.destroyed) return this.socket;
		this.connecting ??= this.dial().finally(() => {
			this.connecting = null;
		});
		return this.connecting;
	}

	private async dial(): Promise<Socket> {
		const found = await (this.options.findSockets ?? (() => findSockets()))();
		const candidates = [...found.filter((c) => c.path === this.preferredSocket), ...found.filter((c) => c.path !== this.preferredSocket)];
		if (candidates.length === 0) throw new BrowserNotConnectedError(notConnectedMessage());
		let lastError: unknown;
		for (const candidate of candidates) {
			try {
				const socket = await openSocket(candidate.path);
				this.attach(socket);
				this.socketPath = candidate.path;
				this.options.log?.(`connected to ${candidate.path}`);
				return socket;
			} catch (error) {
				lastError = error;
			}
		}
		throw new BrowserNotConnectedError(`${notConnectedMessage()} (${String(lastError)})`);
	}

	private attach(socket: Socket) {
		this.socket = socket;
		this.decoder = new FrameDecoder();
		socket.on("data", (chunk: Buffer) => {
			let messages: unknown[];
			try {
				messages = this.decoder.push(chunk);
			} catch (error) {
				this.options.log?.(`bad frame: ${String(error)}`);
				socket.destroy();
				return;
			}
			for (const message of messages) {
				this.options.tap?.("in", message);
				this.dispatch(message);
			}
		});
		const closed = () => {
			if (this.socket !== socket) return;
			this.socket = null;
			this.failAll(new DisconnectedMidCallError("The native host connection closed before the tool responded"));
		};
		socket.on("close", closed);
		socket.on("error", (error) => {
			this.options.log?.(`socket error: ${String(error)}`);
			closed();
		});
	}

	private dispatch(message: unknown) {
		const incoming = classify(message);
		if (incoming.kind === "response") {
			const id = incoming.response.tool_use_id;
			// Untagged or someone else's (Claude Code's, another session's): not ours.
			const call = id ? this.pending.get(id) : undefined;
			if (!call || !id) return;
			this.pending.delete(id);
			clearTimeout(call.timer);
			call.resolve(incoming.response);
		} else if (incoming.kind === "notification") {
			const { notification } = incoming;
			if (notification.method === "permission_request" && this.answerPermission(notification.params ?? {})) return;
			for (const listener of this.listeners) listener(notification);
		}
	}

	private answerPermission(params: Record<string, unknown>): boolean {
		const id = typeof params.tool_use_id === "string" ? params.tool_use_id : undefined;
		const requestId = typeof params.request_id === "string" ? params.request_id : undefined;
		const call = id ? this.pending.get(id) : undefined;
		if (!call?.onPermissionRequest || !requestId) return false;
		// The prompt waits on the person, so the call's clock restarts once answered.
		clearTimeout(call.timer);
		void Promise.resolve(call.onPermissionRequest(params))
			.catch(() => false)
			.then((allowed) => {
				if (!this.pending.has(id!)) return;
				this.write(permissionResponse(requestId, allowed));
				call.timer = this.timer(id!, call.timeoutMs);
			});
		return true;
	}

	private timer(id: string, timeoutMs: number) {
		return setTimeout(() => {
			const call = this.pending.get(id);
			if (!call) return;
			this.pending.delete(id);
			call.reject(new ToolTimeoutError(`Tool request timed out after ${timeoutMs}ms`));
		}, timeoutMs);
	}

	private write(message: unknown) {
		if (!this.socket || this.socket.destroyed) throw new BrowserNotConnectedError(notConnectedMessage());
		this.options.tap?.("out", message);
		this.socket.write(encodeFrame(message));
	}

	/**
	 * Runs one of the extension's tools. Several calls may be in flight on one
	 * connection: each waits for the reply carrying its own id.
	 */
	async callTool(
		tool: string,
		args: Record<string, unknown>,
		options: CallOptions & {
			timeoutMs?: number;
			signal?: AbortSignal;
			onPermissionRequest?: Pending["onPermissionRequest"];
		} = {},
	): Promise<ToolResponse> {
		await this.ensureConnected();
		const id = randomUUID();
		const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		const { signal } = options;
		if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
		return new Promise<ToolResponse>((resolve, reject) => {
			const abort = () => {
				const call = this.pending.get(id);
				if (!call) return;
				this.pending.delete(id);
				clearTimeout(call.timer);
				reject(signal?.reason ?? new Error("Aborted"));
			};
			signal?.addEventListener("abort", abort, { once: true });
			const done = <T>(fn: (value: T) => void) => (value: T) => {
				signal?.removeEventListener("abort", abort);
				fn(value);
			};
			this.pending.set(id, {
				resolve: done(resolve),
				reject: done(reject),
				timer: this.timer(id, timeoutMs),
				timeoutMs,
				onPermissionRequest: options.onPermissionRequest,
			});
			try {
				this.write(
					toolRequest(tool, args, id, {
						permissionMode: options.permissionMode,
						handlePermissionPrompts: options.handlePermissionPrompts ?? !!options.onPermissionRequest,
						sessionScope: options.sessionScope,
					}),
				);
			} catch (error) {
				const call = this.pending.get(id);
				this.pending.delete(id);
				if (call) clearTimeout(call.timer);
				done(reject)(error as Error);
			}
		});
	}

	private failAll(error: Error) {
		for (const [id, call] of this.pending) {
			clearTimeout(call.timer);
			this.pending.delete(id);
			call.reject(error);
		}
	}

	/** Uses another host from the next call on. */
	prefer(path: string | undefined) {
		this.preferredSocket = path;
		if (path && this.socketPath !== path && this.pending.size === 0) this.close();
	}

	close() {
		const socket = this.socket;
		this.socket = null;
		this.failAll(new DisconnectedMidCallError("The browser client was closed"));
		socket?.destroy();
	}
}

function openSocket(path: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = connect(path);
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`Timed out connecting to ${path}`));
		}, CONNECT_TIMEOUT_MS);
		socket.once("connect", () => {
			clearTimeout(timer);
			socket.removeAllListeners("error");
			resolve(socket);
		});
		socket.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

export function notConnectedMessage(): string {
	return (
		"Browser extension is not connected. Please ensure the Claude browser extension is installed and running " +
		"(https://claude.ai/chrome) in Some Browser, and that you are logged into claude.ai with the same account as Claude Code. " +
		"If Some Browser is closed, open it and retry."
	);
}
