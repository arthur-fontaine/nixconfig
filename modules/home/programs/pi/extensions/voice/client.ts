// The connection to the voice daemon: a Unix socket, one JSON object per line.
// The first /call starts the daemon when nothing answers, detached, so it outlives this Pi and
// serves every chat; started from Pi in Herdr, it uses Herdr's microphone permission.
import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export type DaemonEvent = { type: string; [key: string]: unknown };

const HOME = path.join(os.homedir(), ".cache", "pi-voice");

export function socketPath(): string {
	return process.env.PI_VOICE_SOCKET || path.join(HOME, "daemon.sock");
}

/** The daemon's command: PI_VOICE_DAEMON (a shell command, for tests and development), else the nix-installed one. */
function daemonCommand(): string {
	return process.env.PI_VOICE_DAEMON || "pi-voice serve";
}

export class Client {
	private socket: net.Socket | undefined;
	private buffer = "";
	private connecting: Promise<void> | undefined;

	constructor(
		private readonly onEvent: (event: DaemonEvent) => void,
		private readonly onClose: () => void,
	) {}

	get connected(): boolean {
		return this.socket !== undefined && !this.socket.destroyed;
	}

	/** Connects, starting the daemon first when none answers (unless PI_VOICE_NO_SPAWN). */
	connect(hello: { session: string; name: string }): Promise<void> {
		if (this.connected) return Promise.resolve();
		this.connecting ??= this.open(hello).finally(() => (this.connecting = undefined));
		return this.connecting;
	}

	private async open(hello: { session: string; name: string }): Promise<void> {
		const target = socketPath();
		let socket = await tryConnect(target);
		if (!socket) {
			if (process.env.PI_VOICE_NO_SPAWN) throw new Error(`no voice daemon on ${target}`);
			startDaemon(target);
			for (let i = 0; i < 100 && !socket; i++) {
				await new Promise((r) => setTimeout(r, 100));
				socket = await tryConnect(target);
			}
			if (!socket) throw new Error(`the voice daemon didn't start (log: ${path.join(HOME, "daemon.log")})`);
		}
		this.socket = socket;
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			this.buffer += chunk;
			let nl: number;
			while ((nl = this.buffer.indexOf("\n")) !== -1) {
				const line = this.buffer.slice(0, nl);
				this.buffer = this.buffer.slice(nl + 1);
				try {
					this.onEvent(JSON.parse(line));
				} catch {}
			}
		});
		socket.on("close", () => {
			this.socket = undefined;
			this.onClose();
		});
		socket.on("error", () => {});
		this.send({ type: "hello", ...hello });
	}

	send(message: Record<string, unknown>): void {
		if (this.connected) this.socket!.write(`${JSON.stringify(message)}\n`);
	}

	close(): void {
		this.socket?.end();
		this.socket = undefined;
	}
}

function tryConnect(target: string): Promise<net.Socket | undefined> {
	return new Promise((resolve) => {
		const s = net.connect(target);
		s.once("connect", () => resolve(s));
		s.once("error", () => resolve(undefined));
	});
}

function startDaemon(target: string): void {
	mkdirSync(HOME, { recursive: true });
	const log = openSync(path.join(HOME, "daemon.log"), "a");
	const child = spawn("/bin/sh", ["-c", `exec ${daemonCommand()} --socket '${target.replaceAll("'", "'\\''")}'`], {
		detached: true,
		stdio: ["ignore", log, log],
		env: process.env,
	});
	child.unref();
}
