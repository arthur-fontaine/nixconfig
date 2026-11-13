// Browser use for Pi through Claude in Chrome, as Claude Code does it: Claude
// Code's 20 browser tools, run by the extension in the person's browser through
// Anthropic's Claude in Chrome bridge. While Pi uses the browser, the tab plays
// as a video in a picture-in-picture view at the top right; the chat keeps text
// rows. See README.md.
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { convertToPng, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getCapabilities, getCellDimensions, getImageDimensions, renderImage, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { loadCredentials } from "../remote-control/api.ts";
import { BridgeWsClient, claudeAccountUuid, type Extension } from "./bridge.ts";
import { callBrowserTool, type PiContent, type TabInfo, ToolError, tabsIn, toPiContent } from "./calls.ts";
import { BrowserNotConnectedError, DisconnectedMidCallError, ToolTimeoutError } from "./client.ts";
import { allocateKittyId, kittyDelete } from "../image-view/kitty.ts";
import { compositeOverImages, OverlayState, VideoOverlay } from "./overlay.ts";
import { type CallPermissions, callPermissions, hostOf } from "./permissions.ts";
import { claudeToolName, piToolDefinitions, SERVER } from "./tools.ts";
import { type Frame, FrameScheduler } from "./video.ts";
import type { BrowserTransport } from "./bridge.ts";

// Tools that act on one tab's page: while one runs, the video plays.
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
	"scroll",
]);
// Checked free in Pi's keybindings, the other extensions' (background-tools has
// ctrl+b) and Herdr's keys.
export const VIDEO_KEY = "ctrl+alt+b";
const LINGER_MS = 4000;
// The extension runs screenshots concurrently; three in flight gave ~6 fps here.
const IN_FLIGHT = 3;
const MIN_GAP_MS = 110;

type Client = BrowserTransport & { listExtensions(): Promise<Extension[]>; select(deviceId: string): void };

const GUIDANCE = `You have Claude in Chrome's browser tools (mcp__claude-in-chrome__*), which act in the person's own browser. They are deferred: load the ones a task needs with a single tool_search call (e.g. "claude-in-chrome tabs_context_mcp navigate computer read_page tabs_create_mcp tabs_close_mcp browser_batch"), not one at a time.
- Start with tabs_context_mcp to learn this session's tabs. Work in a tab of your own (tabs_create_mcp, or navigate without a tabId); reuse one of the person's tabs only when they ask. Close the tabs you opened with tabs_close_mcp when done, unless asked to keep them.
- If a tool says a tab doesn't exist, call tabs_context_mcp again for fresh ids; never reuse ids from another session.
- Batch steps you can predict with browser_batch. Take a screenshot before clicking by coordinates.
- Don't trigger alert/confirm/prompt dialogs: they block the extension. If one blocks it, tell the person to dismiss it.
- Use read_console_messages with a pattern to filter console output.
- If browser calls keep failing (2–3 tries), the extension doesn't answer, or the page doesn't respond, stop and ask the person how to go on.`;

