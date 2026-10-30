// Remote Control for Pi: makes a Pi session show up in claude.ai/code and the
// Claude apps like `claude --remote-control` does, so it can be followed and
// steered from there. Start it with /remote-control or `pi --remote-control`.
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	archiveSession,
	bridge,
	type CodeSession,
	createSession,
	type Credentials,
	downloadFile,
	HttpError,
	type InboundEvent,
	loadCredentials,
	Worker,
} from "./api.ts";

// The worker version claude.ai sees; it gates features on it like on a real Claude Code.
const CLAUDE_CODE_VERSION = "2.1.314";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
const MAX_TOOL_RESULT_CHARS = 30_000;
const STATUS_KEY = "remote-control";

// Set PI_REMOTE_CONTROL_DEBUG to a file path to log the bridge's lifecycle there.
function debug(message: string) {
	const file = process.env.PI_REMOTE_CONTROL_DEBUG;
	if (file) appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
}

// @juicesharp/rpiv-ask-user-question's event contract, for answering its
// questionnaires from the apps.
const ASK_PROMPT = "rpiv:ask-user:prompt";
const ASK_BLOCKED = "rpiv:ask-user:blocked";
const ASK_ANSWER = "rpiv:ask-user:answer";
const ASK_ANSWER_RESULT = "rpiv:ask-user:answer-result";
const ASK_TOOL = "ask_user_question";

interface AskQuestion {
	question: string;
	header: string;
	multiSelect: boolean;
	options: { label: string; description: string }[];
}

// Claude Code's AskUserQuestion answers (`answers: {question: label | labels | text}`)
// as the package's answer entries.
function toAnswerEntries(questions: AskQuestion[], answers: Record<string, unknown>) {
	const indexOf = (q: AskQuestion, label: string) => q.options.findIndex((o) => o.label === label.trim());
	return questions.map((q, questionIndex) => {
		const value = answers[q.question];
		const given = (Array.isArray(value) ? value : value === undefined ? [] : [value]).map(String);
		if (!q.multiSelect) {
			const i = given.length === 1 ? indexOf(q, given[0]!) : -1;
			return i >= 0 ? { questionIndex, optionIndexes: [i] } : { questionIndex, text: given.join(", ") };
		}
		// Multi-select answers can come as one comma-separated string.
		const parts = given.flatMap((v) => (indexOf(q, v) >= 0 ? [v] : v.split(/,\s*/)));
		const optionIndexes = [...new Set(parts.map((p) => indexOf(q, p)).filter((i) => i >= 0))];
		const text = parts.filter((p) => indexOf(q, p) < 0 && p.trim()).join(", ");
		return { questionIndex, optionIndexes, ...(text && { text }) };
	});
}

type Content = string | ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];

function toClaudeBlocks(content: Content): any[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content.map((c) =>
		c.type === "text" ? { type: "text", text: c.text } : { type: "image", source: { type: "base64", media_type: c.mimeType, data: c.data } },
	);
}

function fromClaudeContent(content: unknown): Content {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const out: Exclude<Content, string> = [];
	for (const block of content) {
		if (block?.type === "text" && typeof block.text === "string") out.push({ type: "text", text: block.text });
		else if (block?.type === "image" && block.source?.type === "base64") out.push({ type: "image", data: block.source.data, mimeType: block.source.media_type });
	}
	return out;
}

