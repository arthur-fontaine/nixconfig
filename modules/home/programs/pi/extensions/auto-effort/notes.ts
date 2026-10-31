// What the extension says in the chat, as Pi notices under the prompt. Pure, so the wording is tested on its own.
import { type Decision, isLevel, LEVELS, type Level } from "./policy.ts";

// Nisev's categories, and for a Jev answer the level it picked, in a few plain words.
const KIND: Record<string, string> = {
	trivial: "a quick request",
	light: "a small change",
	ordinary: "a typical task",
	multi_step: "multi-step work",
	hard: "a hard task",
	exhaustive: "an exhaustive task",
};
const KIND_OF_LEVEL: Record<Level, string> = {
	low: KIND.trivial!,
	medium: KIND.light!,
	high: KIND.multi_step!,
	xhigh: KIND.hard!,
	max: KIND.exhaustive!,
};

export function kindOf(decision: Pick<Decision, "category" | "choice">) {
	if (decision.category && KIND[decision.category]) return KIND[decision.category];
	return isLevel(decision.choice) ? KIND_OF_LEVEL[decision.choice] : undefined;
}

// `Thinking for this prompt: high, for multi-step work`. `level` is what the run got: the pick, unless
// AUTO_EFFORT_MIN/MAX_EFFORT or the model's own range moved it.
export function changeNote(decision: Pick<Decision, "category" | "choice">, level: string) {
	const picked = isLevel(decision.choice) ? LEVELS.indexOf(decision.choice) : -1;
	const got = LEVELS.indexOf(level as Level);
	const bound = picked < 0 || got < 0 || picked === got ? "" : picked > got ? ", the highest allowed" : ", the lowest allowed";
	const kind = kindOf(decision);
	return `Thinking for this prompt: ${level}${bound}${kind ? `, for ${kind}` : ""}`;
}

export interface Problem {
	// Repeats of one kind stay silent until a prompt is decided again.
	kind: string;
	text: string;
	type: "info" | "warning";
}

// Why a prompt keeps the session's level when it isn't the classifier's own choice; null when it is
// (the model doesn't think), which needs no line: Pi's footer shows the level. An empty kind isn't deduplicated.
export function problemNote(reason: string, level: string, leaned?: string): Problem | null {
	switch (reason) {
		case "model takes no effort":
			return null;
		// Not a problem, but silence read as the picker not running.
		case "low confidence":
			return {
				kind: "",
				text: `Thinking kept at: ${level}, ${leaned ? `the picker leaned to ${leaned} but was unsure` : "the picker was unsure"}`,
				type: "info",
			};
		case "Nisev starting":
			return { kind: "Nisev loading", text: `Nisev starting: thinking stays at ${level} until it is ready`, type: "info" };
		case "Nisev downloading":
			return { kind: "Nisev loading", text: `Nisev downloading its model: thinking stays at ${level} until it is ready`, type: "info" };
		// Pi prefixes warnings with "Warning: ", so these read as sentences.
		case "Nisev stopped":
			return { kind: reason, text: `Nisev is not running, so thinking stays at ${level}. See /auto-effort.`, type: "warning" };
		case "Nisev unavailable":
			return { kind: reason, text: `Nisev did not answer, so thinking stays at ${level}. See /auto-effort.`, type: "warning" };
		case "endpoint unavailable":
			return { kind: reason, text: `The effort classifier did not answer, so thinking stays at ${level}. See /auto-effort.`, type: "warning" };
		default:
			return { kind: "no answer", text: `The effort classifier gave no usable answer, so thinking stays at ${level}.`, type: "warning" };
	}
}

// The `/auto-effort` status line for the last decision, with the level the prompt ran at, never "default".
export function describeDecision(decision: Decision, level: string) {
	const sure = typeof decision.confidence === "number" ? `${Math.round(decision.confidence * 100)}% sure` : "";
	const kind = kindOf(decision);
	if (decision.effort) {
		const picked = decision.choice && decision.choice !== decision.effort ? `, picked ${decision.choice}` : "";
		return `set to ${decision.effort}${picked}${kind ? `, for ${kind}` : ""}${sure && ` (${sure})`}`;
	}
	if (decision.reason === "low confidence") return `kept ${level}; it leaned to ${decision.choice} but was only ${sure}`;
	return `kept ${level} (${decision.reason})`;
}
