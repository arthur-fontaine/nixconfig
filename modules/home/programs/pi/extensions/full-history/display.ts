// What Pi's chat shows of a session, where Pi itself shows only what the model gets: the
// latest compaction's summary, the messages it kept and those after. Here the whole branch
// shows, each compaction as its collapsed summary where it happened. The model's context
// is untouched (Pi builds it with buildSessionContext, not with this).

export type Entry = { type: string; id: string };

// `context` is Pi's own list (its buildContextEntries), `branch` the entries from the root to
// the leaf. A chat redrawn from scratch (`initial`) gets the branch in order. When a
// compaction has just happened, Pi expects that compaction first, then redraws the rest and
// puts the summary where it belongs; it gets the whole branch there too.
export function displayEntries<E extends Entry>(context: E[], branch: E[], initial: boolean): E[] {
	const latest = context[0];
	if (latest?.type !== "compaction" || !branch.length) return context;
	if (initial) return branch;
	return [latest, ...branch.filter((e) => e.id !== latest.id)];
}

// Pi's chat redraws a session from scratch in these methods; the ones that follow a live
// compaction are the others.
export const INITIAL_RENDER = /\b(renderInitialMessages|rebuildChatFromMessages)\b/;
