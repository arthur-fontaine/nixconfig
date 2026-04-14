import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { AssistantMessageComponent, InteractiveMode, UserMessageComponent } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";

const TIMESTAMP_GAP = 2;
const TIMESTAMP_STYLE_PREFIX = "\x1b[2m\x1b[90m";
const TIMESTAMP_STYLE_SUFFIX = "\x1b[39m\x1b[22m";

type PatchedFunction<T extends Function> = T & {
	__piTimestampOriginal?: T;
};

function getBaseFunction<T extends Function>(fn: T): T {
	return (fn as PatchedFunction<T>).__piTimestampOriginal ?? fn;
}

function formatTimestamp(timestamp: unknown): string | undefined {
	if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return undefined;

	const date = new Date(timestamp);
	if (Number.isNaN(date.getTime())) return undefined;

	const hh = String(date.getHours()).padStart(2, "0");
	const mm = String(date.getMinutes()).padStart(2, "0");
	const ss = String(date.getSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

function splitTrailingOscSequences(line: string): { body: string; suffix: string } {
	const match = line.match(/((?:\x1b\][^\x07]*\x07)+)$/u);
	if (!match) return { body: line, suffix: "" };
	return {
		body: line.slice(0, -match[1].length),
		suffix: match[1],
	};
}

function addRightSideTimestamp(lines: string[], width: number, timestamp: string): string[] {
	const visibleIndices = lines
		.map((line, index) => ({ index, width: visibleWidth(line) }))
		.filter((entry) => entry.width > 0)
		.map((entry) => entry.index);
	if (visibleIndices.length === 0) return lines;

	const targetIndex = visibleIndices[Math.floor(visibleIndices.length / 2)]!;
	const styledTimestamp = `${TIMESTAMP_STYLE_PREFIX}${timestamp}${TIMESTAMP_STYLE_SUFFIX}`;
	const timestampWidth = visibleWidth(timestamp);

	return lines.map((line, index) => {
		if (index !== targetIndex) return line;

		const { body, suffix } = splitTrailingOscSequences(line);
		const paddingWidth = Math.max(1, width - timestampWidth - visibleWidth(body));
		return `${body}${" ".repeat(paddingWidth)}${styledTimestamp}${suffix}`;
	});
}

function installPatches() {
	const addMessageToChatBase = getBaseFunction(InteractiveMode.prototype.addMessageToChat);
	const userRenderBase = getBaseFunction(UserMessageComponent.prototype.render);
	const assistantRenderBase = getBaseFunction(AssistantMessageComponent.prototype.render);

	const patchedAddMessageToChat = function (this: any, message: any, options?: any) {
		if (message?.role !== "user") {
			return addMessageToChatBase.call(this, message, options);
		}

		const childCountBefore = Array.isArray(this.chatContainer?.children) ? this.chatContainer.children.length : 0;
		const result = addMessageToChatBase.call(this, message, options);

		const newChildren = this.chatContainer?.children?.slice(childCountBefore) ?? [];
		for (const child of newChildren) {
			if (child instanceof UserMessageComponent) {
				child.__piMessageTimestamp = message.timestamp;
			}
		}

		return result;
	};
	(patchedAddMessageToChat as PatchedFunction<typeof patchedAddMessageToChat>).__piTimestampOriginal = addMessageToChatBase;
	InteractiveMode.prototype.addMessageToChat = patchedAddMessageToChat;

	const patchedUserRender = function (this: any, width: number): string[] {
		const timestamp = formatTimestamp(this.__piMessageTimestamp);
		if (!timestamp) return userRenderBase.call(this, width);

		const reservedWidth = visibleWidth(timestamp) + TIMESTAMP_GAP;
		if (width <= reservedWidth + 10) return userRenderBase.call(this, width);

		const lines = userRenderBase.call(this, width - reservedWidth);
		return addRightSideTimestamp(lines, width, timestamp);
	};
	(patchedUserRender as PatchedFunction<typeof patchedUserRender>).__piTimestampOriginal = userRenderBase;
	UserMessageComponent.prototype.render = patchedUserRender;

	const patchedAssistantRender = function (this: any, width: number): string[] {
		const timestamp = formatTimestamp(this.lastMessage?.timestamp);
		if (!timestamp) return assistantRenderBase.call(this, width);

		const reservedWidth = visibleWidth(timestamp) + TIMESTAMP_GAP;
		if (width <= reservedWidth + 10) return assistantRenderBase.call(this, width);

		const lines = assistantRenderBase.call(this, width - reservedWidth);
		return addRightSideTimestamp(lines, width, timestamp);
	};
	(patchedAssistantRender as PatchedFunction<typeof patchedAssistantRender>).__piTimestampOriginal = assistantRenderBase;
	AssistantMessageComponent.prototype.render = patchedAssistantRender;
}

export default function (_pi: ExtensionAPI) {
	installPatches();
}
