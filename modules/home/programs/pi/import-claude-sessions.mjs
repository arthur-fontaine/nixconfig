// Copies Claude Code's sessions into Pi's session store, so /resume lists them.
// Run by home-manager activation (see default.nix), not by Pi. Adapted from
// oh-my-pi's ClaudeSessionStore (MIT):
// https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/claude-session-store.ts
//
// Incremental: a state file remembers each Claude transcript's size and mtime
// and the Pi file written from it. An unchanged transcript is skipped; a Pi copy
// that changed since it was written (continued in Pi) is never overwritten.
//
// node import-claude-sessions.mjs [--claude-dir ~/.claude] [--pi-dir ~/.pi/agent] [--thinking high]

import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, writeFile, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);
const claudeDir = args.get("claude-dir") ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
const piDir = args.get("pi-dir") ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
const thinkingLevel = args.get("thinking") ?? "high";
const statePath = path.join(piDir, "claude-sessions-import.json");

// Resumed sessions take their model from the last assistant message, so the
// copies name pi-claude-code's provider: under "anthropic" they would resume
// through Pi's own Anthropic login. Models it doesn't list resume as "default".
const PROVIDER = "claude-code";
const API = "claude-code-stream-json";
const CLAUDE_CODE_MODELS = new Set([
	"claude-opus-5-5",
	"claude-fable-5-1",
	"claude-sonnet-5-5",
	"claude-sonnet-5",
	"claude-haiku-5-5",
	"claude-haiku-4-5-20251001",
]);

const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (r, k) => (typeof r?.[k] === "string" && r[k].length > 0 ? r[k] : undefined);
const num = (r, k) => (typeof r?.[k] === "number" && Number.isFinite(r[k]) ? r[k] : 0);
const ms = (v, fallback) => {
	const t = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
	return Number.isFinite(t) ? t : fallback;
};

function image(block) {
	if (!isRecord(block) || block.type !== "image" || !isRecord(block.source)) return undefined;
	const data = str(block.source, "data");
	const mimeType = str(block.source, "media_type");
	return data && mimeType ? { type: "image", data, mimeType } : undefined;
}

function userPart(block) {
	if (!isRecord(block)) return undefined;
	if (block.type === "text" && typeof block.text === "string") return { type: "text", text: block.text };
	return image(block);
}

function toolResultContent(value) {
	if (typeof value === "string") return [{ type: "text", text: value }];
	return Array.isArray(value) ? value.map(userPart).filter(Boolean) : [];
}

function assistantContent(value, toolNames) {
	const content = [];
	for (const block of Array.isArray(value) ? value : []) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") content.push({ type: "text", text: block.text });
		else if (block.type === "thinking" && typeof block.thinking === "string") {
			content.push({ type: "thinking", thinking: block.thinking, ...(str(block, "signature") && { thinkingSignature: block.signature }) });
		} else if (block.type === "redacted_thinking" && str(block, "data")) {
			content.push({ type: "thinking", thinking: "", redacted: true, thinkingSignature: block.data });
		} else if (block.type === "tool_use" && str(block, "id") && str(block, "name")) {
			content.push({ type: "toolCall", id: block.id, name: block.name, arguments: isRecord(block.input) ? block.input : {} });
			toolNames.set(block.id, block.name);
		}
		// server_tool_use, advisor_tool_result and the like have no Pi equivalent.
	}
	return content;
}