// The text of a message, for matching Pi's copy of a remote message against what
// arrived. Pi adds "[Image …]" notes to messages with images, so those are left out.
function textOf(content: Content) {
	const texts = typeof content === "string" ? [content] : content.flatMap((c) => (c.type === "text" ? [c.text] : []));
	return texts
		.join("\n")
		.split("\n")
		.filter((line) => !/^\[Image[ :]/.test(line.trim()))
		.join("\n")
		.trim();
}

// The apps' file route serves attachments as application/octet-stream.
function imageType(data: Buffer, fallback: string) {
	if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
	if (data.subarray(0, 4).toString("hex") === "89504e47") return "image/png";
	if (data.subarray(0, 4).toString("ascii") === "GIF8") return "image/gif";
	if (data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
	return fallback.startsWith("image/") ? fallback : "image/jpeg";
}

function truncate(text: string) {
	return text.length <= MAX_TOOL_RESULT_CHARS ? text : `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n… (${text.length - MAX_TOOL_RESULT_CHARS} more characters in Pi)`;
}

class RemoteControl {
	private worker!: Worker;
	private session!: CodeSession;
	// Kept for shutdown, which must not wait on the Keychain.
	private creds!: Credentials;
	private readonly stopped = new AbortController();
	private streamAbort?: AbortController;
	private lastSequenceNum = 0;
	private heartbeatTimer?: NodeJS.Timeout;
	private regrantTimer?: NodeJS.Timeout;
	private outbox: unknown[] = [];
	private flushing?: Promise<void>;
	// Controller messages wait here, not in Pi's own queue, so the apps can still cancel them.
	private queue: { eventId: string; uuid?: string; content: Content }[] = [];
	private processingIds: string[] = [];
	// Questionnaires put to the apps, by control request id.
	private asks = new Map<string, { toolCallId: string; questions: AskQuestion[]; request: any }>();
	private remoteTexts: string[] = [];
	private run?: { startedAt: number; turns: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; lastText: string; error?: string };

	constructor(
		private readonly pi: ExtensionAPI,
		private ctx: ExtensionContext,
	) {}

	private async credentials() {
		this.creds = await loadCredentials();
		return this.creds;
	}

	get url() {
		return this.session.url;
	}

	async start() {
		const creds = await this.credentials();
		const title = this.pi.getSessionName() ?? `Pi · ${path.basename(this.ctx.cwd)}`;
		this.session = await createSession(creds, title, this.ctx.cwd, this.ctx.model?.id);
		try {
			this.worker = new Worker(this.session.id, await bridge(creds, this.session.id));
			await this.worker.setState({ worker_status: this.ctx.isIdle() ? "idle" : "running", external_metadata: this.metadata() });
			await this.worker.heartbeat();
		} catch (e) {
			await archiveSession(creds, this.session.id).catch(() => {});
			throw e;
		}
		this.send(this.initEvent());
		this.backfill();
		this.scheduleHeartbeat(20);
		this.scheduleRegrant();
		void this.readLoop();
		this.setStatus("RC");
	}

	async stop() {
		if (this.stopped.signal.aborted) return;
		this.stopped.abort();
		this.streamAbort?.abort();
		clearTimeout(this.heartbeatTimer);
		clearTimeout(this.regrantTimer);
		this.setStatus(undefined);
		debug(`stop ${this.session?.id}`);
		// Archive right away, skipping the outbox: Pi may exit soon after this handler starts.
		const archived = await Promise.allSettled([this.session && archiveSession(this.creds, this.session.id)]);
		debug(`stopped: ${archived[0].status === "rejected" ? String(archived[0].reason) : "archived"}`);
	}

	setContext(ctx: ExtensionContext) {
		this.ctx = ctx;
	}

	// ---- outbound transcript ----

	private base() {
		return { uuid: randomUUID(), session_id: this.session.id };
	}

	private effort() {
		const level = this.pi.getThinkingLevel();
		return (EFFORTS as readonly string[]).includes(level) ? level : undefined;
	}

	private metadata() {
		return { model: this.ctx.model?.id ?? null, effort_level: this.effort() ?? null, pending_action: null, task_summary: null };
	}

	private initEvent() {
		return {
			type: "system",
			subtype: "init",
			...this.base(),
			cwd: this.ctx.cwd,
			model: this.ctx.model?.id ?? "unknown",
			effort: this.effort(),
			// Pi runs tools without asking, which is what this mode means to the apps.
			permissionMode: "bypassPermissions",
			tools: this.pi.getActiveTools(),
			mcp_servers: [],
			slash_commands: ["compact"],
			claude_code_version: CLAUDE_CODE_VERSION,
			apiKeySource: "none",
			output_style: "normal",
		};
	}

	// True for a user message that came from the remote client, which already has it in its event log.
	consumeRemote(content: Content) {
		const i = this.remoteTexts.indexOf(textOf(content));
		if (i < 0) return false;
		this.remoteTexts.splice(i, 1);
		return true;
	}

	userEvent(content: Content) {
		this.send({ type: "user", ...this.base(), parent_tool_use_id: null, message: { role: "user", content: toClaudeBlocks(content) } });
	}

	assistantEvent(message: any) {
		const content: any[] = [];
		for (const block of message.content ?? []) {
			if (block.type === "text" && block.text) content.push({ type: "text", text: block.text });
			else if (block.type === "thinking" && block.thinking && !block.redacted) content.push({ type: "thinking", thinking: block.thinking, signature: "" });
			else if (block.type === "toolCall")
				content.push({ type: "tool_use", id: block.id, name: block.name === ASK_TOOL ? "AskUserQuestion" : block.name, input: block.arguments ?? {} });
		}
		// An interrupted turn ends on an abort error; the result says so instead.
		const interrupted = message.stopReason === "aborted" || this.ctx.signal?.aborted === true;
		if (message.errorMessage && !interrupted) content.push({ type: "text", text: `Error: ${message.errorMessage}` });
		if (content.length === 0) return;
		const usage = message.usage ?? {};
		this.send({
			type: "assistant",
			...this.base(),
			parent_tool_use_id: null,
			message: {
				id: message.responseId ?? `msg_${randomUUID().replace(/-/g, "")}`,
				type: "message",
				role: "assistant",
				model: message.model,
				content,
				stop_reason: message.stopReason === "toolUse" ? "tool_use" : message.stopReason === "length" ? "max_tokens" : "end_turn",
				stop_sequence: null,
				usage: {
					input_tokens: usage.input ?? 0,
					output_tokens: usage.output ?? 0,
					cache_read_input_tokens: usage.cacheRead ?? 0,
					cache_creation_input_tokens: usage.cacheWrite ?? 0,
				},
			},
		});
		if (this.run) {
			this.run.turns++;
			this.run.input += usage.input ?? 0;
			this.run.output += usage.output ?? 0;
			this.run.cacheRead += usage.cacheRead ?? 0;
			this.run.cacheWrite += usage.cacheWrite ?? 0;
			this.run.cost += usage.cost?.total ?? 0;
			const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
			if (text) this.run.lastText = text;
			if (message.errorMessage && !interrupted) this.run.error = message.errorMessage;
		}
	}

	toolResultEvent(message: any) {
		const content = (message.content ?? []).map((c: any) =>
			c.type === "text" ? { type: "text", text: truncate(c.text) } : { type: "image", source: { type: "base64", media_type: c.mimeType, data: c.data } },
		);
		this.send({
			type: "user",
			...this.base(),
			parent_tool_use_id: null,
			message: { role: "user", content: [{ type: "tool_result", tool_use_id: message.toolCallId, content, is_error: message.isError === true }] },
		});
	}

	// Replays the conversation so far, so a session started mid-way isn't blank on the phone.
	private backfill() {
		for (const entry of this.ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const message: any = entry.message;
			if (message.role === "user") this.userEvent(message.content);
			else if (message.role === "assistant") this.assistantEvent(message);
			else if (message.role === "toolResult") this.toolResultEvent(message);
		}
	}

	runStarted() {
		if (this.run) return;
		this.run = { startedAt: Date.now(), turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, lastText: "" };
		this.setWorkerState("running");
	}

	runSettled(aborted: boolean) {
		const run = this.run;
		this.run = undefined;
		if (!run) return;
		// What Claude Code adds to the transcript when a turn is stopped.
		if (aborted) this.userEvent("[Request interrupted by user]");
		const durationMs = Date.now() - run.startedAt;
		const failed = aborted || run.error !== undefined;
		this.send({
			type: "result",
			...this.base(),
			subtype: failed ? "error_during_execution" : "success",
			is_error: failed,
			num_turns: run.turns,
			duration_ms: durationMs,
			duration_api_ms: durationMs,
			result: run.lastText,
			stop_reason: aborted ? "aborted" : "end_turn",
			total_cost_usd: run.cost,
			usage: { input_tokens: run.input, output_tokens: run.output, cache_read_input_tokens: run.cacheRead, cache_creation_input_tokens: run.cacheWrite },
		});
		this.setWorkerState("idle");
		if (this.processingIds.length > 0) {
			this.ack(this.processingIds, "processed");
			this.processingIds = [];
		}
		setTimeout(() => this.deliverNext(), 0);
	}

	// Hands the next queued controller message to Pi once it is idle. Its
	// `processing` receipt tells the apps it left the queue and can no longer be cancelled.
	private deliverNext() {
		if (this.stopped.signal.aborted || this.queue.length === 0 || this.run) return;
		if (!this.ctx.isIdle()) {
			setTimeout(() => this.deliverNext(), 250);
			return;
		}
		const next = this.queue.shift()!;
		this.remoteTexts.push(textOf(next.content));
		this.processingIds.push(next.eventId);
		this.ack([next.eventId], "processing");
		this.pi.sendUserMessage(next.content);
	}

	settingsChanged() {
		this.send(this.initEvent());
		this.worker.setState({ external_metadata: this.metadata() }).catch(() => {});
	}

	private setWorkerState(status: "idle" | "running") {
		this.worker.setState({ worker_status: status }).catch(() => {});
	}

	// Chained so a message's `received` never lands after its `processing`.
	private acks: Promise<unknown> = Promise.resolve();
	private ack(ids: string[], status: "received" | "processing" | "processed") {
		const updates = ids.map((event_id) => ({ event_id, status }));
		this.acks = this.acks.then(() => this.worker.ackDelivery(updates)).catch(() => {});
	}

	private send(payload: unknown) {
		this.outbox.push(payload);
		this.flushing ??= this.flush().finally(() => {
			this.flushing = undefined;
		});
	}

	// Posts in order, one batch at a time; a batch that keeps failing is dropped
	// rather than blocking the session.
	private async flush() {
		await Promise.resolve();
		while (this.outbox.length > 0) {
			const batch = this.outbox.splice(0, 50);
			for (let attempt = 0; ; attempt++) {
				try {
					await this.worker.postEvents(batch);
					break;
				} catch (e) {
					if (this.stopped.signal.aborted || attempt >= 4) {
						this.setStatus("RC ⚠");
						break;
					}
					if (e instanceof HttpError && (e.status === 401 || e.status === 409)) await this.regrant().catch(() => {});
					await sleep(500 * 2 ** attempt);
				}
			}
		}
	}

	// ---- inbound ----

	private async readLoop() {
		let backoff = 1000;
		while (!this.stopped.signal.aborted) {
			this.streamAbort = new AbortController();
			const signal = AbortSignal.any([this.stopped.signal, this.streamAbort.signal]);
			try {
				for await (const event of this.worker.stream(this.lastSequenceNum, signal)) {
					backoff = 1000;
					if (event.sequence_num <= this.lastSequenceNum) continue;
					this.lastSequenceNum = event.sequence_num;
					await this.handle(event);
				}
			} catch (e) {
				if (this.stopped.signal.aborted) return;
				if (e instanceof HttpError && (e.status === 401 || e.status === 409)) await this.regrant().catch(() => {});
			}
			if (this.stopped.signal.aborted) return;
			await sleep(backoff);
			backoff = Math.min(backoff * 2, 30_000);
		}
	}

	private async handle(event: InboundEvent) {
		const payload = event.payload;
		if (payload?.type === "user") {
			let content = fromClaudeContent(payload.message?.content);
			const attachments = Array.isArray(payload.file_attachments) ? payload.file_attachments : [];
			const slash = attachments.length === 0 ? /^\/(\S+)\s*([\s\S]*)$/.exec(textOf(content).trim()) : null;
			if (attachments.length === 0 && !textOf(content).trim()) return;
			this.ack([event.event_id], "received");
			if (slash) return this.slashCommand(event.event_id, slash[1], slash[2]);
			if (attachments.length > 0) content = await this.withAttachments(content, attachments);
			// The apps mark a message `later` to wait for the turn to end; any other
			// priority joins the running turn, as it does in Claude Code.
			if (this.run && payload.priority !== "later") {
				this.remoteTexts.push(textOf(content));
				this.processingIds.push(event.event_id);
				this.ack([event.event_id], "processing");
				this.pi.sendUserMessage(content, { deliverAs: "steer" });
				return;
			}
			this.queue.push({ eventId: event.event_id, uuid: payload.uuid, content });
			this.deliverNext();
		} else if (payload?.type === "control_request") {
			void this.control(payload);
		} else if (payload?.type === "control_response") {
			this.askAnswered(payload.response);
		}
	}

	// ---- questionnaires (ask_user_question) ----

	// Shows a questionnaire in the apps as Claude Code's AskUserQuestion prompt.
	ask(toolCallId: string, questions: AskQuestion[]) {
		const requestId = randomUUID();
		const request = {
			type: "control_request",
			...this.base(),
			request_id: requestId,
			request: {
				subtype: "can_use_tool",
				tool_name: "AskUserQuestion",
				display_name: "AskUserQuestion",
				input: { questions },
				tool_use_id: toolCallId,
				description: questions[0]?.question,
				requires_user_interaction: true,
			},
		};
		this.asks.set(requestId, { toolCallId, questions, request });
		this.send(request);
		this.worker
			.setState({
				worker_status: "requires_action",
				requires_action_details: {
					tool_name: "AskUserQuestion",
					display_tool_name: "AskUserQuestion",
					action_description: questions[0]?.question ?? "",
					request_id: requestId,
					tool_use_id: toolCallId,
				},
			})
			.catch(() => {});
	}

	private askAnswered(response: any) {
		const ask = this.asks.get(response?.request_id);
		if (!ask) return;
		this.asks.delete(response.request_id);
		this.setWorkerState("running");
		const answers = response.response?.updatedInput?.answers;
		const allowed = response.subtype === "success" && response.response?.behavior === "allow";
		// An empty answer map is how the apps dismiss the prompt.
		if (!allowed || !answers || Object.keys(answers).length === 0) {
			this.pi.events.emit(ASK_ANSWER, { toolCallId: ask.toolCallId, requestId: response.request_id, cancel: true });
			return;
		}
		this.pi.events.emit(ASK_ANSWER, {
			toolCallId: ask.toolCallId,
			requestId: response.request_id,
			answers: toAnswerEntries(ask.questions, answers),
		});
	}

	// The questionnaire closed in Pi (answered in the terminal, or the turn stopped): withdraw it from the apps.
	askClosed(toolCallId: string) {
		for (const [requestId, ask] of this.asks) {
			if (ask.toolCallId !== toolCallId) continue;
			this.asks.delete(requestId);
			this.send({ type: "control_cancel_request", ...this.base(), request_id: requestId });
			if (this.run) this.setWorkerState("running");
		}
	}

	askRejected(requestId: string, reason: string) {
		this.notice(`Pi didn't take that answer: ${reason}. Answer in the terminal instead.`);
		debug(`ask answer ${requestId} rejected: ${reason}`);
	}

	// The apps send these as plain messages; Claude Code runs them as its own commands.
	private slashCommand(eventId: string, name: string, args: string) {
		this.ack([eventId], "processing");
		// The apps wait for a result after any message, as Claude Code sends for its local commands.
		const end = (isError: boolean, text = "") => {
			this.send({
				type: "result",
				...this.base(),
				subtype: isError ? "error_during_execution" : "success",
				is_error: isError,
				num_turns: 0,
				duration_ms: 0,
				duration_api_ms: 0,
				result: text,
				stop_reason: "end_turn",
				total_cost_usd: 0,
				usage: { input_tokens: 0, output_tokens: 0 },
			});
			this.ack([eventId], "processed");
		};
		const done = (text: string) => {
			this.notice(text);
			end(true, text);
		};
		if (name !== "compact") return done(`Pi can't run /${name} from Remote Control.`);
		// Progress and the boundary come from Pi's compaction events (see compacting/compacted).
		this.ctx.compact({
			customInstructions: args.trim() || undefined,
			onComplete: () => end(false),
			onError: (e) => {
				this.compactStatus(null);
				done(`Compaction failed: ${e.message}`);
			},
		});
	}

	compactStatus(status: "compacting" | null) {
		this.send({ type: "system", subtype: "status", ...this.base(), status, permissionMode: "bypassPermissions" });
	}

	// How Claude Code marks a compaction in the transcript.
	compacted(reason: "manual" | "threshold" | "overflow", tokensBefore: number) {
		this.compactStatus(null);
		this.send({
			type: "system",
			subtype: "compact_boundary",
			...this.base(),
			compact_metadata: { trigger: reason === "manual" ? "manual" : "auto", pre_tokens: tokensBefore },
		});
	}

	// A message shown in the apps only, as Claude Code shows a local command's output.
	private notice(text: string) {
		this.send({
			type: "assistant",
			...this.base(),
			parent_tool_use_id: null,
			message: {
				id: `msg_${randomUUID().replace(/-/g, "")}`,
				type: "message",
				role: "assistant",
				model: "<synthetic>",
				content: [{ type: "text", text }],
				stop_reason: "end_turn",
				stop_sequence: null,
				usage: { input_tokens: 0, output_tokens: 0 },
			},
		});
	}

	// Images go to the model inline; other files are saved where Pi's tools can read them.
	private async withAttachments(content: Content, attachments: any[]): Promise<Content> {
		const parts: Exclude<Content, string> = typeof content === "string" ? (content ? [{ type: "text", text: content }] : []) : [...content];
		const dir = path.join(os.tmpdir(), "pi-remote-control", this.session.id);
		for (const attachment of attachments) {
			const name = path.basename(String(attachment?.file_name ?? attachment?.file_uuid ?? "attachment"));
			try {
				const file = await downloadFile(await this.credentials(), String(attachment.file_uuid));
				if (attachment.is_image || file.mimeType.startsWith("image/")) {
					parts.push({ type: "image", data: file.data.toString("base64"), mimeType: imageType(file.data, file.mimeType) });
				} else {
					await mkdir(dir, { recursive: true });
					const filePath = path.join(dir, `${String(attachment.file_uuid).slice(0, 8)}-${name}`);
					await writeFile(filePath, file.data);
					parts.push({ type: "text", text: `[Attached file: ${filePath}]` });
				}
			} catch (e) {
				parts.push({ type: "text", text: `[Attachment ${name} could not be downloaded: ${e instanceof Error ? e.message : String(e)}]` });
			}
		}
		return parts;
	}

	private async control(payload: any) {
		const { request_id, request } = payload;
		const reply = (response: Record<string, unknown>) =>
			this.send({ type: "control_response", session_id: this.session.id, response: { request_id, ...response } });
		try {
			switch (request?.subtype) {
				case "initialize":
					reply({
						subtype: "success",
						response: {
							commands: [],
							agents: [],
							output_style: "normal",
							available_output_styles: ["normal"],
							models: [],
							account: {},
							pid: process.pid,
							claude_code_version: CLAUDE_CODE_VERSION,
							// Without these the apps push their own default model on connect.
							current_model: this.ctx.model?.id,
							current_permission_mode: "bypassPermissions",
							// Receipts follow the queue (see deliverNext), which lets the apps offer cancel.
							inbound_read_receipts: true,
							session_state: this.run ? "running" : "idle",
						},
						pending_permission_requests: [...this.asks.values()].map((ask) => ask.request),
						pending_user_dialog_requests: [],
					});
					this.send(this.initEvent());
					return;
				case "cancel_async_message": {
					const i = this.queue.findIndex((m) => m.uuid === request.message_uuid);
					if (i >= 0) this.queue.splice(i, 1);
					return reply({ subtype: "success", response: { cancelled: i >= 0 } });
				}
				case "interrupt":
					this.ctx.abort();
					return reply({ subtype: "success" });
				case "set_model": {
					const wanted = request.model;
					if (wanted == null || wanted === "default") return reply({ subtype: "success" });
					const [provider, id] = String(wanted).includes("/") ? String(wanted).split("/", 2) : [undefined, String(wanted)];
					// Stay on the current provider: switching provider would change how requests are billed.
					const current = this.ctx.model?.provider;
					const model = current && (!provider || provider === current) ? this.ctx.modelRegistry.find(current, id) : undefined;
					if (!model) return reply({ subtype: "error", error: `Pi's ${current ?? "current"} provider has no model ${id}` });
					if (!(await this.pi.setModel(model))) return reply({ subtype: "error", error: `Pi has no credentials for ${wanted}` });
					return reply({ subtype: "success" });
				}
				case "apply_flag_settings": {
					const level = request.settings?.effortLevel;
					if (level !== undefined && level !== null) {
						if (!(EFFORTS as readonly string[]).includes(level)) return reply({ subtype: "error", error: "unrecognized effortLevel" });
						this.pi.setThinkingLevel(level);
					}
					this.settingsChanged();
					return reply({ subtype: "success" });
				}
				case "set_permission_mode":
					if (request.mode === "bypassPermissions") return reply({ subtype: "success" });
					return reply({ subtype: "error", error: "Pi has no permission modes: it runs tools without asking" });
				case "get_context_usage": {
					const usage = this.ctx.getContextUsage();
					return reply({
						subtype: "success",
						response: {
							totalTokens: usage?.tokens ?? 0,
							maxTokens: usage?.contextWindow ?? 0,
							percentage: usage?.percent ?? 0,
							model: this.ctx.model?.id,
							isAutoCompactEnabled: true,
							categories: [],
						},
					});
				}
				case "mcp_status":
					return reply({ subtype: "success", response: { mcpServers: [] } });
				default:
					return reply({ subtype: "error", error: `Pi does not handle control_request subtype: ${request?.subtype}` });
			}
		} catch (e) {
			reply({ subtype: "error", error: e instanceof Error ? e.message : String(e) });
		}
	}

	// ---- keepalive and token renewal ----

	private scheduleHeartbeat(seconds: number) {
		this.heartbeatTimer = setTimeout(async () => {
			let next = seconds;
			try {
				const res = await this.worker.heartbeat();
				if (typeof res?.heartbeat_interval_seconds === "number") next = res.heartbeat_interval_seconds;
				this.setStatus("RC");
			} catch (e) {
				this.setStatus("RC ⚠");
				if (e instanceof HttpError && (e.status === 401 || e.status === 409)) await this.regrant().catch(() => {});
			}
			if (!this.stopped.signal.aborted) this.scheduleHeartbeat(next);
		}, seconds * 1000);
	}

	private scheduleRegrant() {
		clearTimeout(this.regrantTimer);
		const inMs = Math.max(60_000, this.worker.grant.expiresAt - Date.now() - 10 * 60_000);
		this.regrantTimer = setTimeout(() => void this.regrant().catch(() => this.setStatus("RC ⚠")), inMs);
	}

	private regranting?: Promise<void>;
	private regrant() {
		this.regranting ??= (async () => {
			try {
				this.worker.grant = await bridge(await this.credentials(), this.session.id);
				await this.worker.setState({ worker_status: this.run ? "running" : "idle", external_metadata: this.metadata() });
				this.streamAbort?.abort();
				this.scheduleRegrant();
			} finally {
				this.regranting = undefined;
			}
		})();
		return this.regranting;
	}

	private setStatus(text: string | undefined) {
		if (this.ctx.hasUI) this.ctx.ui.setStatus(STATUS_KEY, text);
	}
}

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export default function (pi: ExtensionAPI) {
	let rc: RemoteControl | undefined;

	async function start(ctx: ExtensionContext) {
		const next = new RemoteControl(pi, ctx);
		try {
			await next.start();
		} catch (e) {
			ctx.ui.notify(`Remote Control: ${e instanceof Error ? e.message : String(e)}`, "error");
			return;
		}
		rc = next;
		ctx.ui.notify(`Remote Control on: ${next.url}`, "info");
	}

	async function stop() {
		const current = rc;
		rc = undefined;
		await current?.stop();
	}

	pi.registerFlag("remote-control", { description: "Start Remote Control (claude.ai/code and the Claude apps) with the session", type: "boolean" });

	pi.registerCommand("remote-control", {
		description: "Toggle Remote Control: follow and steer this session from claude.ai/code or the Claude apps",
		handler: async (_args, ctx) => {
			if (rc) {
				await stop();
				ctx.ui.notify("Remote Control off", "info");
			} else {
				await start(ctx);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("remote-control") === true && !rc) await start(ctx);
	});

	pi.on("session_shutdown", async (event) => {
		debug(`session_shutdown ${event.reason} active=${rc !== undefined}`);
		await stop();
	});

	pi.on("agent_start", async (_event, ctx) => {
		rc?.setContext(ctx);
		rc?.runStarted();
	});

	pi.on("agent_settled", async (event, ctx) => {
		rc?.setContext(ctx);
		rc?.runSettled(event.aborted);
	});

	pi.on("message_end", async (event) => {
		if (!rc) return;
		const message: any = event.message;
		if (message.role === "assistant") rc.assistantEvent(message);
		else if (message.role === "toolResult") rc.toolResultEvent(message);
		else if (message.role === "user" && !rc.consumeRemote(message.content)) rc.userEvent(message.content);
	});

	pi.events.on(ASK_PROMPT, (data: any) => {
		if (typeof data?.toolCallId === "string" && Array.isArray(data.questions)) rc?.ask(data.toolCallId, data.questions);
	});

	pi.events.on(ASK_BLOCKED, (data: any) => {
		if (data?.active === false && typeof data.toolCallId === "string") rc?.askClosed(data.toolCallId);
	});

	pi.events.on(ASK_ANSWER_RESULT, (data: any) => {
		if (data?.ok === false && typeof data.requestId === "string") rc?.askRejected(data.requestId, String(data.reason ?? data.code));
	});

	pi.on("session_before_compact", async () => {
		rc?.compactStatus("compacting");
	});

	pi.on("session_compact", async (event) => {
		rc?.compacted(event.reason, event.compactionEntry.tokensBefore);
	});

	pi.on("session_compact_failed", async () => {
		rc?.compactStatus(null);
	});

	pi.on("model_select", async (_event, ctx) => {
		rc?.setContext(ctx);
		rc?.settingsChanged();
	});

	pi.on("thinking_level_select", async (_event, ctx) => {
		rc?.setContext(ctx);
		rc?.settingsChanged();
	});
}
