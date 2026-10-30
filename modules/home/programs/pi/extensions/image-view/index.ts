// Image View for Pi: thumbnails of the images in a draft, under each sent
// prompt and under tool results, that open in Quick Look when clicked. A port
// of the Claude Code mod in modules/home/programs/claude/mods/image-view.
import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, getCapabilities, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { imageNumbers, type Size } from "./layout.ts";
import { blockSize, HalfBlocks, imageSize, KittyPictures, saveImage } from "./pictures.ts";
import { imagePathFromUrl, QuickLook } from "./quicklook.ts";
import { draftPath, findDraftEditor, messageSources, type Source, toolSources } from "./sources.ts";
import { Hover, type Tile, TileRow } from "./tiles.ts";
import { hookTui, type TuiHooks } from "./tui-hooks.ts";

// Pasting an image raises no editor event pi-image-view's marker shows up on,
// so the draft is polled instead.
const POLL_MS = 200;
const WIDGET = "image-view-tiles";
const ENTRY = "image-view";
// Transcript tiles: up to 6 picture rows plus border and label.
const TRANSCRIPT_MAX_ROWS = 9;

type EntryData = { images: Tile[] };

export default function imageView(pi: ExtensionAPI) {
	// jiti runs the extension as CommonJS, so this is the directory it was loaded from.
	const quickLook = new QuickLook(__dirname);
	let tui: TUI | undefined;
	let painter: HalfBlocks | KittyPictures | undefined;
	let poll: ReturnType<typeof setInterval> | undefined;

	let band: TileRow | undefined;
	let shownKey: string | undefined;
	let isChecking = false;
	let draftEditor: ReturnType<typeof findDraftEditor>;
	const sizes = new Map<string, Size | null>();

	const requestRender = () => tui?.requestRender();
	const hover = new Hover(requestRender);
	// In fullscreen mode Pi opens a clicked OSC 8 link itself, with `open`, so
	// pi-image-view's `[Image #n]` links would open in Preview: images go to
	// Quick Look instead, like the tiles. The input hook is how a hover clears.
	const tuiHooks: TuiHooks = {
		openUrl: (url) => {
			const path = imagePathFromUrl(url);
			if (path) quickLook.open(path);
			return path !== undefined;
		},
		input: (data, next) => hover.input(data, next),
	};
	// Re-applied on every render, since switching modes replaces Pi's renderer.
	const hookRenderer = () => tui && hookTui(tui, tuiHooks);
	// Pi draws a tool result's images itself where the terminal has a graphics
	// protocol, and pi-image-view draws the draft's in Kitty-protocol terminals.
	const piDrawsImages = () => !!getCapabilities().images;
	const isKitty = () => getCapabilities().images === "kitty";
	const showImages = () => pi.getSettings().terminal?.showImages !== false;
	// In fullscreen mode Pi routes clicks to components, so links only go on in
	// regular mode, where the terminal gets the clicks.
	const links = () => (tui?.mode ?? pi.getSettings().tuiMode ?? "fullscreen") === "regular";

	function getPainter() {
		painter ??= isKitty()
			? new KittyPictures(
					requestRender,
					(sequence) => (tui ? tui.terminal.write(sequence) : process.stdout.write(sequence)),
					() => `${tui?.terminal.columns}x${tui?.terminal.rows}`,
				)
			: new HalfBlocks(requestRender);
		return painter;
	}

	function tileRow(tiles: Tile[], theme: Theme, options: { indent?: number; maxRows: number; labelsOnly?: boolean }) {
		const pictures = getPainter();
		return new TileRow(tiles, {
			paint: options.labelsOnly ? null : pictures.paint,
			open: (path) => quickLook.open(path),
			maxRows: options.maxRows,
			indent: options.indent,
			links,
			dim: (text) => theme.fg("dim", text),
			// Claude Code's plain Button when hovered: inverse and no longer dim.
			hover: { state: hover, label: (text) => theme.inverse(text), border: (text) => theme.fg("borderAccent", text) },
			truncate: (text, width) => truncateToWidth(text, width, "…"),
			invalidate: () => pictures.invalidate(),
		});
	}

	function sourceTile(source: Source, size: Size | null): Tile {
		const path = "path" in source ? source.path : saveImage(source.image);
		return { id: source.id, label: source.label, alt: source.alt, path, size };
	}

	async function fileSize(path: string): Promise<Size | null> {
		if (!sizes.has(path)) sizes.set(path, await imageSize(path));
		return sizes.get(path) ?? null;
	}

	// The draft band, above the editor. Only where pi-image-view (which owns the
	// `[Image #n]` markers) shows no gallery of its own.
	async function showDraft(ctx: ExtensionContext, theme: Theme) {
		const numbers = showImages() ? imageNumbers(ctx.ui.getEditorText()) : [];
		const key = numbers.join(",");
		if (key === shownKey) return;
		if (numbers.length > 0 && !draftEditor) draftEditor = findDraftEditor(tui);
		const tiles: Tile[] = [];
		for (const n of numbers) {
			const found = draftPath(draftEditor, n);
			const path = found && existsSync(found) ? found : null;
			tiles.push({ id: String(n), label: `#${n}`, alt: `[Image #${n}]`, path, size: path ? await fileSize(path) : null });
		}
		// Retried until every marker has its file: pi-image-view stores it a moment after the paste.
		shownKey = tiles.every((tile) => tile.path !== null) ? key : undefined;
		if (shownKey === undefined) draftEditor = undefined;
		const maxRows = Math.min(TRANSCRIPT_MAX_ROWS, Math.max(4, Math.floor((tui?.terminal.rows ?? 24) / 3)));
		band = tiles.length > 0 ? tileRow(tiles, theme, { maxRows }) : undefined;
		requestRender();
	}

	const bandComponent: Component = {
		render: (width) => {
			hookRenderer();
			return band?.render(width) ?? [];
		},
		handleMouse: (event) => band?.handleMouse(event),
		invalidate: () => band?.invalidate(),
	};

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		// Also how the extension gets the TUI (for renders and the editor) when no draft shows.
		ctx.ui.setWidget(
			WIDGET,
			(t) => {
				tui = t;
				hookRenderer();
				return bandComponent;
			},
			{ placement: "aboveEditor" },
		);
		if (isKitty()) return;
		poll = setInterval(() => {
			if (isChecking) return;
			isChecking = true;
			showDraft(ctx, ctx.ui.theme)
				.catch(() => {})
				.finally(() => {
					isChecking = false;
				});
		}, POLL_MS);
		poll.unref();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		clearInterval(poll);
		poll = undefined;
		if (tui) hookTui(tui, undefined);
		hover.clear();
		painter?.dispose();
		painter = undefined;
		band = undefined;
		shownKey = undefined;
		draftEditor = undefined;
		if (ctx.mode === "tui") ctx.ui.setWidget(WIDGET, undefined);
	});

	// A sent prompt's tiles go in an entry of their own right after it: Pi's user
	// message is plain Markdown with no room for pictures, and an entry stays
	// out of the model's context but comes back on resume.
	pi.on("message_end", async (event, ctx) => {
		if (ctx.mode !== "tui" || event.message.role !== "user") return;
		const sources = messageSources(event.message.content);
		if (sources.length === 0) return;
		const images: Tile[] = [];
		for (const source of sources) {
			images.push(sourceTile(source, "image" in source ? blockSize(source.image) : await fileSize(source.path)));
		}
		pending = { images };
	});

	// Extensions see message_end before Pi saves the message, and Pi handles the
	// agent's events one at a time, so the next event is the first moment the
	// entry lands right after the message (and before the reply).
	let pending: EntryData | undefined;
	const appendPending = () => {
		if (pending) pi.appendEntry<EntryData>(ENTRY, pending);
		pending = undefined;
	};
	pi.on("message_start", appendPending);
	pi.on("agent_end", appendPending);

	pi.registerEntryRenderer<EntryData>(ENTRY, (entry, _options, theme) => {
		const images = entry.data?.images;
		if (!images?.length || !showImages()) return undefined;
		const tiles = images.map((image) => ({ ...image, path: image.path && existsSync(image.path) ? image.path : null }));
		return tileRow(tiles, theme, { indent: 1, maxRows: TRANSCRIPT_MAX_ROWS });
	});

	// And under a tool result that carries images: a `read` of an image, an MCP
	// screenshot. Where Pi draws the pictures itself, only the labels are added.
	const baseComponents = new WeakMap<Component, Component>();
	pi.registerToolRenderer((toolName, next) => {
		const base = next();
		if (!base?.renderResult) return base;
		const renderResult = base.renderResult;
		return {
			...base,
			renderResult(result, options, theme, context) {
				const lastComponent = context.lastComponent && (baseComponents.get(context.lastComponent) ?? context.lastComponent);
				const component = renderResult(result, options, theme, { ...context, lastComponent });
				if (options.isPartial || context.isError || !context.showImages) return component;
				const sources = toolSources(toolName, context.args, result.content, context.cwd);
				if (sources.length === 0) return component;
				const blocks = result.content.filter((block) => block.type === "image");
				const tiles = sources.map((source, i) => {
					const block = "image" in source ? source.image : blocks[i];
					return sourceTile(source, block ? blockSize(block) : null);
				});
				const container = new Container();
				container.addChild(component);
				container.addChild(tileRow(tiles, theme, { maxRows: TRANSCRIPT_MAX_ROWS, labelsOnly: piDrawsImages() }));
				baseComponents.set(container, component);
				return container;
			},
		};
	});
}
