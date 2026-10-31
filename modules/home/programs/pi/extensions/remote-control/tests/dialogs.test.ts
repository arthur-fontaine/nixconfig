import assert from "node:assert/strict";
import { test } from "node:test";
import {
	canAsk,
	choiceAnswer,
	choiceLocalResponse,
	choicePrompt,
	displayName,
	firstAnswer,
	NO_ANSWER,
	permissionAnswer,
	permissionLocalResponse,
	permissionPrompt,
} from "../dialogs.ts";

const bash = { kind: "permission" as const, toolName: "bash", toolCallId: "toolu_1", input: { command: "rm -rf build" }, reason: "3 consecutive actions were blocked." };
const offer = { kind: "choice" as const, question: "Clear the context first?", header: "auto-compact", options: ["Clear the context first", "Send as is"] };
const success = (response: unknown) => ({ subtype: "success", request_id: "r", response });

test("a tool approval is Claude Code's permission prompt, in Claude Code's names", () => {
	const { request, details } = permissionPrompt(bash, "r1");
	assert.deepEqual(request, {
		subtype: "can_use_tool",
		tool_name: "Bash",
		display_name: "Bash",
		input: { command: "rm -rf build" },
		tool_use_id: "toolu_1",
		description: "rm -rf build\n3 consecutive actions were blocked.",
		decision_reason: "3 consecutive actions were blocked.",
		decision_reason_type: "classifier",
	});
	assert.deepEqual(details, {
		tool_name: "Bash",
		display_tool_name: "Bash",
		action_description: "rm -rf build",
		raw_command: "rm -rf build",
		tool_use_id: "toolu_1",
		request_id: "r1",
		input: { command: "rm -rf build" },
	});
	const edit = permissionPrompt({ ...bash, toolName: "write", input: { path: "a.txt", content: "x" }, reasonCode: "classifier_transcript_too_long" }, "r2");
	assert.equal(edit.request.tool_name, "Write");
	assert.equal(edit.request.description, "a.txt\n3 consecutive actions were blocked.");
	assert.equal(edit.request.decision_reason_code, "classifier_transcript_too_long");
	assert.equal(edit.details.raw_command, undefined);
});

test("the apps' allow and deny become auto mode's answer", () => {
	const sent = { command: "rm -rf build" };
	assert.deepEqual(permissionAnswer(success({ behavior: "allow", updatedInput: { command: "rm -rf build" } }), sent), { allow: true });
	assert.deepEqual(permissionAnswer(success({ behavior: "allow", updatedInput: {} }), sent), { allow: true });
	assert.deepEqual(permissionAnswer(success({ behavior: "allow" }), sent), { allow: true });
	// Pi can't run an edited call: it is refused, with the reason.
	const edited = permissionAnswer(success({ behavior: "allow", updatedInput: { command: "rm -rf dist" } }), sent);
	assert.equal(edited !== NO_ANSWER && edited.allow, false);
	assert.match(edited !== NO_ANSWER ? edited.message! : "", /edited/);
	assert.deepEqual(permissionAnswer(success({ behavior: "deny", message: "User denied permission" }), sent), { allow: false });
	assert.deepEqual(permissionAnswer(success({ behavior: "deny", message: "use the trash instead" }), sent), { allow: false, message: "use the trash instead" });
	assert.equal(permissionAnswer({ subtype: "error", request_id: "r", error: "x" }, sent), NO_ANSWER);
});

test("an approval answered in Pi is sent to the apps as Claude Code sends it", () => {
	const sent = { command: "ls" };
	assert.deepEqual(permissionLocalResponse(true, sent, false), { behavior: "allow", updatedInput: sent, updatedPermissions: [] });
	assert.deepEqual(permissionLocalResponse(false, sent, false), { behavior: "deny", message: "User denied permission" });
	assert.deepEqual(permissionLocalResponse(undefined, sent, true), { behavior: "deny", message: "User aborted" });
});

