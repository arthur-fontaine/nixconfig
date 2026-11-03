// Replays a Pi session's bash calls through the Bash fast path, without calling any model:
//   node tests/replay.ts SESSION.jsonl CWD [OLD_FASTPATH.ts]
// Prints how many calls skip the classifier (and, given an older fastpath.ts, how many did
// before), then the calls still sent to the classifier grouped by the read-only check's reason.
import { readFileSync } from "node:fs";
import path from "node:path";

import { bashFastPath } from "../fastpath.ts";
import { readOnlyRefusal } from "../readonly.ts";

const [session, cwd, old] = process.argv.slice(2);
if (!session || !cwd) {
	console.error("usage: node tests/replay.ts SESSION.jsonl CWD [OLD_FASTPATH.ts]");
	process.exit(2);
}

const commands: string[] = [];
for (const line of readFileSync(session, "utf8").split("\n")) {
	if (!line.trim()) continue;
	const entry = JSON.parse(line);
	if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
	for (const block of entry.message.content ?? [])
		if (block?.type === "toolCall" && block.name === "bash" && typeof block.arguments?.command === "string") commands.push(block.arguments.command);
}

const tally = (fast: (c: string) => string | undefined) => {
	const counts: Record<string, number> = {};
	for (const c of commands) {
		const why = fast(c) ?? "classifier";
		counts[why] = (counts[why] ?? 0) + 1;
	}
	return counts;
};

console.log(`${commands.length} bash calls, cwd ${cwd}`);
if (old) {
	const before = (await import(path.resolve(old))) as { bashFastPath: typeof bashFastPath };
	console.log("before:", tally((c) => before.bashFastPath(c, cwd)));
}
console.log("after: ", tally((c) => bashFastPath(c, cwd)));

const byReason = new Map<string, string[]>();
for (const c of commands) {
	if (bashFastPath(c, cwd)) continue;
	const reason = readOnlyRefusal(c, cwd) ?? "?";
	byReason.set(reason, [...(byReason.get(reason) ?? []), c]);
}
console.log("\nstill sent to the classifier, by reason:");
for (const [reason, cs] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
	console.log(`\n${reason} (${cs.length})`);
	for (const c of cs) console.log(`  ${JSON.stringify(c.length > 160 ? `${c.slice(0, 160)}…` : c)}`);
}
