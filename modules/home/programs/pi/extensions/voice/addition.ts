// What happens to speech that comes after the person's voice message was sent: the rule the
// person chose (Q3 in DESIGN.md), in one place.
//
// - Total rewind (the answer dropped, the message resent with the new words appended) when he
//   goes on just after finishing, to add details: his new speech started before Pi began to
//   speak its answer, and no tool has changed files since the message.
// - Otherwise a steer: the words go to the running turn (deliverAs "steer"), or, when Pi's run
//   is already over, as the next message. That covers speech while Pi speaks, and speech after a
//   tool that changed files.
// - Once the answer has been spoken to the end, new speech is a new message.

/** Where the daemon heard the new speech start, relative to Pi's answer to the last voice message. */
export type Phase = "before_speech" | "while_speaking" | "after_answer";

export type Addition =
	| { action: "rewind"; entryId: string; text: string }
	| { action: "steer"; text: string }
	| { action: "message"; text: string };

export interface Situation {
	phase: Phase;
	/** The session entry of the voice message being answered, if the last message was a voice one. */
	voiceEntryId: string | undefined;
	/** That message's text. */
	voiceText: string | undefined;
	/** Whether a tool changed files since that message (edit, write, a bash call that changed files). */
	filesChanged: boolean;
	/** Whether Pi's run is still going. */
	running: boolean;
}

export function whatToDoWithAddition(speech: string, s: Situation): Addition {
	if (s.phase === "before_speech" && s.voiceEntryId !== undefined && s.voiceText !== undefined && !s.filesChanged) {
		return { action: "rewind", entryId: s.voiceEntryId, text: joinAddition(s.voiceText, speech) };
	}
	if (s.phase !== "after_answer" && s.running) return { action: "steer", text: speech };
	return { action: "message", text: speech };
}

/** The old message and what he added, as if said in one go. */
export function joinAddition(before: string, after: string): string {
	const a = before.trimEnd();
	const b = after.trim();
	if (!a) return b;
	if (!b) return a;
	return `${a} ${b}`;
}

/** Tools that change files when they run; bash counts when bash-changes saw it change some. */
export function changedFiles(toolName: string, details: unknown, isError: boolean): boolean {
	if (isError) return false;
	if (toolName === "edit" || toolName === "write") return true;
	if (toolName === "bash") {
		const changes = (details as { fileChanges?: { files?: unknown[] } } | undefined)?.fileChanges;
		return Array.isArray(changes?.files) ? changes.files.length > 0 : false;
	}
	return false;
}
