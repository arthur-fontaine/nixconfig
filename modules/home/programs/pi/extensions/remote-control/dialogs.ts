// Pi dialogs other extensions open while the person may be away, shown in the Claude apps
// as Claude Code shows its own (Claude Code 2.1.314): a tool approval as its permission
// sheet, a choice as an AskUserQuestion sheet. The terminal dialog stays up; the first
// answer wins and the other side is withdrawn.
import { isDeepStrictEqual } from "node:util";
import { claudeToolUse } from "./claude-tools.ts";

// The contract. A requester emits on this channel:
//   const dialog = { request, signal };
//   pi.events.emit(DIALOG, dialog);
//   const result = dialog.run ? await dialog.run(local) : await local(signal);
// `local(signal)` opens the terminal dialog, dismissed when `signal` aborts. With Remote
// Control on, remote-control sets `run` synchronously; without it nobody does, and the
// terminal dialog alone is the fallback.
export const DIALOG = "remote-control:dialog";

export type DialogRequest =
	// A tool call auto mode wants the person to approve. Pi's tool name and input.
	| { kind: "permission"; toolName: string; toolCallId: string; input: Record<string, unknown>; reason: string; reasonCode?: string }
	// One choice among 2 to 4 options, as ctx.ui.select asks it.
	| { kind: "choice"; question: string; header?: string; options: string[] };

export type PermissionAnswer = { allow: boolean; message?: string };
export type ChoiceAnswer = string | undefined;

export interface DialogEvent {
	request: DialogRequest;
	signal?: AbortSignal;
	run?: (local: (signal: AbortSignal) => Promise<any>) => Promise<any>;
}

// The apps' sheet gave no usable answer (an error, or Remote Control stopped): the terminal decides.
export const NO_ANSWER = Symbol("no answer");

// Runs the terminal dialog against the apps' answer. The first one wins: an answer from the
// apps dismisses the terminal dialog; one from the terminal (or `signal` aborting it) goes to
// `withdraw`, which takes the sheet back from the apps.
export async function firstAnswer<R>(
	local: (signal: AbortSignal) => Promise<R>,
	remote: Promise<R | typeof NO_ANSWER>,
	withdraw: (result: R | undefined, aborted: boolean) => void,
	signal?: AbortSignal,
): Promise<R> {
	const dismiss = new AbortController();
	const localSignal = signal ? AbortSignal.any([signal, dismiss.signal]) : dismiss.signal;
	const fromLocal = local(localSignal).then(
		(result) => ({ remote: false, result }),
		(error) => {
			withdraw(undefined, true);
			throw error;
		},
	);
	const fromRemote = remote.then((result) => (result === NO_ANSWER ? new Promise<never>(() => {}) : { remote: true, result }));
	const first = await Promise.race([fromLocal, fromRemote]);
	if (first.remote) {
		dismiss.abort();
		await fromLocal.catch(() => {});
	} else {
		withdraw(first.result, signal?.aborted === true);
	}
	return first.result;
}

