// The bash rows drawn so far, to draw again. No Pi imports.

export class Rows {
	private readonly rows = new Map<string, () => void>();
	private readonly max: number;

	constructor(max: number) {
		this.max = max;
	}

	// The latest drawn last, so the oldest goes first past `max`.
	remember(id: string, invalidate: () => void) {
		this.rows.delete(id);
		this.rows.set(id, invalidate);
		if (this.rows.size > this.max) this.rows.delete(this.rows.keys().next().value!);
	}

	// Pi's invalidate renders the row on the spot, which remembers it again at the end of the
	// map: iterated live, the loop would come back to it forever (a heap out of memory).
	redrawAll() {
		for (const invalidate of [...this.rows.values()]) invalidate();
	}
}
