// The two-stage classifier call and its verdict (SPEC.md §2 "Parsing" and "Decision").
import { isKnownRule, ruleName, slug, SUFFIX, type Thresholds } from "./prompt.ts";

export type Stop = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface Reply {
	text: string;
	stop: Stop;
	error?: string;
}

export interface Request {
	system: string;
	// Leading user messages (the CLAUDE.md one), then the transcript message.
	leading: string[];
	transcript: string;
	maxTokens: number;
	stopSequence: string;
	signal: AbortSignal;
}

export type Complete = (request: Request) => Promise<Reply>;

export type Verdict =
	| { kind: "allow"; reason: string; stage: "fast" | "thinking"; severity?: number }
	| { kind: "block"; reason: string; stage: "fast" | "thinking"; category?: string; severity?: number }
	| { kind: "parse_failure"; reason: string }
	| { kind: "refusal"; reason: string }
	| { kind: "unavailable"; reason: string; status: string; error?: string }
	| { kind: "too_long"; reason: string }
	| { kind: "aborted"; reason: string };

const MAX_RETRIES = 4;
const STAGE1_BASE_MS = 60_000;
const STAGE2_DEADLINE_MS = 120_000;
const STAGE2_ATTEMPT_MS = 60_000;

export function stage1TimeoutMs(tokens: number): number {
	const steps = Math.max(0, Math.ceil((tokens - 50_000) / 50_000));
	return Math.min(STAGE2_DEADLINE_MS, STAGE1_BASE_MS + steps * 10_000);
}

export function withoutThinking(text: string): string {
	return text.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").replace(/<thinking>[\s\S]*$/, "");
}

// The severity, or null when the reply cannot be read as one. Only a reply that ended
// on its own counts, as Claude Code's stop_sequence / end_turn check.
export function parseSeverity(reply: Reply): number | null {
	if (reply.stop !== "stop") return null;
	const text = reply.text.replace(/<thinking>[\s\S]*?<\/thinking>/g, "");
	if (text.includes("<thinking>")) return null;
	const matches = [...text.matchAll(/<severity>\s*(\d+(?:\.\d+)?)\s*(<\/severity>)?/g)];
	return matches.length === 1 ? Number(matches[0]![1]) : null;
}

export function parseBlock(text: string): boolean | null {
	if (new Set([...text.matchAll(/<block>(yes|no)\b/gi)].map((m) => m[1]!.toLowerCase())).size > 1) return null;
	const answers = new Set([...withoutThinking(text).matchAll(/<block>(yes|no)\b(<\/block>)?/gi)].map((m) => m[1]!.toLowerCase()));
	if (answers.size !== 1) return null;
	return answers.has("yes");
}

export function parseReason(text: string): string | null {
	const match = withoutThinking(text).match(/<reason>([\s\S]*?)<\/reason>/);
	return match ? match[1]!.trim() : null;
}

export function parseCategory(text: string): { slug: string; name: string } | undefined {
	const matches = [...withoutThinking(text).matchAll(/<category>([a-z0-9 &_-]{1,64})<\/category>/gi)];
	if (matches.length !== 1) return undefined;
	const raw = matches[0]![1]!;
	const s = slug(raw);
	if (!isKnownRule(s)) return undefined;
	return { slug: s, name: ruleName(s) ?? raw.replace(/[^A-Za-z0-9]+/g, " ").trim() };
}

const CANNOT_EVALUATE = "Auto mode could not evaluate this action and is blocking it for safety";
export function cannotEvaluate(refusal: boolean): string {
	const why = refusal
		? " — a safety check separate from auto mode blocked this request because of earlier conversation content — it isn't about the action itself"
		: "";
	return `${CANNOT_EVALUATE}${why} — run with --debug for details`;
}