// Claude Code's display name for a tool (its yY): the last `__` part, words capitalized.
export function displayName(tool: string) {
	return (tool.split("__").pop() || tool).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const oneLine = (text: string, max: number) => {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
};

// What the apps get for a dialog: the control_request's `request`, and the
// requires_action_details the worker reports while it waits.
export interface Prompt {
	request: Record<string, unknown>;
	details: Record<string, unknown>;
}

// As the REPL bridge sends a permission prompt, with the SDK's decision_reason fields, which
// Claude Code fills for a classifier's escalation: its description is the call's summary,
// then the reason on the next line.
export function permissionPrompt(request: Extract<DialogRequest, { kind: "permission" }>, requestId: string): Prompt {
	const { name, input } = claudeToolUse(request.toolName, request.input);
	const command = typeof input.command === "string" ? input.command : undefined;
	const summary = command !== undefined ? oneLine(command, 120) : String(input.file_path ?? input.path ?? input.pattern ?? input.url ?? "");
	return {
		request: {
			subtype: "can_use_tool",
			tool_name: name,
			display_name: displayName(name),
			input,
			tool_use_id: request.toolCallId,
			description: summary ? `${summary}\n${request.reason}` : request.reason,
			decision_reason: request.reason,
			decision_reason_type: "classifier",
			...(request.reasonCode && { decision_reason_code: request.reasonCode }),
		},
		details: {
			tool_name: name,
			display_tool_name: displayName(name),
			action_description: summary,
			...(command !== undefined && { raw_command: command }),
			tool_use_id: request.toolCallId,
			request_id: requestId,
			input,
		},
	};
}

// The control_response's `response` from the apps, as auto mode's answer.
export function permissionAnswer(response: any, sent: Record<string, unknown>): PermissionAnswer | typeof NO_ANSWER {
	if (response?.subtype !== "success") return NO_ANSWER;
	const decision = response.response;
	if (decision?.behavior === "allow") {
		const updated = decision.updatedInput;
		// Pi takes a call as the model wrote it; running the original after an edit in the app would mislead.
		if (updated && Object.keys(updated).length > 0 && !isDeepStrictEqual(updated, sent)) {
			return { allow: false, message: "The call was edited in the Claude app, and Pi can't run an edited call. Make the call again as edited." };
		}
		return { allow: true };
	}
	if (decision?.behavior === "deny") {
		const message = typeof decision.message === "string" ? decision.message.trim() : "";
		// Claude Code's own words for a plain deny carry no feedback for the model.
		return message && !/^User (denied permission|aborted)$/.test(message) ? { allow: false, message } : { allow: false };
	}
	return NO_ANSWER;
}

// What Claude Code sends the apps when its terminal prompt was answered, before withdrawing the sheet.
export function permissionLocalResponse(allowed: boolean | undefined, sent: Record<string, unknown>, aborted: boolean) {
	return allowed
		? { behavior: "allow", updatedInput: sent, updatedPermissions: [] }
		: { behavior: "deny", message: aborted ? "User aborted" : "User denied permission" };
}

// AskUserQuestion's limits: a chip of 12 characters at most, 2 to 4 options.
export const MAX_HEADER = 12;
export const canAsk = (request: Extract<DialogRequest, { kind: "choice" }>) => request.options.length >= 2 && request.options.length <= 4;

function choiceInput(request: Extract<DialogRequest, { kind: "choice" }>) {
	const header = (request.header ?? "Pi").slice(0, MAX_HEADER);
	return { questions: [{ question: request.question, header, multiSelect: false, options: request.options.map((label) => ({ label, description: "" })) }] };
}

// A choice as the AskUserQuestion sheet the apps already draw. With no tool call behind it, the
// tool_use_id is made up, as Claude Code does for its sandbox's network prompt.
export function choicePrompt(request: Extract<DialogRequest, { kind: "choice" }>, requestId: string, toolUseId: string): Prompt {
	const input = choiceInput(request);
	return {
		request: {
			subtype: "can_use_tool",
			tool_name: "AskUserQuestion",
			display_name: "AskUserQuestion",
			input,
			tool_use_id: toolUseId,
			description: request.question,
			requires_user_interaction: true,
		},
		details: askDetails(input.questions, requestId, toolUseId, input),
	};
}

// Claude Code's requires_action_details for AskUserQuestion: a "Question" card the person
// taps to answer, with the request id moved to suppressed_request_id.
export function askDetails(questions: { question: string; header?: string }[], requestId: string, toolUseId: string, input: unknown) {
	const first = questions[0];
	const title = first?.header || first?.question;
	return {
		tool_name: "AskUserQuestion",
		display_tool_name: "Question",
		action_description: title ? title + (questions.length > 1 ? ` (+${questions.length - 1} more)` : "") : "Tap to answer",
		tool_use_id: toolUseId,
		request_id: "",
		suppressed_request_id: requestId,
		input,
	};
}

// The option the apps chose. Anything else (dismissed, or a typed answer that is no option)
// is a dismissal, as Esc is in the terminal.
export function choiceAnswer(response: any, request: Extract<DialogRequest, { kind: "choice" }>): ChoiceAnswer | typeof NO_ANSWER {
	if (response?.subtype !== "success") return NO_ANSWER;
	if (response.response?.behavior !== "allow") return undefined;
	const value = response.response.updatedInput?.answers?.[request.question];
	const given = String(Array.isArray(value) ? value[0] ?? "" : value ?? "").trim().toLowerCase();
	return request.options.find((o) => o.trim().toLowerCase() === given);
}

export function choiceLocalResponse(choice: ChoiceAnswer, request: Extract<DialogRequest, { kind: "choice" }>) {
	return choice === undefined
		? { behavior: "deny", message: "User aborted" }
		: { behavior: "allow", updatedInput: { ...choiceInput(request), answers: { [request.question]: choice } } };
}
