// Pi fills the editor's up-arrow history only with the prompts still in the
// model's context, and only into the editor that exists when it renders the
// session. This extension's editor is created at session_start, so it seeds
// the whole branch itself and skips Pi's replay of the in-context prompts,
// which follows in some paths (startup, /tree) and not in others (/reload,
// /resume, /new, /fork render before session_start).

export class ReplayFilter {
	#expected: string[];

	constructor(inContext: readonly string[]) {
		this.#expected = [...inContext];
	}

	// True for a call that repeats the next expected prompt. Anything else
	// means Pi isn't replaying (or has finished), so the filter disarms.
	skip(text: string): boolean {
		if (this.#expected[0] === text.trim()) {
			this.#expected.shift();
			return true;
		}
		this.#expected = [];
		return false;
	}

	disarm(): void {
		this.#expected = [];
	}
}