// pi-claude-code reports Claude Code's failures as error text; these are the shapes it uses.
export function failureOf(reply: Reply): "refusal" | "too_long" | "aborted" | "transient" | "other" {
	if (reply.stop === "aborted") return "aborted";
	const error = reply.error ?? "";
	if (/refused to complete the request|stop reason: refusal/i.test(error)) return "refusal";
	if (/prompt is too long|input is too long|context window|too many tokens|context_length/i.test(error)) return "too_long";
	if (/\b(429|5\d\d)\b|overloaded|rate.?limit|timed? ?out|timeout|ECONN|ETIMEDOUT|socket|network|connection/i.test(error)) return "transient";
	return "other";
}

export function statusOf(error: string | undefined): string {
	const e = error ?? "";
	if (/\b429\b|rate.?limit/i.test(e)) return " (rate-limited)";
	if (/\b529\b|overloaded/i.test(e)) return " (overloaded)";
	if (/\b5\d\d\b/.test(e)) return " (server error)";
	if (/timed? ?out|timeout|ETIMEDOUT/i.test(e)) return " (timed out)";
	if (/ECONN|socket|network|connection/i.test(e)) return " (connection failed)";
	return "";
}

const sleep = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
	});

interface StageOptions {
	request: Omit<Request, "signal">;
	parsed: (reply: Reply) => boolean;
	signal: AbortSignal;
	attemptMs: number;
	// Claude Code re-arms the stage-1 deadline on each attempt; stage 2 has one deadline.
	deadlineMs?: number;
	now: () => number;
	delay: (ms: number, signal: AbortSignal) => Promise<void>;
}

// One stage with Claude Code's retries: transient API errors (the SDK's 4 retries,
// exponential backoff) and unparseable replies (re-requested up to 4 times).
async function runStage(complete: Complete, o: StageOptions): Promise<Reply> {
	const started = o.now();
	let reply: Reply = { text: "", stop: "error", error: "not sent" };
	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		const left = o.deadlineMs === undefined ? o.attemptMs : Math.min(o.attemptMs, o.deadlineMs - (o.now() - started));
		if (left <= 0 || o.signal.aborted) break;
		const signal = AbortSignal.any([o.signal, AbortSignal.timeout(left)]);
		reply = await complete({ ...o.request, signal }).catch((error: unknown) => ({
			text: "",
			stop: "error" as const,
			error: error instanceof Error ? error.message : String(error),
		}));
		if (reply.stop === "aborted" && !o.signal.aborted) reply = { text: "", stop: "error", error: "timed out" };
		if (reply.stop === "aborted") return reply;
		if (reply.stop === "error") {
			if (failureOf(reply) !== "transient") return reply;
			await o.delay(Math.min(8000, 500 * 2 ** attempt), o.signal);
			continue;
		}
		if (o.parsed(reply)) return reply;
		if (!reply.text.trim() && reply.stop !== "stop") return reply;
	}
	return reply;
}

export interface ClassifyOptions {
	system: string;
	leading: string[];
	transcript: string;
	thresholds: Thresholds | null;
	tokens: number;
	signal: AbortSignal;
	now?: () => number;
	delay?: (ms: number, signal: AbortSignal) => Promise<void>;
}

// After stage 1 has run, a stage-2 API failure is not "unavailable" in Claude Code: it
// blocks on stage 1's assessment and counts as a denial.
function errorVerdict(reply: Reply, afterStage1: boolean): Verdict {
	switch (failureOf(reply)) {
		case "aborted":
			return { kind: "aborted", reason: "Classifier request aborted" };
		case "refusal":
			return { kind: "refusal", reason: cannotEvaluate(true) };
		case "too_long":
			return { kind: "too_long", reason: "Classifier transcript exceeded context window" };
		default:
			if (afterStage1)
				return {
					kind: "block",
					stage: "thinking",
					reason: "Stage 2 classifier error - blocking based on stage 1 assessment (usually transient \u2014 retrying often succeeds)",
				};
			return { kind: "unavailable", reason: "Classifier unavailable - blocking for safety", status: statusOf(reply.error), ...(reply.error && { error: reply.error }) };
	}
}

