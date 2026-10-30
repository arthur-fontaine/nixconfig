// Client for Claude Code's Remote Control service, playing the worker side that
// `claude --remote-control` plays. Reverse-engineered from Claude Code 2.1.314;
// the endpoints are private and can change without notice.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const API = "https://api.anthropic.com";
const USER_AGENT = "pi-remote-control/0.1.0";

export interface Credentials {
	accessToken: string;
	trustedDeviceToken?: string;
}

function keychainItem(): Promise<string> {
	return new Promise((resolve, reject) =>
		execFile(
			"security",
			["find-generic-password", "-a", os.userInfo().username, "-w", "-s", "Claude Code-credentials"],
			// Asynchronous and bounded: the Keychain can stall (it did while Pi's TUI quit),
			// and a synchronous call would freeze all of Pi.
			{ encoding: "utf8", timeout: 5000 },
			(error, stdout) => (error ? reject(error) : resolve(stdout)),
		),
	);
}

// Read-only: refreshing would rotate the token Claude Code itself holds, so an
// expired login is left for Claude Code to refresh.
export async function loadCredentials(): Promise<Credentials> {
	let doc: any;
	if (process.platform === "darwin") {
		try {
			doc = JSON.parse(await keychainItem());
		} catch {}
	}
	if (!doc) {
		const dir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
		try {
			doc = JSON.parse(await readFile(path.join(dir, ".credentials.json"), "utf8"));
		} catch {
			throw new Error("No Claude Code login found. Run `claude` and /login first.");
		}
	}
	const oauth = doc.claudeAiOauth;
	if (!oauth?.accessToken) throw new Error("No Claude Code login found. Run `claude` and /login first.");
	if (typeof oauth.expiresAt === "number" && oauth.expiresAt <= Date.now() + 60_000) {
		throw new Error("The Claude Code login has expired. Start `claude` once to refresh it.");
	}
	return {
		accessToken: oauth.accessToken,
		trustedDeviceToken: process.env.CLAUDE_TRUSTED_DEVICE_TOKEN ?? doc.trustedDeviceToken,
	};
}

export class HttpError extends Error {
	constructor(
		readonly status: number,
		readonly body: unknown,
		what: string,
	) {
		const message = (body as any)?.error?.message;
		super(`${what} failed (${status})${message ? `: ${message}` : ""}`);
	}
}

function headers(bearer: string, trustedDeviceToken?: string): Record<string, string> {
	return {
		Authorization: `Bearer ${bearer}`,
		"Content-Type": "application/json",
		"anthropic-version": "2023-06-01",
		"anthropic-client-platform": "claude_code_cli",
		"User-Agent": USER_AGENT,
		...(trustedDeviceToken && { "X-Trusted-Device-Token": trustedDeviceToken }),
	};
}

async function request(method: string, url: string, hdrs: Record<string, string>, body: unknown, what: string, timeoutMs = 15_000) {
	const res = await fetch(url, {
		method,
		headers: hdrs,
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await res.text();
	let data: any = text;
	try {
		data = text ? JSON.parse(text) : {};
	} catch {}
	if (!res.ok) throw new HttpError(res.status, data, what);
	return data;
}

export interface CodeSession {
	id: string;
	url: string;
}

export async function createSession(creds: Credentials, title: string, cwd: string, model?: string): Promise<CodeSession> {
	const data = await request(
		"POST",
		`${API}/v1/code/sessions`,
		headers(creds.accessToken, creds.trustedDeviceToken),
		{ title, bridge: {}, tags: ["remote-control-repl"], config: { cwd, ...(model && { model }) } },
		"Creating the session",
	);
	const id = data?.session?.id;
	if (typeof id !== "string" || !id.startsWith("cse_")) throw new Error("Creating the session returned no session id");
	return { id, url: data.session.session_url ?? `https://claude.ai/code/${id}` };
}

export async function archiveSession(creds: Credentials, id: string) {
	await request("POST", `${API}/v1/code/sessions/${id}/archive`, headers(creds.accessToken, creds.trustedDeviceToken), {}, "Archiving the session").catch(
		(e) => {
			if (!(e instanceof HttpError && e.status === 409)) throw e;
		},
	);
}

// Files the apps attach to a message (`file_attachments[].file_uuid`).
export async function downloadFile(creds: Credentials, fileUuid: string): Promise<{ data: Buffer; mimeType: string }> {
	const res = await fetch(`${API}/api/oauth/files/${encodeURIComponent(fileUuid)}/content`, {
		headers: { Authorization: `Bearer ${creds.accessToken}`, "User-Agent": USER_AGENT },
		signal: AbortSignal.timeout(60_000),
	});
	if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ""), "Downloading an attachment");
	return { data: Buffer.from(await res.arrayBuffer()), mimeType: res.headers.get("content-type")?.split(";")[0] ?? "application/octet-stream" };
}