export default function browser(pi: ExtensionAPI, deps: { client?: Client } = {}) {
	let client: Client | undefined = deps.client;
	let sessionId: string | undefined;
	let tabGroupId: number | undefined;
	// Claude Code's login, read-only through remote-control's loader (keychain item
	// "Claude Code-credentials", else ~/.claude/.credentials.json); never logged or kept.
	const getClient = (): Client =>
		(client ??= new BridgeWsClient({
			credentials: async () => {
				const [{ accessToken }, accountUuid] = await Promise.all([loadCredentials(), claudeAccountUuid()]);
				return { accessToken, accountUuid };
			},
		}));

	const isKitty = () => getCapabilities().images === "kitty" && pi.getSettings().terminal?.showImages !== false;

	// The calls' scope: this session's own tab group, as each Claude Code session has.
	const callOptions = () => ({
		sessionScope: { sessionId: sessionId ?? "pi", ...(tabGroupId !== undefined && { tabGroupId }) },
		// A prompt the extension still raises is for a call Pi's auto-mode let through:
		// answered "allow", as Claude Code answers it through its own permission flow.
		onPermissionRequest: () => true,
	});
	// Hosts this session's calls were let through on (Claude Code's allowed_domains).
	const allowedHosts = new Set<string>();
	const classifierAllowed = (toolCallId: string): boolean => {
		const check = (globalThis as Record<symbol, unknown>)[Symbol.for("pi-auto-mode.classifier-allowed")];
		return typeof check === "function" && (check as (id: string) => boolean)(toolCallId) === true;
	};

	// --- the video ---
	const state = new OverlayState(LINGER_MS);
	let video: Video | undefined;
	// The tab the video shows: the one the last call acted on, once the extension has
	// listed it among this session's tabs. Never another tab.
	let tabId: number | undefined;
	const ownTabs = new Map<number, TabInfo>();
	// The screenshots carry the permissions of the call they watch.
	let lastPermissions: CallPermissions | undefined;

	type Video = {
		tui: TUI;
		overlay: VideoOverlay;
		scheduler: FrameScheduler;
		close: () => void;
		setHidden: (hidden: boolean) => void;
		imageId: number;
		timer?: ReturnType<typeof setTimeout>;
		frame?: Frame;
		/** Since the capture last started: for PI_BROWSER_VIDEO_STATS. */
		run?: { since: number; requests: number; frames: number; skipped: number; stale: number; pngBytes: number };
	};

	// PI_BROWSER_VIDEO_STATS=<file>: one JSON line per stretch of capture (fps, skipped
	// frames, bytes of PNG sent to the terminal), to measure the video where it runs.
	const statsFile = process.env.PI_BROWSER_VIDEO_STATS;
	function noteRun(v: Video, running: boolean) {
		if (!statsFile) return;
		const s = v.scheduler;
		if (running && !v.run) v.run = { since: Date.now(), requests: s.requests, frames: s.frames, skipped: s.skipped, stale: s.stale, pngBytes: 0 };
		else if (!running && v.run) {
			const seconds = (Date.now() - v.run.since) / 1000;
			const frames = s.frames - v.run.frames;
			const line = { seconds, requests: s.requests - v.run.requests, frames, fps: +(frames / seconds).toFixed(2), skipped: s.skipped - v.run.skipped, stale: s.stale - v.run.stale, pngKBps: +(v.run.pngBytes / 1024 / seconds).toFixed(1) };
			appendFileSync(statsFile, `${JSON.stringify(line)}\n`);
			v.run = undefined;
		}
	}

	/** Shows, hides, starts and pauses what the state says, and sets the timer for its next change. */
	function update() {
		const v = video;
		if (!v) return;
		const now = Date.now();
		v.setHidden(state.mode(now) === "hidden");
		const capture = state.capturing(now) && tabId !== undefined && ownTabs.has(tabId);
		v.scheduler.setActive(capture);
		noteRun(v, capture);
		if (v.timer) clearTimeout(v.timer);
		v.timer = undefined;
		const next = state.nextChange(now);
		if (next !== undefined) v.timer = setTimeout(update, Math.max(0, next - now) + 5);
		v.tui.requestRender();
	}

	/** One screenshot of the tab, sized for the video, as a PNG frame; the same picture is not converted again. */
	function captureSource() {
		let fullWidth: number | undefined;
		let last: Frame | undefined;
		let lastHash: string | undefined;
		return async (signal: AbortSignal): Promise<Frame | null> => {
			const tab = tabId;
			if (tab === undefined || !ownTabs.has(tab) || !video) return null;
			const view = video.overlay.view();
			const target = view.mode === "full" ? view.layout.pixelWidth : 640;
			const scale = fullWidth ? Math.min(1, Math.max(0.1, target / fullWidth)) : 0.4;
			const rounded = Math.round(scale * 100) / 100;
			const response = await getClient().callTool("computer", { action: "screenshot", tabId: tab, scale: rounded }, { ...callOptions(), ...lastPermissions, timeoutMs: 10_000, signal });
			const image = toPiContent(response.result?.content).find((c): c is Extract<PiContent, { type: "image" }> => c.type === "image");
			if (!image) return null;
			const hash = createHash("sha1").update(image.data).digest("hex");
			if (hash === lastHash && last) return last;
			const png = image.mimeType === "image/png" ? image.data : (await convertToPng(image.data, image.mimeType))?.data;
			const dims = png ? getImageDimensions(png, "image/png") : null;
			if (!png || !dims) return null;
			fullWidth = Math.round(dims.widthPx / rounded);
			lastHash = hash;
			last = { png, width: dims.widthPx, height: dims.heightPx, key: hash };
			return last;
		};
	}

	function toggle(ctx?: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } }) {
		if (!video) return;
		if (tabId === undefined) {
			ctx?.ui.notify("The browser video shows once Pi uses the browser.", "info");
			return;
		}
		state.toggle(Date.now());
		update();
	}

	function openVideo(ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1] & { ui: any }) {
		if (video || ctx.mode !== "tui" || !isKitty()) return;
		const imageId = allocateKittyId();
		let handle: { setHidden(hidden: boolean): void; unfocus(o?: { target: null }): void } | undefined;
		let close: () => void = () => {};
		void ctx.ui.custom(
			(tui: TUI, theme: any, _keybindings: unknown, done: () => void) => {
				close = done;
				// Over a chat image row, the video's row is drawn rather than dropped (overlay.ts).
				const t = tui as unknown as { compositeLineAt?: (...a: [string, string, number, number, number]) => string };
				if (typeof t.compositeLineAt === "function") t.compositeLineAt = compositeOverImages(t.compositeLineAt.bind(tui));
				const overlay = new VideoOverlay({
					state,
					frame: () => video?.frame,
					tab: () => {
						const info = tabId !== undefined ? ownTabs.get(tabId) : undefined;
						return { host: hostOf(info?.url), title: info?.title };
					},
					terminal: () => ({ columns: tui.terminal.columns, rows: tui.terminal.rows }),
					cell: () => getCellDimensions(),
					theme: { fg: (c, s) => theme.fg(c, s), bg: (c, s) => theme.bg(c, s) },
					keyHint: VIDEO_KEY,
					imageId,
					renderImage: (png, dims, options) => renderImage(png, dims, options),
					visibleWidth,
					truncate: (s, w) => truncateToWidth(s, w, "…"),
					onToggle: () => toggle(),
				});
				const scheduler = new FrameScheduler({
					capture: captureSource(),
					onFrame: (frame) => {
						if (!video) return;
						video.frame = frame;
						if (video.run) video.run.pngBytes += frame.png.length;
						tui.requestRender();
					},
					maxInFlight: IN_FLIGHT,
					minGapMs: MIN_GAP_MS,
				});
				video = {
					tui,
					overlay,
					scheduler,
					imageId,
					close: () => close(),
					setHidden: (hidden) => handle?.setHidden(hidden),
				};
				return overlay;
			},
			{
				overlay: true,
				// Read on every render (Pi keeps this object): the width follows the video's layout.
				overlayOptions: {
					anchor: "top-right",
					margin: { top: 1, right: 2 },
					// Typing stays in the editor: the overlay never takes focus.
					nonCapturing: true,
					get width() {
						return video?.overlay.width() ?? 1;
					},
				},
				onHandle: (h: typeof handle) => {
					handle = h;
					h?.setHidden(true);
					h?.unfocus({ target: null });
				},
			},
		);
	}

	function closeVideo() {
		const v = video;
		if (!v) return;
		video = undefined;
		noteRun(v, false);
		v.scheduler.stop();
		if (v.timer) clearTimeout(v.timer);
		v.close();
		v.tui.terminal.write(kittyDelete(v.imageId));
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
			async execute(toolCallId, params, signal, _onUpdate, ctx) {
				const watched = VIEWED.has(tool) && ctx.hasUI;
				const onAbort = () => {
					state.abort();
					update();
				};
				if (watched) {
					state.callStarted(toolCallId, Date.now());
					signal?.addEventListener("abort", onAbort, { once: true });
					update();
				}
				let callTab: number | undefined;
				try {
					const content = await callBrowserTool(tool, (params ?? {}) as Record<string, unknown>, {
						client: getClient(),
						options: callOptions,
						signal,
						onTab: (id) => {
							callTab = id;
							if (!watched) return;
							tabId = id;
							if (!ownTabs.has(id)) void confirmOwnTab(id);
							update();
						},
						onTabGroup: (id) => {
							tabGroupId = id;
						},
						browsers: { list: () => getClient().listExtensions(), select: (id) => getClient().select(id) },
						permissionsFor: (host) => {
							const permissions = callPermissions({
								classifierAllowed: classifierAllowed(toolCallId),
								host,
								deniedHosts: [],
								allowedHosts: [...allowedHosts],
								onPermissionRequest: () => true,
							});
							if (host) allowedHosts.add(host);
							if (watched) lastPermissions = permissions;
							return permissions;
						},
					});
					for (const [id, info] of tabsIn(content)) ownTabs.set(id, info);
					if (tool === "tabs_close_mcp" && typeof (params as { tabId?: unknown })?.tabId === "number") ownTabs.delete((params as { tabId: number }).tabId);
					return { content, details: { tabId: callTab } };
				} catch (error) {
					throw asToolError(error);
				} finally {
					if (watched) {
						signal?.removeEventListener("abort", onAbort);
						state.callEnded(toolCallId, Date.now());
						update();
					}
				}
			},
		});
	}

	/** The video shows a tab only once the extension lists it among this session's own. */
	async function confirmOwnTab(id: number) {
		const { onPermissionRequest: _drop, ...scope } = callOptions();
		const response = await getClient()
			.callTool("tabs_context_mcp", {}, { ...scope, permissionMode: "ask", timeoutMs: 8_000 })
			.catch(() => undefined);
		if (!response?.result) return;
		for (const [tab, info] of tabsIn(toPiContent(response.result.content))) ownTabs.set(tab, info);
		if (ownTabs.has(id)) update();
	}

	pi.registerShortcut(VIDEO_KEY, {
		description: "Collapse or expand the browser video",
		handler: async (ctx) => toggle(ctx),
	});

	pi.on("session_start", (_event, ctx) => {
		sessionId = ctx.sessionManager.getSessionId();
		tabGroupId = undefined;
		tabId = undefined;
		ownTabs.clear();
		allowedHosts.clear();
		state.reset();
		closeVideo();
		openVideo(ctx as never);
	});

	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections[SERVER] = GUIDANCE;
	});

	pi.on("session_shutdown", async () => {
		closeVideo();
		state.reset();
		client?.close();
		client = deps.client;
	});
}

function asToolError(error: unknown): Error {
	if (error instanceof ToolError || error instanceof BrowserNotConnectedError) return error;
	if (error instanceof ToolTimeoutError)
		return new ToolError(`${error.message}. The page or the browser may be unresponsive, or waiting for the person. Try a lighter operation (e.g. get_page_text instead of a screenshot), or ask the person to check the browser.`);
	if (error instanceof DisconnectedMidCallError)
		return new ToolError(`${error.message}. The extension may have restarted; check the page's state (e.g. get_page_text) before repeating an action, then retry.`);
	return error instanceof Error ? error : new Error(String(error));
}
