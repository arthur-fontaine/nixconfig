// What the extension says in the chat when it acts, as Pi notices under the prompt. Pure, so the
// wording is tested on its own.

import type { Decision } from "./policy.ts";

const WHY: Record<string, string> = {
	related: "this prompt starts a related task",
	independent: "this prompt starts an unrelated task",
	return: "this prompt returns to an earlier task",
};

// `Context compacted: this prompt starts a related task`; `asked` when the person chose it in the dialog.
export function actedNote(decision: Pick<Decision, "action" | "category">, asked: boolean) {
	const done = decision.action === "clear" ? "Context cleared" : "Context compacted";
	const why = WHY[decision.category ?? ""];
	return done + (asked ? ", as you chose" : "") + (why ? ": " + why : "");
}

export const DECLINED = "Context kept: you chose to send the prompt as is";

// Pi prefixes warnings with "Warning: ", so this reads as a sentence.
export function failedNote(decision: Pick<Decision, "action">, message: string) {
	return "Could not " + (decision.action === "clear" ? "clear" : "compact") + " the context, so it was kept: " + message;
}

export function tokens(n: number) {
	return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n);
}