function usage(value) {
	const input = num(value, "input_tokens");
	const output = num(value, "output_tokens");
	const cacheRead = num(value, "cache_read_input_tokens");
	const cacheWrite = num(value, "cache_creation_input_tokens");
	return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function stopReason(record) {
	if (record.isApiErrorMessage === true) return "error";
	const value = record.message.stop_reason;
	if (value === "tool_use") return "toolUse";
	if (value === "max_tokens") return "length";
	if (value == null || value === "end_turn" || value === "stop_sequence" || value === "pause_turn") return "stop";
	return "error";
}

// One Claude user record becomes user and tool-result messages, in block order.
function userMessages(record, timestamp, toolNames) {
	const raw = record.message.content;
	if (typeof raw === "string") return raw ? [{ role: "user", content: raw, timestamp }] : [];
	if (!Array.isArray(raw)) return [];
	const out = [];
	let content = [];
	const flush = () => {
		if (content.length) out.push({ role: "user", content, timestamp });
		content = [];
	};
	for (const block of raw) {
		const part = userPart(block);
		if (part) {
			content.push(part);
			continue;
		}
		if (!isRecord(block) || block.type !== "tool_result" || !str(block, "tool_use_id")) continue;
		flush();
		out.push({
			role: "toolResult",
			toolCallId: block.tool_use_id,
			toolName: toolNames.get(block.tool_use_id) ?? "unknown",
			content: toolResultContent(block.content),
			isError: block.is_error === true,
			timestamp,
		});
	}
	flush();
	return out;
}

// Converts one transcript, streaming: the largest are hundreds of MB, mostly
// records Pi has no use for (api-request blobs, attachments, file history).
async function convert(file, fallbackMs) {
	const lines = [];
	const parents = new Map(); // Claude uuid → its parentUuid
	const tails = new Map(); // Claude uuid → the last Pi entry made from it (or from its ancestors)
	const toolNames = new Map();
	let cwd;
	let customTitle;
	let aiTitle;
	let created;
	let count = 0;
	let pending; // An assistant entry still taking blocks from records of the same response.

	const parentOf = (uuid) => {
		const seen = new Set();
		for (let cursor = uuid; cursor && !seen.has(cursor); cursor = parents.get(cursor)) {
			seen.add(cursor);
			if (tails.has(cursor)) return tails.get(cursor);
		}
		return null;
	};
	const push = (entry) => lines.push(entry);
	const flush = () => {
		if (pending) push(pending.entry);
		pending = undefined;
	};

	const input = readline.createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
	for await (const line of input) {
		// Cheap filter before parsing: most bytes are records nothing here reads.
		if (!line.includes('"uuid"') && !line.includes("-title")) continue;
		let record;
		try {
			record = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(record)) continue;
		const uuid = str(record, "uuid");
		if (uuid) parents.set(uuid, str(record, "parentUuid"));
		cwd ??= str(record, "cwd");
		if (record.type === "custom-title") customTitle = str(record, "customTitle") ?? customTitle;
		if (record.type === "ai-title") aiTitle = str(record, "aiTitle") ?? aiTitle;
		if ((record.type !== "user" && record.type !== "assistant") || record.isSidechain === true || record.isMeta === true) continue;
		if (!isRecord(record.message) || !uuid) continue;

		const timestamp = ms(record.timestamp, fallbackMs);
		created ??= timestamp;
		const iso = new Date(timestamp).toISOString();

		if (record.type === "assistant") {
			const content = assistantContent(record.message.content, toolNames);
			const errorMessage = str(record, "error");
			if (!content.length && !errorMessage) continue;
			const responseId = str(record.message, "id");
			// Claude Code writes one record per content block of a response; Pi keeps a
			// response in one message (thinking must stay with its tool calls).
			if (pending && responseId && pending.entry.message.responseId === responseId && parentOf(str(record, "parentUuid")) === pending.entry.id) {
				pending.entry.message.content.push(...content);
				pending.entry.message.usage = usage(record.message.usage);
				pending.entry.message.stopReason = stopReason(record);
				tails.set(uuid, pending.entry.id);
				continue;
			}
			flush();
			const model = str(record.message, "model");
			const entry = {
				type: "message",
				id: `${uuid}-${++count}`,
				parentId: parentOf(str(record, "parentUuid")),
				timestamp: iso,
				message: {
					role: "assistant",
					content,
					api: API,
					provider: PROVIDER,
					model: model && CLAUDE_CODE_MODELS.has(model) ? model : "default",
					usage: usage(record.message.usage),
					stopReason: stopReason(record),
					timestamp,
					...(responseId && { responseId }),
					...(errorMessage && { errorMessage }),
				},
			};
			pending = { entry };
			tails.set(uuid, entry.id);
			continue;
		}

		const messages = userMessages(record, timestamp, toolNames);
		if (!messages.length) continue;
		flush();
		let parentId = parentOf(str(record, "parentUuid"));
		for (const message of messages) {
			const id = `${uuid}-${++count}`;
			push({ type: "message", id, parentId, timestamp: iso, message });
			parentId = id;
		}
		tails.set(uuid, parentId);
	}
	flush();
	if (!lines.length) return undefined;

	// Settings Pi restores on resume, then the name /resume shows; both on the
	// last branch, which stays the leaf (the last line).
	const end = lines[lines.length - 1];
	const at = end.timestamp;
	lines.push({ type: "thinking_level_change", id: `claude-thinking-${count}`, parentId: end.id, timestamp: at, thinkingLevel });
	const title = customTitle ?? aiTitle;
	if (title) lines.push({ type: "session_info", id: `claude-title-${count}`, parentId: `claude-thinking-${count}`, timestamp: at, name: title.replace(/[\r\n]+/g, " ").trim() });
	return { lines, cwd, created: created ?? fallbackMs };
}

// Claude names a project's folder by turning every non-alphanumeric character
// of its cwd into "-"; only a guess when the transcript records no cwd.
const cwdFromProjectDir = (name) => (name.startsWith("-") ? name.replaceAll("-", "/") : name);
const piSessionDir = (cwd) => path.join(piDir, "sessions", `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);

async function fileState(file) {
	try {
		const s = await stat(file);
		return { size: s.size, mtimeMs: Math.floor(s.mtimeMs) };
	} catch {
		return undefined;
	}
}

async function main() {
	let state = {};
	try {
		state = JSON.parse(await readFile(statePath, "utf8"));
	} catch {}
	const projectsDir = path.join(claudeDir, "projects");
	const projects = await readdir(projectsDir, { withFileTypes: true }).catch(() => []);
	const counts = { imported: 0, updated: 0, unchanged: 0, empty: 0, continuedInPi: 0, failed: 0 };

	for (const project of projects) {
		if (!project.isDirectory()) continue;
		const dir = path.join(projectsDir, project.name);
		for (const item of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
			if (!item.isFile() || !item.name.endsWith(".jsonl")) continue;
			const source = path.join(dir, item.name);
			const now = await fileState(source);
			if (!now) continue;
			const known = state[source];
			if (known && known.size === now.size && known.mtimeMs === now.mtimeMs) {
				counts.unchanged++;
				continue;
			}
			if (known?.piFile) {
				const pi = await fileState(known.piFile);
				if (pi && (pi.size !== known.piSize || pi.mtimeMs !== known.piMtimeMs)) {
					counts.continuedInPi++;
					continue;
				}
			}
			try {
				const result = await convert(source, now.mtimeMs);
				if (!result) {
					state[source] = { ...now };
					counts.empty++;
					continue;
				}
				const id = path.basename(item.name, ".jsonl");
				const cwd = result.cwd ?? cwdFromProjectDir(project.name);
				const created = new Date(result.created).toISOString();
				const piFile = known?.piFile ?? path.join(piSessionDir(cwd), `${created.replace(/[:.]/g, "-")}_${id}.jsonl`);
				const header = { type: "session", version: 3, id, timestamp: created, cwd };
				await mkdir(path.dirname(piFile), { recursive: true });
				const tmp = `${piFile}.importing`;
				const out = await open(tmp, "w");
				try {
					await out.write(`${JSON.stringify(header)}\n`);
					for (const line of result.lines) await out.write(`${JSON.stringify(line)}\n`);
				} finally {
					await out.close();
				}
				await rename(tmp, piFile);
				const pi = await fileState(piFile);
				state[source] = { ...now, piFile, piSize: pi.size, piMtimeMs: pi.mtimeMs };
				known?.piFile ? counts.updated++ : counts.imported++;
			} catch (error) {
				counts.failed++;
				console.error(`pi: could not import ${source}: ${error instanceof Error ? error.message : error}`);
			}
		}
	}

	await mkdir(path.dirname(statePath), { recursive: true });
	await writeFile(`${statePath}.tmp`, `${JSON.stringify(state, null, "\t")}\n`);
	await rename(`${statePath}.tmp`, statePath);
	const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`);
	console.log(`Claude Code sessions in Pi: ${parts.join(", ") || "none found"}`);
}

await main();
