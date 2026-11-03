// Copies Claude Code's sessions into Pi's session store, so /resume lists them.
// Run by home-manager activation (see default.nix), not by Pi. Adapted from
// oh-my-pi's ClaudeSessionStore (MIT):
// https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/src/session/claude-session-store.ts
//
// Incremental: a state file remembers each Claude transcript's size and mtime
// and the Pi file written from it. An unchanged transcript is skipped; a Pi copy
// that changed since it was written (continued in Pi) is never overwritten.
// When the conversion itself changes (VERSION), copies made by an older one are
// converted again, under the same rule; a copy that comes out different is
// first kept aside in claude-sessions-import-backup/.
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
const backupDir = path.join(piDir, "claude-sessions-import-backup");
// 2: Claude Code's compactions become Pi compaction entries on one branch; its `!`
// commands become Pi's bash executions, its slash commands plain prompts.
const VERSION = 2;

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

const unescapeXml = (text) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const tag = (text, name) => {
	const m = text.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
	return m ? m[1] : undefined;
};

// What Claude Code writes as a user prompt for its own commands, in Pi's terms:
// a `!` command and its output, a slash command, a local command's output.
function claudeCommand(record) {
	const raw = record.message.content;
	const text = typeof raw === "string" ? raw : Array.isArray(raw) && raw.length === 1 && raw[0]?.type === "text" ? raw[0].text : undefined;
	if (typeof text !== "string") return undefined;
	const t = text.trim();
	if (/^<bash-input>[\s\S]*<\/bash-input>$/.test(t)) return { kind: "bash", command: unescapeXml(tag(t, "bash-input")).trim() };
	if (/^<bash-stdout>[\s\S]*<\/bash-stderr>$/.test(t) || /^<bash-stdout>[\s\S]*<\/bash-stdout>$/.test(t)) {
		const out = unescapeXml(tag(t, "bash-stdout") ?? "").replace(/\n+$/, "");
		const err = unescapeXml(tag(t, "bash-stderr") ?? "").replace(/\n+$/, "");
		return { kind: "bashOutput", output: [out, err].filter(Boolean).join("\n") };
	}
	if (t.startsWith("<command-name>") || t.startsWith("<command-message>")) {
		const name = tag(t, "command-name")?.trim();
		const args = unescapeXml(tag(t, "command-args") ?? "").trim();
		return name ? { kind: "prompt", text: args ? `${name} ${args}` : name } : undefined;
	}
	if (/^<local-command-stdout>[\s\S]*<\/local-command-stdout>$/.test(t)) {
		const out = unescapeXml(tag(t, "local-command-stdout")).trim();
		return { kind: "localOutput", output: out === "(no content)" ? "" : out };
	}
	return undefined;
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
	const heads = new Map(); // Claude uuid → the first Pi entry made from it
	const boundaries = new Map(); // compact_boundary uuid → its compactMetadata
	const toolNames = new Map();
	let cwd;
	let customTitle;
	let aiTitle;
	let created;
	let count = 0;
	let pending; // An assistant entry still taking blocks from records of the same response.
	let lastId = null; // The Pi entry made last.
	let bash; // The bash execution a `<bash-stdout>` record fills in.

	const parentOf = (uuid) => {
		const seen = new Set();
		for (let cursor = uuid; cursor && !seen.has(cursor); cursor = parents.get(cursor)) {
			seen.add(cursor);
			if (tails.has(cursor)) return tails.get(cursor);
		}
		return null;
	};
	const push = (entry) => {
		lines.push(entry);
		lastId = entry.id;
	};
	// A parent Claude never wrote (it happens) continues from the entry made last.
	const parentFor = (record) => {
		const parent = str(record, "parentUuid");
		return parent ? (parentOf(parent) ?? lastId) : null;
	};
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
		// A compaction starts a new root in Claude's tree; the conversation it ends is its
		// logical parent, so Pi keeps one branch through it.
		if (record.type === "system" && record.subtype === "compact_boundary" && uuid) {
			parents.set(uuid, str(record, "logicalParentUuid"));
			boundaries.set(uuid, isRecord(record.compactMetadata) ? record.compactMetadata : {});
			continue;
		}
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
			if (pending && responseId && pending.entry.message.responseId === responseId && parentFor(record) === pending.entry.id) {
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
				parentId: parentFor(record),
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
			lastId = entry.id;
			tails.set(uuid, entry.id);
			heads.set(uuid, entry.id);
			continue;
		}

		// The summary Claude continues from is Pi's compaction entry: Pi then sends it and
		// what Claude kept (the preserved messages), not the conversation before.
		const boundary = boundaries.get(str(record, "parentUuid"));
		if (record.isCompactSummary === true && boundary) {
			flush();
			const raw = record.message.content;
			const summary = typeof raw === "string" ? raw : toolResultContent(raw).filter((b) => b.type === "text").map((b) => b.text).join("\n");
			const id = `${uuid}-${++count}`;
			const kept = (isRecord(boundary.preservedMessages) && Array.isArray(boundary.preservedMessages.uuids) ? boundary.preservedMessages.uuids : [])
				.map((u) => heads.get(u)).find(Boolean);
			push({ type: "compaction", id, parentId: parentFor(record), timestamp: iso, summary, firstKeptEntryId: kept ?? id, tokensBefore: num(boundary, "preTokens") });
			tails.set(uuid, id);
			continue;
		}

		const command = claudeCommand(record);
		if (command?.kind === "bashOutput" && bash && parentFor(record) === bash.id) {
			bash.message.output = command.output;
			tails.set(uuid, bash.id);
			continue;
		}
		if (command?.kind === "localOutput" && !command.output) continue;
		if (command) {
			flush();
			const id = `${uuid}-${++count}`;
			const message =
				command.kind === "bash" || command.kind === "bashOutput"
					? { role: "bashExecution", command: command.command ?? "", output: command.output ?? "", exitCode: undefined, cancelled: false, truncated: false, timestamp }
					: command.kind === "prompt"
						? { role: "user", content: command.text, timestamp }
						: undefined;
			const entry = message
				? { type: "message", id, parentId: parentFor(record), timestamp: iso, message }
				: { type: "custom_message", id, parentId: parentFor(record), timestamp: iso, customType: "claude-code", content: command.output, display: true };
			push(entry);
			bash = command.kind === "bash" ? entry : undefined;
			tails.set(uuid, id);
			heads.set(uuid, id);
			continue;
		}

		const messages = userMessages(record, timestamp, toolNames);
		if (!messages.length) continue;
		flush();
		let parentId = parentFor(record);
		for (const message of messages) {
			const id = `${uuid}-${++count}`;
			if (!heads.has(uuid)) heads.set(uuid, id);
			push({ type: "message", id, parentId, timestamp: iso, message });
			parentId = id;
		}
		tails.set(uuid, parentId);
	}
	flush();
	if (!lines.length) return undefined;

	// Settings Pi restores on resume, then the name /resume shows; both on the
	// last branch, which stays the leaf (the last line). Their ids never change: Pi
	// hangs what it adds on the leaf, also a Pi still open on the copy a new
	// conversion replaced.
	const end = lines[lines.length - 1];
	const at = end.timestamp;
	lines.push({ type: "thinking_level_change", id: "claude-thinking", parentId: end.id, timestamp: at, thinkingLevel });
	const title = customTitle ?? aiTitle;
	if (title) lines.push({ type: "session_info", id: "claude-title", parentId: "claude-thinking", timestamp: at, name: title.replace(/[\r\n]+/g, " ").trim() });
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
			if (known && known.size === now.size && known.mtimeMs === now.mtimeMs && (known.version ?? 1) >= VERSION) {
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
					state[source] = { ...now, version: VERSION };
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
				const before = known?.piFile ? await readFile(piFile).catch(() => undefined) : undefined;
				if (before && !before.equals(await readFile(tmp))) {
					await mkdir(backupDir, { recursive: true });
					await writeFile(path.join(backupDir, `${path.basename(piFile, ".jsonl")}.v${known.version ?? 1}.jsonl`), before);
				}
				await rename(tmp, piFile);
				const pi = await fileState(piFile);
				state[source] = { ...now, piFile, piSize: pi.size, piMtimeMs: pi.mtimeMs, version: VERSION };
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