test("a choice is an AskUserQuestion sheet with the options as given", () => {
	const { request, details } = choicePrompt(offer, "r1", "tu1");
	const input = { questions: [{ question: offer.question, header: "auto-compact", multiSelect: false, options: offer.options.map((label) => ({ label, description: "" })) }] };
	assert.deepEqual(request, {
		subtype: "can_use_tool",
		tool_name: "AskUserQuestion",
		display_name: "AskUserQuestion",
		input,
		tool_use_id: "tu1",
		description: offer.question,
		requires_user_interaction: true,
	});
	assert.deepEqual(details, {
		tool_name: "AskUserQuestion",
		display_tool_name: "Question",
		action_description: "auto-compact",
		tool_use_id: "tu1",
		request_id: "",
		suppressed_request_id: "r1",
		input,
	});
	assert.equal((choicePrompt({ ...offer, header: "a much longer header" }, "r", "t").request.input as any).questions[0].header, "a much longe");
	assert.equal(canAsk(offer), true);
	assert.equal(canAsk({ ...offer, options: ["a", "b", "c", "d", "e"] }), false);
	assert.equal(canAsk({ ...offer, options: ["a"] }), false);
});

test("the apps' answer to a choice is one of its options, or a dismissal", () => {
	const answered = (answer: unknown) => success({ behavior: "allow", updatedInput: { answers: { [offer.question]: answer } } });
	assert.equal(choiceAnswer(answered("Send as is"), offer), "Send as is");
	assert.equal(choiceAnswer(answered(" send AS is "), offer), "Send as is");
	assert.equal(choiceAnswer(answered("something typed"), offer), undefined);
	assert.equal(choiceAnswer(success({ behavior: "allow", updatedInput: { answers: {} } }), offer), undefined);
	assert.equal(choiceAnswer(success({ behavior: "deny", message: "no" }), offer), undefined);
	assert.equal(choiceAnswer({ subtype: "error" }, offer), NO_ANSWER);
	assert.deepEqual(choiceLocalResponse(undefined, offer), { behavior: "deny", message: "User aborted" });
	assert.deepEqual((choiceLocalResponse("Send as is", offer) as any).updatedInput.answers, { [offer.question]: "Send as is" });
});

test("Claude Code's display names", () => {
	assert.equal(displayName("Bash"), "Bash");
	assert.equal(displayName("mcp__github__create_issue"), "Create Issue");
});

// A terminal dialog that resolves with `answer` when called, or with undefined once dismissed.
function terminal<R>(answer?: Promise<R>) {
	const seen = { dismissed: false };
	const local = (signal: AbortSignal) =>
		new Promise<R | undefined>((resolve) => {
			signal.addEventListener("abort", () => {
				seen.dismissed = true;
				resolve(undefined);
			});
			answer?.then(resolve);
		});
	return { local, seen };
}

test("the apps answering first dismiss the terminal dialog, and nothing is withdrawn", async () => {
	const { local, seen } = terminal<string>();
	const withdrawn: unknown[] = [];
	const result = await firstAnswer(local, Promise.resolve("Send as is"), (r) => withdrawn.push(r));
	assert.equal(result, "Send as is");
	assert.equal(seen.dismissed, true);
	assert.deepEqual(withdrawn, []);
});

test("the terminal answering first withdraws the sheet with that answer", async () => {
	const { local, seen } = terminal(Promise.resolve("Clear the context first"));
	const withdrawn: unknown[] = [];
	const result = await firstAnswer(local, new Promise<string>(() => {}), (r, aborted) => withdrawn.push([r, aborted]));
	assert.equal(result, "Clear the context first");
	assert.equal(seen.dismissed, false);
	assert.deepEqual(withdrawn, [["Clear the context first", false]]);
});

test("a stopped turn dismisses the terminal dialog and withdraws the sheet as aborted", async () => {
	const { local } = terminal<boolean>();
	const stop = new AbortController();
	const withdrawn: unknown[] = [];
	const pending = firstAnswer(local, new Promise<boolean>(() => {}), (r, aborted) => withdrawn.push([r, aborted]), stop.signal);
	stop.abort();
	assert.equal(await pending, undefined);
	assert.deepEqual(withdrawn, [[undefined, true]]);
});

test("no usable answer from the apps leaves the terminal to decide", async () => {
	let answer!: (v: string) => void;
	const { local, seen } = terminal(new Promise<string>((r) => (answer = r)));
	const withdrawn: unknown[] = [];
	const pending = firstAnswer(local, Promise.resolve(NO_ANSWER), (r) => withdrawn.push(r));
	await new Promise((r) => setTimeout(r, 10));
	assert.equal(seen.dismissed, false);
	answer("Send as is");
	assert.equal(await pending, "Send as is");
	assert.deepEqual(withdrawn, ["Send as is"]);
});
