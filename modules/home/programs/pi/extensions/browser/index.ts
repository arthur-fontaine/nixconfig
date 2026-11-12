// Browser use for Pi through Claude in Chrome, as Claude Code does it: Claude
// Code's 20 browser tools, run by the extension in the person's browser through
// Anthropic's Claude in Chrome bridge, with the tab's screen live in the tool's
// row. See README.md.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convertToPng, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, Container, getCapabilities, getCellDimensions, getImageDimensions, type TUI, Text } from "@earendil-works/pi-tui";
import { callBrowserTool, type PiContent, ToolError, toPiContent } from "./calls.ts";
import { loadCredentials } from "../remote-control/api.ts";
import { BridgeWsClient, claudeAccountUuid } from "./bridge.ts";
import { BrowserNotConnectedError, DisconnectedMidCallError, ToolTimeoutError } from "./client.ts";
import { type Frame, FramePump, LiveView } from "./liveview.ts";
import { claudeToolName, piToolDefinitions, SERVER } from "./tools.ts";

const WIDGET = "claude-in-chrome-tui";
const FRAMES_DIR = join(tmpdir(), "pi-browser-frames");
// Tools that act on one tab's page, whose row shows it.
const VIEWED = new Set([
	"navigate",
	"computer",
	"browser_batch",
	"find",
	"form_input",
	"read_page",
	"get_page_text",
	"javascript_tool",
	"resize_window",
	"upload_image",
	"file_upload",
]);
// The still is taken once the page has painted what the tool did.
const SETTLE_MS = 300;
// Kitty scales the frame to the row; this is enough pixels for any terminal width.
const MAX_FRAME_PX = 1280;

type FrameRef = { path: string; width: number; height: number };
type Details = { tabId?: number; frame?: FrameRef } | undefined;

type Live = { view: LiveView; pump?: FramePump; invalidate?: () => void; tabId?: number };

const GUIDANCE = `You have Claude in Chrome's browser tools (mcp__claude-in-chrome__*), which act in the person's own browser. They are deferred: load the ones a task needs with a single tool_search call (e.g. "claude-in-chrome tabs_context_mcp navigate computer read_page tabs_create_mcp tabs_close_mcp browser_batch"), not one at a time.
- Start with tabs_context_mcp to learn this session's tabs. Work in a tab of your own (tabs_create_mcp, or navigate without a tabId); reuse one of the person's tabs only when they ask. Close the tabs you opened with tabs_close_mcp when done, unless asked to keep them.
- If a tool says a tab doesn't exist, call tabs_context_mcp again for fresh ids; never reuse ids from another session.
- Batch steps you can predict with browser_batch. Take a screenshot before clicking by coordinates.
- Don't trigger alert/confirm/prompt dialogs: they block the extension. If one blocks it, tell the person to dismiss it.
- Use read_console_messages with a pattern to filter console output.
- If browser calls keep failing (2–3 tries), the extension doesn't answer, or the page doesn't respond, stop and ask the person how to go on.`;

