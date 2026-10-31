// What the model reads when auto mode stops a call, verbatim from Claude Code (SPEC.md §3).
const WORK_AROUND =
	"IMPORTANT: You *may* attempt to accomplish this action using other tools that might naturally be used to accomplish this goal, e.g. using head instead of cat. But you *should not* attempt to work around this denial in malicious ways, e.g. do not use your ability to run tests to execute non-test actions. You should only try to work around this restriction in reasonable ways that do not attempt to bypass the intent behind this denial. ";
const ESSENTIAL =
	"If you believe this capability is essential to complete the user's request, first try a safer method. Get as much of the rest of the task done as you can, then STOP and explain to the user what you were trying to do and why you need this permission. Let the user decide how to proceed.";
const KEEPS_FAILING = "If it keeps failing, continue with other tasks that don't require this action and come back to it later.";
const READ_ONLY_NOTE = "Note: reading files, searching code, and other read-only operations do not require the classifier and can still be used.";

export function blockedMessage(reason: string): string {
	return `Permission for this action was denied by the Claude Code auto mode classifier. Reason: ${reason}. If you have other tasks that don't depend on this action, continue working on those. ${WORK_AROUND}${ESSENTIAL}`;
}

export function noVerdictMessage(reason: string, refused: boolean): string {
	const next = refused
		? "Retrying it will hit the same refusal, so don't rewrite or rework the action to get around this — it reacts to earlier conversation content, not to the action itself, and it will keep firing for the rest of this conversation. " +
			"Continue with other tasks that don't require this action. If it is essential, stop and tell the user that auto mode could not evaluate it, and suggest running this action outside auto mode (switch back to the default permission mode) or starting a fresh session."
		: `This is usually transient — wait briefly and try this action again as-is; don't rewrite it. ${KEEPS_FAILING}`;
	return `${reason}. This is not a judgment that the action is unsafe. ${next} ${READ_ONLY_NOTE}`;
}

export function unavailableMessage(model: string, tool: string, status: string): string {
	return `${model} is temporarily unavailable${status}, so auto mode cannot determine the safety of ${tool} right now. Wait a moment and then try this action again. ${KEEPS_FAILING} ${READ_ONLY_NOTE}`;
}

export const REJECTED =
	"The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

// Claude Code's, when the person gave a reason with the rejection (from the Claude apps).
export const rejectedWithFeedback = (feedback: string) =>
	`The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). To tell you how to proceed, the user said:\n${feedback}`;

export const TOO_LONG_REASON =
	"Auto mode classifier transcript exceeded context window — falling back to manual approval (try /compact to reduce conversation size)";
export const TOO_LONG_PROMPT =
	"The conversation is too long for auto mode's check, so this needs your approval. Run /compact to shorten the conversation.";
export const TOO_LONG_HEADLESS = "Agent aborted: auto mode classifier transcript exceeded context window in headless mode";
export const LIMIT_HEADLESS = "Agent aborted: too many classifier denials in headless mode";
