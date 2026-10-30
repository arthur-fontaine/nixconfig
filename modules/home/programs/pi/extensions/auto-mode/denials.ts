// Claude Code's denial tracking (SPEC.md §4).
export const LIMITS = { maxConsecutive: 3, maxTotal: 20 };

export interface Denials {
	consecutive: number;
	total: number;
}

export const fresh = (): Denials => ({ consecutive: 0, total: 0 });

export const allowed = (d: Denials): Denials => (d.consecutive === 0 ? d : { ...d, consecutive: 0 });

export const blocked = (d: Denials): Denials => ({ consecutive: d.consecutive + 1, total: d.total + 1 });

export const overLimit = (d: Denials) => d.consecutive >= LIMITS.maxConsecutive || d.total >= LIMITS.maxTotal;

// What the person is asked once a block reaches a limit, and the counters after it:
// reaching the total starts both counts over.
export function limitPrompt(d: Denials, reason: string): { text: string; next: Denials } {
	const total = d.total >= LIMITS.maxTotal;
	const head = total
		? `${d.total} actions were blocked this session. Please review the transcript before continuing.`
		: `${d.consecutive} consecutive actions were blocked. Please review the transcript before continuing.`;
	return { text: `${head}\n\nLatest blocked action: ${reason}`, next: total ? fresh() : d };
}
