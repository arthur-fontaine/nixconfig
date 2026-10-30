// One tool execution that can be detached from its turn while it runs.
import { placeholder, type Result } from "./records.ts";

export interface Outcome {
	result: Result;
	isError: boolean;
}

export type Execute = (signal: AbortSignal, onUpdate: (partial: Result) => void) => Promise<Result & { isError?: boolean }>;

export interface CallEvents {
	detached(call: DetachableCall): void;
	updated(call: DetachableCall): void;
	ended(call: DetachableCall, outcome: Outcome): void;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class DetachableCall {
	readonly startedAt = Date.now();
	readonly #events: CallEvents;
	// Its own controller: once detached, the turn's abort must not reach it.
	readonly #controller = new AbortController();
	readonly #detach: Promise<void>;
	#resolveDetach!: () => void;
	#settled?: Promise<Outcome>;
	#outcome?: Outcome;
	#partial?: Result;
	#detached = false;
	#stopped = false;
	#closed = false;

	readonly toolCallId: string;
	readonly toolName: string;

	constructor(toolCallId: string, toolName: string, events: CallEvents) {
		this.toolCallId = toolCallId;
		this.toolName = toolName;
		this.#events = events;
		this.#detach = new Promise((resolve) => {
			this.#resolveDetach = resolve;
		});
	}

	get detached() {
		return this.#detached;
	}

	get running() {
		return !this.#outcome && !this.#closed;
	}

	get stopped() {
		return this.#stopped;
	}

	get elapsedMs() {
		return Date.now() - this.startedAt;
	}

	/** The latest partial result, or the final one once it has ended. */
	get latest(): Result | undefined {
		return this.#outcome?.result ?? this.#partial;
	}

	get outcome(): Outcome | undefined {
		return this.#outcome;
	}

	/**
	 * Runs the tool. Until it is detached this is the tool's own execution: same
	 * updates, same abort, same result or rejection. Once detached it resolves
	 * with a placeholder and the operation carries on.
	 */
	async run(execute: Execute, turnSignal: AbortSignal | undefined, onUpdate: ((partial: Result) => void) | undefined): Promise<Result> {
		const abort = () => {
			if (!this.#detached) this.#controller.abort(turnSignal?.reason);
		};
		if (turnSignal?.aborted) abort();
		else turnSignal?.addEventListener("abort", abort, { once: true });
		let operation: ReturnType<Execute>;
		try {
			operation = execute(this.#controller.signal, (partial) => this.#update(partial, onUpdate));
		} catch (error) {
			operation = Promise.reject(error);
		}
		const settled = operation.then(
			(result): Outcome => ({ result, isError: result.isError ?? false }),
			(error): Outcome => ({ result: { content: [{ type: "text", text: errorText(error) }], details: undefined }, isError: true }),
		);
		this.#settled = settled.then((outcome) => {
			turnSignal?.removeEventListener("abort", abort);
			this.#outcome = outcome;
			if (this.#detached && !this.#closed) this.#events.ended(this, outcome);
			return outcome;
		});
		await Promise.race([this.#settled, this.#detach]);
		if (!this.#detached) return operation;
		return placeholder(this.toolCallId, this.startedAt);
	}

	detach(): boolean {
		if (this.#detached || !this.running || this.#controller.signal.aborted) return false;
		this.#detached = true;
		this.#events.detached(this);
		this.#resolveDetach();
		return true;
	}

	/** Stops a detached call and waits for its outcome. */
	async stop(): Promise<Outcome | undefined> {
		if (!this.#detached || !this.running) return undefined;
		this.#stopped = true;
		this.#controller.abort(new Error("Stopped by bash_kill."));
		return this.#settled;
	}

	/** Aborts the operation for good, without reporting its outcome. */
	close() {
		if (this.#closed) return;
		this.#closed = true;
		this.#controller.abort(new Error("Pi is leaving this session."));
	}

	#update(partial: Result, forward: ((partial: Result) => void) | undefined) {
		if (this.#closed || this.#outcome) return;
		this.#partial = partial;
		if (!this.#detached) forward?.(partial);
		else this.#events.updated(this);
	}
}
