// The summarizer: the same request as training/pipeline/summarizer.py. System prompt =
// prompt.ts (compact-v2.md), one user message (a leaf, a merge, or a "too long" retry written into
// one message), the model pinned by full id (never the `haiku` alias), the same effort and output cap.

import { utf8Len } from "./text.ts";
import { LIMIT, RETRIES, retryPrompt, shortest } from "./tree.ts";

export const SUMMARIZER = { model: "claude-haiku-5-5", effort: "low", maxTokens: 4096 };

export type SummarizerSettings = typeof SUMMARIZER;

export interface SummaryRequest {
	model: string;
	system: string;
	prompt: string;
	effort: string;
	maxTokens: number;
}

// What a completion came back as, in the shape of Claude Code's $.model.complete result.
export type Completion =
	| { isAnswered: true; text: string }
	| { isAnswered: false; reason: string; status?: number; error?: string };

export class SummaryError extends Error {
	isLimit = false;
}

// prompts/compact-v2.md with its line limit and a ruler of that many bytes.
export function systemPromptV2(template: string, limit: number) {
	return template.replaceAll("{LIMIT}", String(limit)).replaceAll("{RULER}", "-".repeat(limit));
}

export function summaryRequest(prompt: string, system: string, settings: SummarizerSettings = SUMMARIZER): SummaryRequest {
	return { model: settings.model, system, prompt, effort: settings.effort, maxTokens: settings.maxTokens };
}

// One node: (line, calls). A usage limit or an API error throws.
// `limit` and `clean` are the format's (v2: tree.MEMORY_LIMIT and tree.cleanLineV2).
export async function summarize(
	complete: (request: SummaryRequest) => Promise<Completion>,
	prompt: string,
	system: string,
	settings: SummarizerSettings = SUMMARIZER,
	{ limit = LIMIT, clean = (text: string) => (text ?? "").trim() } = {},
) {
	const lines: string[] = [];
	let ask = prompt;
	let calls = 0;
	for (let attempt = 0; attempt <= RETRIES; attempt++) {
		const r = await complete(summaryRequest(ask, system, settings));
		calls++;
		if (!r.isAnswered) {
			const error = new SummaryError("summary call failed: " + r.reason + (r.status ? " " + r.status : "") +
				(r.error ? " " + r.error : ""));
			error.isLimit = r.status === 429 || r.error === "rate_limit";
			throw error;
		}
		const line = clean(r.text);
		if (line) {
			lines.push(line);
			if (utf8Len(line) <= limit) break;
			ask = retryPrompt(prompt, line, limit);
		}
	}
	if (!lines.length) throw new Error("the summarizer returned no text");
	return { line: shortest(lines), calls };
}