export default function browser(pi: ExtensionAPI) {
	let client: BridgeWsClient | undefined;
	let sessionId: string | undefined;
	let tabGroupId: number | undefined;
	let tui: TUI | undefined;
	const lives = new Map<string, Live>();
	// Claude Code's login, read-only through remote-control's loader (keychain item
	// "Claude Code-credentials", else ~/.claude/.credentials.json); never logged or kept.
	const getClient = () =>
		(client ??= new BridgeWsClient({
			credentials: async () => {
				const [{ accessToken }, accountUuid] = await Promise.all([loadCredentials(), claudeAccountUuid()]);
				return { accessToken, accountUuid };
			},
		}));

	const isKitty = () => getCapabilities().images === "kitty" && pi.getSettings().terminal?.showImages !== false;
	const write = (sequence: string) => (tui ? tui.terminal.write(sequence) : process.stdout.write(sequence));

	function liveFor(toolCallId: string): Live {
		let live = lives.get(toolCallId);
		if (!live) {
			live = {
				view: new LiveView({
					kitty: isKitty,
					write,
					cell: () => getCellDimensions(),
					maxRows: () => Math.max(6, Math.floor((tui?.terminal.rows ?? 40) * 0.6)),
				}),
			};
			lives.set(toolCallId, live);
		}
		return live;
	}

	// The calls' scope: this session's own tab group, as each Claude Code session has.
	const callOptions = () => ({
		sessionScope: { sessionId: sessionId ?? "pi", ...(tabGroupId !== undefined && { tabGroupId }) },
		// Pi's auto-mode has already let this call through: the extension's site
		// prompt for it is answered the same way, as Claude Code answers it through
		// its own permission flow. No second permission system of ours.
		onPermissionRequest: () => true,
	});

	/** One screenshot of the tab, as a PNG frame sized for the terminal. */
	function frameSource(tabId: number) {
		let fullWidth: number | undefined;
		let last: Frame | undefined;
		return async (): Promise<Frame | null> => {
			const target = Math.min(MAX_FRAME_PX, (tui?.terminal.columns ?? 120) * getCellDimensions().widthPx);
			const scale = fullWidth ? Math.min(1, Math.max(0.1, target / fullWidth)) : 0.5;
			const response = await getClient().callTool("computer", { action: "screenshot", tabId, scale }, { ...callOptions(), timeoutMs: 15_000 });
			const image = toPiContent(response.result?.content).find((c): c is Extract<PiContent, { type: "image" }> => c.type === "image");
			if (!image) return null;
			const key = createHash("sha1").update(image.data).digest("hex");
			if (key === last?.key) return last;
			const png = image.mimeType === "image/png" ? image.data : (await convertToPng(image.data, image.mimeType))?.data;
			const dims = png ? getImageDimensions(png, "image/png") : null;
			if (!png || !dims) return null;
			fullWidth = Math.round(dims.widthPx / scale);
			last = { png, width: dims.widthPx, height: dims.heightPx, key };
			return last;
		};
	}

	function saveFrame(frame: Frame): FrameRef {
		mkdirSync(FRAMES_DIR, { recursive: true });
		const path = join(FRAMES_DIR, `${frame.key}.png`);
		if (!existsSync(path)) writeFileSync(path, Buffer.from(frame.png, "base64"));
		return { path, width: frame.width, height: frame.height };
	}

	for (const def of piToolDefinitions()) {
		const tool = claudeToolName(def.name)!;
		pi.registerTool({
			name: def.name,
			label: def.label,
			description: def.description,
			parameters: def.parameters as never,
			exposure: "deferred",
			namespace: { name: `mcp__${SERVER}`, aliases: [SERVER], description: "Claude in Chrome: act in the person's browser (open pages, read, click, type, screenshots, tabs)." },
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const live = VIEWED.has(tool) && ctx.hasUI && isKitty() ? liveFor(toolCallId) : undefined;
				let tabId: number | undefined;
				const update = () =>
					onUpdate?.({ content: [{ type: "text", text: `Browser: tab ${tabId ?? "?"}` }], details: { tabId } satisfies Details });
				const startView = (id: number) => {
					tabId = id;
					if (!live || live.pump) return;
					live.tabId = id;
					live.pump = new FramePump({
						capture: frameSource(id),
						onFrame: (frame) => {
							live.view.setFrame(frame);
							live.invalidate?.();
							update();
						},
					});
					live.pump.start();
				};
				try {
					const content = await callBrowserTool(tool, (params ?? {}) as Record<string, unknown>, {
						client: getClient(),
						options: callOptions,
						signal,
						onTab: startView,
						onTabGroup: (id) => {
							tabGroupId = id;
						},
						browsers: { list: () => getClient().listExtensions(), select: (id) => getClient().select(id) },
					});
					let frame: FrameRef | undefined;
					if (live?.pump) {
						await live.pump.stop();
						await new Promise((r) => setTimeout(r, SETTLE_MS));
						const still = await live.pump.captureOnce();
						if (still) {
							live.view.setFrame(still);
							frame = saveFrame(still);
						}
					}
					return { content, details: { tabId, frame } satisfies Details };
				} catch (error) {
					await live?.pump?.stop();
					throw asToolError(error);
				}
			},
		});
	}

	// The live view goes under the row, around whatever draws it (compact-tools'
	// Claude-style row), as image-view adds its tiles.
	pi.registerToolRenderer((toolName, next) => {
		const base = next();
		if (!claudeToolName(toolName)) return base;
		return {
			...base,
			renderResult(result, options, theme, context) {
				const inner = base?.renderResult?.(result, options, theme, context) ?? new Text(textOf(result.content), 0, 0);
				const details = result.details as Details;
				let live = lives.get(context.toolCallId);
				if (!live && details?.frame && isKitty() && existsSync(details.frame.path)) {
					// A resumed session: the still from the file.
					live = liveFor(context.toolCallId);
					const png = readFileSync(details.frame.path).toString("base64");
					live.view.setFrame({ png, width: details.frame.width, height: details.frame.height, key: details.frame.path });
				}
				if (!live || !context.showImages) return inner;
				live.invalidate = context.invalidate;
				live.view.setCaption(theme.fg("dim", `tab ${details?.tabId ?? live.tabId ?? "?"}`));
				const container = new Container();
				container.addChild(inner);
				const view = live.view;
				const component: Component = { render: (width) => view.render(width), invalidate: () => view.invalidate() };
				container.addChild(component);
				return container;
			},
		};
	});

	pi.on("session_start", (_event, ctx) => {
		sessionId = ctx.sessionManager.getSessionId();
		tabGroupId = undefined;
		if (ctx.mode !== "tui") return;
		// The TUI, for writing the frames' uploads; the widget itself draws nothing.
		ctx.ui.setWidget(
			WIDGET,
			(t) => {
				tui = t;
				return { render: () => [], invalidate: () => {} };
			},
			{ placement: "aboveEditor" },
		);
	});

	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections[SERVER] = GUIDANCE;
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		for (const live of lives.values()) {
			await live.pump?.stop();
			live.view.dispose();
		}
		lives.clear();
		client?.close();
		client = undefined;
		if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET, undefined);
	});
}

function textOf(content: { type: string; text?: string }[]): string {
	return content
		.filter((c) => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

function asToolError(error: unknown): Error {
	if (error instanceof ToolError || error instanceof BrowserNotConnectedError) return error;
	if (error instanceof ToolTimeoutError)
		return new ToolError(`${error.message}. The page or the browser may be unresponsive, or waiting for the person. Try a lighter operation (e.g. get_page_text instead of a screenshot), or ask the person to check the browser.`);
	if (error instanceof DisconnectedMidCallError)
		return new ToolError(`${error.message}. The extension may have restarted; check the page's state (e.g. get_page_text) before repeating an action, then retry.`);
	return error instanceof Error ? error : new Error(String(error));
}