export async function classify(complete: Complete, o: ClassifyOptions): Promise<Verdict> {
	const now = o.now ?? Date.now;
	const delay = o.delay ?? sleep;
	const severity = o.thresholds;
	const timeout = stage1TimeoutMs(o.tokens);
	const base = { system: o.system, leading: o.leading };

	const stage1 = await runStage(complete, {
		request: {
			...base,
			transcript: o.transcript + (severity ? SUFFIX.severity1 : SUFFIX.block1),
			maxTokens: 64,
			stopSequence: severity ? "</severity>" : "</block>",
		},
		parsed: (r) => (severity ? parseSeverity(r) !== null : r.stop === "stop" && parseBlock(r.text) !== null),
		signal: o.signal,
		attemptMs: timeout,
		now,
		delay,
	});
	if (stage1.stop === "error" || stage1.stop === "aborted") {
		const verdict = errorVerdict(stage1, false);
		if (verdict.kind !== "refusal") return verdict;
	}

	let stage1Block: { reason: string; category?: string; severity?: number } | undefined;
	if (stage1.stop !== "error") {
		const score = severity ? parseSeverity(stage1) : undefined;
		const blocks = severity ? (score === null ? null : score! > severity.t1) : stage1.stop === "stop" ? parseBlock(stage1.text) : null;
		const trimmed = stage1.text.trim();
		const exact = severity ? /^<severity>\s*\d+(?:\.\d+)?\s*(?:<\/severity>)?$/.test(trimmed) : trimmed === "<block>no" || trimmed === "<block>no</block>";
		if (blocks === false && exact) return { kind: "allow", reason: "Allowed by fast classifier", stage: "fast", ...(score != null && { severity: score }) };
		if (blocks === true) {
			const category = parseCategory(stage1.text);
			stage1Block = {
				reason: severity ? (category ? `[${category.name}]` : "Blocked by fast classifier") : (parseReason(stage1.text) ?? "Blocked by fast classifier"),
				...(category && { category: category.slug }),
				...(score != null && { severity: score }),
			};
		}
	}
	const stage1Refused = stage1.stop === "error";

	const stage2 = await runStage(complete, {
		request: { ...base, transcript: o.transcript + (severity ? SUFFIX.severity2 : SUFFIX.block2), maxTokens: 8192, stopSequence: "" },
		parsed: (r) => (severity ? parseSeverity(r) !== null : r.stop === "stop" && parseBlock(r.text) !== null),
		signal: o.signal,
		attemptMs: Math.max(STAGE2_ATTEMPT_MS, timeout),
		deadlineMs: STAGE2_DEADLINE_MS,
		now,
		delay,
	});
	if (stage2.stop === "aborted") return { kind: "aborted", reason: "Classifier request aborted" };
	if (stage2.stop === "error") {
		const failure = failureOf(stage2);
		if (failure === "refusal" && stage1Block) return { kind: "block", stage: "fast", ...stage1Block };
		if (failure === "refusal" || stage1Refused) return { kind: "refusal", reason: cannotEvaluate(true) };
		return errorVerdict(stage2, !stage1Refused);
	}
	const score = severity ? parseSeverity(stage2) : undefined;
	const blocks = severity ? (score === null ? null : score! > severity.t2) : stage2.stop === "stop" ? parseBlock(stage2.text) : null;
	if (blocks === null) {
		if (stage1Refused) return { kind: "refusal", reason: cannotEvaluate(true) };
		return { kind: "parse_failure", reason: cannotEvaluate(false) };
	}
	if (!blocks) return { kind: "allow", reason: "Allowed by classifier", stage: "thinking", ...(score != null && { severity: score }) };
	const category = parseCategory(stage2.text);
	return {
		kind: "block",
		stage: "thinking",
		reason: severity ? (category ? `[${category.name}]` : "Blocked by classifier") : (parseReason(stage2.text) ?? "No reason provided"),
		...(category && { category: category.slug }),
		...(score != null && { severity: score }),
	};
}
