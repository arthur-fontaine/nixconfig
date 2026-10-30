import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { conversation } from "./context.ts";
import {
	CACHE_ENTRIES,
	Lru,
	parseSuggestions,
	type Payload,
	type Shown,
	SUGGESTIONS,
	systemPrompt,
	typedAhead,
} from "./prediction.ts";

// Only the Claude subscription: suggestions never move to another provider's billing.
export const PROVIDER = "claude-code";
export const MODEL = "claude-haiku-5-5";
// Each attempt spawns `claude -p` (about 2-3 s in all, measured); a request cut
// short is paid for and thrown away, so the budget leaves room for a retry.
const BUDGET_MS = 15_000;
const ATTEMPTS = 2;
// Five short messages; 128 tokens, enough for a small local model's terse
// replies, would cut Haiku's JSON short at the 240-character limit.
const MAX_TOKENS = 512;

type Model = NonNullable<ReturnType<ExtensionContext["modelRegistry"]["find"]>>;

interface Snapshot {
	at: string;
	system: string;
	user: string;
}

export class Predictor {
	readonly #ctx: ExtensionContext;
	readonly #cache = new Lru<string[]>(CACHE_ENTRIES);
	#shown?: Shown;
	#snapshot?: Snapshot;
	#memo?: { leaf: string | null; key: string; turns: Payload["conversation"] };

	constructor(ctx: ExtensionContext) {
		this.#ctx = ctx;
	}

	ready(): boolean {
		try {
			return this.#ctx.isIdle();
		} catch {
			// A context from a replaced session throws; it predicts nothing more.
			return false;
		}
	}

	payload(draft: string): Payload {
		return { conversation: this.#turns().turns, draft };
	}

	// Building the projection walks the whole session, so it is redone only
	// when the branch moves.
	#turns(): { key: string; turns: Payload["conversation"] } {
		const session = this.#ctx.sessionManager;
		const leaf = session.getLeafId();
		if (this.#memo?.leaf !== leaf) {
			const turns = conversation(session.buildSessionProjection().messages);
			this.#memo = { leaf, key: JSON.stringify(turns), turns };
		}
		return this.#memo;
	}

	lookup(payload: Payload): string[] | undefined {
		const key = JSON.stringify(payload);
		const hit = this.#cache.get(key);
		if (hit) {
			this.#remember(payload, hit);
			return [...hit];
		}
		const ahead = typedAhead(this.#shown, this.#turns().key, payload.draft);
		return ahead.length ? ahead : undefined;
	}

	#remember(payload: Payload, suggestions: string[]): void {
		this.#shown = { conversation: JSON.stringify(payload.conversation), draft: payload.draft, suggestions };
	}

	model(): Model | undefined {
		const model = this.#ctx.modelRegistry.find(PROVIDER, MODEL);
		return model && this.#ctx.modelRegistry.hasConfiguredAuth(model) ? model : undefined;
	}

	async predict(payload: Payload, signal: AbortSignal): Promise<string[]> {
		if (signal.aborted || !this.ready()) return [];
		const model = this.model();
		if (!model) return [];
		const system = systemPrompt(payload.draft);
		const user = JSON.stringify(payload);
		this.#snapshot = { at: new Date().toISOString(), system, user };
		const budget = AbortSignal.any([signal, AbortSignal.timeout(BUDGET_MS)]);
		const message = { role: "user" as const, content: [{ type: "text" as const, text: user }], timestamp: Date.now() };
		for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
			let reply;
			try {
				reply = await this.#ctx.modelRegistry
					.streamSimple(model, { systemPrompt: system, messages: [message] }, { maxTokens: MAX_TOKENS, signal: budget })
					.result();
			} catch {
				return [];
			}
			if (budget.aborted || !this.ready()) return [];
			if (reply.stopReason === "error") continue;
			const text = reply.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
			const suggestions = parseSuggestions(text, payload.draft);
			if (suggestions.length !== SUGGESTIONS) continue;
			this.#cache.set(user, suggestions);
			this.#remember(payload, suggestions);
			return [...suggestions];
		}
		return [];
	}

	clear(): void {
		this.#cache.clear();
		this.#shown = undefined;
	}

	reset(): void {
		this.clear();
		this.#snapshot = undefined;
		this.#memo = undefined;
	}

	describe(draft: string): string {
		const snapshot =
			!draft && this.#snapshot
				? this.#snapshot
				: { at: `${new Date().toISOString()} (preview, not sent)`, system: systemPrompt(draft), user: JSON.stringify(this.payload(draft)) };
		const model = this.#ctx.modelRegistry.find(PROVIDER, MODEL);
		const state = !model ? "not found" : this.#ctx.modelRegistry.hasConfiguredAuth(model) ? "ready" : "no credentials";
		return [
			`Model: ${PROVIDER}/${MODEL} (${state})`,
			`Captured: ${snapshot.at}`,
			"",
			"--- system prompt ---",
			snapshot.system,
			"",
			"--- user message, as sent ---",
			snapshot.user,
			"",
			"--- user message, decoded ---",
			JSON.stringify(JSON.parse(snapshot.user), null, 2),
		].join("\n");
	}
}