export interface WorkerGrant {
	jwt: string;
	baseUrl: string;
	epoch: number;
	expiresAt: number;
}

// Orgs with Trusted Devices refuse this call without the device token Claude Code enrolled.
export async function bridge(creds: Credentials, id: string): Promise<WorkerGrant> {
	const data = await request("POST", `${API}/v1/code/sessions/${id}/bridge`, headers(creds.accessToken, creds.trustedDeviceToken), {}, "Attaching to the session");
	const epoch = Number(data.worker_epoch);
	if (typeof data.worker_jwt !== "string" || !Number.isSafeInteger(epoch)) throw new Error("Attaching returned no worker token");
	return {
		jwt: data.worker_jwt,
		baseUrl: `${String(data.api_base_url ?? API).replace(/\/+$/, "")}/v1/code/sessions/${id}`,
		epoch,
		expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000,
	};
}

export interface InboundEvent {
	event_id: string;
	sequence_num: number;
	payload: any;
}

export class Worker {
	constructor(
		readonly sessionId: string,
		public grant: WorkerGrant,
	) {}

	private call(method: string, suffix: string, body: unknown, what: string) {
		return request(method, `${this.grant.baseUrl}${suffix}`, headers(this.grant.jwt), body, what);
	}

	setState(state: { worker_status?: "idle" | "running" | "requires_action"; external_metadata?: Record<string, unknown> }) {
		return this.call("PUT", "/worker", { worker_epoch: this.grant.epoch, ...state }, "Updating the worker state");
	}

	heartbeat() {
		return this.call("POST", "/worker/heartbeat", { session_id: this.sessionId, worker_epoch: this.grant.epoch }, "Heartbeat");
	}

	postEvents(payloads: unknown[]) {
		return this.call("POST", "/worker/events", { worker_epoch: this.grant.epoch, events: payloads.map((payload) => ({ payload })) }, "Posting events");
	}

	ackDelivery(updates: { event_id: string; status: "received" | "processing" | "processed" }[]) {
		return this.call("POST", "/worker/events/delivery", { worker_epoch: this.grant.epoch, updates }, "Acknowledging events");
	}

	// Yields controller events after `fromSequenceNum` (exclusive) until the stream ends or `signal` aborts.
	async *stream(fromSequenceNum: number, signal: AbortSignal): AsyncGenerator<InboundEvent> {
		const url = new URL(`${this.grant.baseUrl}/worker/events/stream`);
		if (fromSequenceNum > 0) url.searchParams.set("from_sequence_num", String(fromSequenceNum));
		const res = await fetch(url, {
			headers: {
				...headers(this.grant.jwt),
				Accept: "text/event-stream",
				...(fromSequenceNum > 0 && { "Last-Event-ID": String(fromSequenceNum) }),
			},
			signal,
		});
		if (!res.ok || !res.body) throw new HttpError(res.status, await res.text().catch(() => ""), "Opening the event stream");
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
			buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, "\n");
			let end: number;
			while ((end = buffer.indexOf("\n\n")) >= 0) {
				const frame = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				let event = "message";
				let data = "";
				for (const line of frame.split("\n")) {
					if (line.startsWith("event:")) event = line.slice(6).trim();
					else if (line.startsWith("data:")) data += (data ? "\n" : "") + line.slice(5).replace(/^ /, "");
				}
				if (event !== "client_event" || !data) continue;
				const envelope = JSON.parse(data);
				yield { event_id: envelope.event_id, sequence_num: Number(envelope.sequence_num), payload: envelope.payload };
			}
		}
	}
}
