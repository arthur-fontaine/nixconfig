// A run that changed code and ran nothing afterwards that could show it working is sent
// back once before it settles: check it where it runs, or say what isn't verified. Fix
// workers announced fixes from edits alone, and the person found out on their phone.
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Gate, reminderText } from "./gate.ts";

// Prose changes need no run.
const CODE_ONLY = ["--", ".", ":(exclude)*.md"];
const MAY_CHANGE = new Set(["edit", "write", "bash"]);
const CUSTOM_TYPE = "verify-gate";

interface Repo {
	root: string;
	base: string;
	fingerprint: string;
	files: Set<string>;
}

export default function (pi: ExtensionAPI) {
	let gate = new Gate();
	let repo: Repo | undefined;
	const commands = new Map<string, string>();

	const git = async (cwd: string, args: string[]) => {
		const result = await pi.exec("git", args, { cwd, timeout: 10_000 });
		return result.code === 0 ? result.stdout : undefined;
	};

	/** What the working tree holds against the run's starting commit, untracked files included. */
	async function snapshot(root: string, base: string) {
		const [diff, untracked] = await Promise.all([
			git(root, ["diff", "--no-ext-diff", base, ...CODE_ONLY]),
			git(root, ["ls-files", "--others", "--exclude-standard", ...CODE_ONLY]),
		]);
		if (diff === undefined || untracked === undefined) return undefined;
		const hash = createHash("sha256").update(diff);
		const files = new Set<string>();
		for (const line of diff.split("\n")) {
			const name = /^\+\+\+ b\/(.+)$/.exec(line)?.[1] ?? /^--- a\/(.+)$/.exec(line)?.[1];
			if (name) files.add(name);
		}
		for (const name of untracked.split("\n").filter(Boolean)) {
			files.add(name);
			try {
				hash.update(`${name}\0${statSync(join(root, name)).mtimeMs}`);
			} catch {
				hash.update(name);
			}
		}
		return { fingerprint: hash.digest("hex"), files };
	}

	pi.on("agent_start", async (_event, ctx: ExtensionContext) => {
		gate = new Gate();
		commands.clear();
		repo = undefined;
		const root = (await git(ctx.cwd, ["rev-parse", "--show-toplevel"]))?.trim();
		const base = root && (await git(root, ["rev-parse", "HEAD"]))?.trim();
		if (!root || !base) return;
		const now = await snapshot(root, base);
		if (now) repo = { root, base, ...now };
	});

	pi.on("tool_execution_start", (event) => {
		if (event.toolName === "bash" && !event.parentToolCallId) {
			const command = (event.args as { command?: unknown } | undefined)?.command;
			if (typeof command === "string") commands.set(event.toolCallId, command);
		}
	});

	pi.on("tool_execution_end", async (event) => {
		if (!repo || event.parentToolCallId || !MAY_CHANGE.has(event.toolName)) return;
		const command = commands.get(event.toolCallId);
		commands.delete(event.toolCallId);
		const now = await snapshot(repo.root, repo.base);
		let changed: string[] | undefined;
		if (now && now.fingerprint !== repo.fingerprint) {
			changed = [...now.files].filter((name) => !repo!.files.has(name));
			// A further edit to a file already changed in this run still counts.
			if (changed.length === 0) changed = [...now.files];
			repo = { ...repo, ...now };
		}
		gate.record(event.toolName, command, changed);
	});

	pi.on("agent_before_settle", (event) => {
		const files = repo && gate.reminder();
		if (!files) return;
		return {
			entries: [...event.entries, { type: "custom_message", customType: CUSTOM_TYPE, content: reminderText(files), display: false }],
			continue: true,
		};
	});
}
