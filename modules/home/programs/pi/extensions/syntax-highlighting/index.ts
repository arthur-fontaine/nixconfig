// Syntax highlighting for Pi's bash tool: the command in its language (and the
// Python, SQL, JavaScript… it embeds), and its output's telling parts. It
// recolors whatever the bash renderers before it drew, so other extensions'
// additions to the row stay as they are, and every color is a theme token.
import { type ExtensionAPI, getLanguageFromPath, highlightCode, type Theme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth } from "@earendil-works/pi-tui";
import { escapes, FG_RESET, stripAnsi } from "./ansi.ts";
import { displayedCommand, fold, normalizeCommand, type Preview, readPreview } from "./command.ts";
import { highlightShell, type Paint } from "./highlight.ts";
import { type Document, overlay } from "./overlay.ts";
import { styleOutput } from "./output.ts";

type RenderCall = NonNullable<ToolRenderers["renderCall"]>;
type RenderResult = NonNullable<ToolRenderers["renderResult"]>;
type RenderContext = Parameters<RenderCall>[2];
type ToolResult = Parameters<RenderResult>[0];

const SHORTCUT = "ctrl+shift+o";
// Rows the shortcut redraws; older ones redraw on their next render.
const MAX_ROWS = 200;

// Extensions Pi doesn't map, as getLanguageFromPath leaves them out.
const EXTRA_LANGUAGES: Record<string, string> = { nix: "nix", mts: "typescript", cts: "typescript", jsonc: "json", json5: "json" };

function languageForPath(file: string): string | undefined {
	return getLanguageFromPath(file) ?? EXTRA_LANGUAGES[file.split(".").pop()?.toLowerCase() ?? ""];
}

// Languages highlight.js knows; Pi loads most of them after startup.
const known = new Set<string>();

function knows(language: string): boolean {
	if (known.has(language)) return true;
	// An unknown language gets highlightCode's fallback, the same as no language.
	const probe = highlightCode("x", language)[0];
	if (probe === highlightCode("x", "")[0]) return false;
	known.add(language);
	return true;
}

function paintFor(theme: Theme): Paint {
	return {
		fg: (token, text) => theme.fg(token, text),
		open: (token) => theme.getFgAnsi(token),
		bold: (text) => theme.bold(text),
		// highlightCode uses the active theme, the one `theme` stands for.
		code: (code, language) => (knows(language) ? highlightCode(code, language) : undefined),
		languageForPath,
	};
}

// Changes when the theme does, light to dark included.
const themeKey = (theme: Theme) => `${theme.name}\0${theme.getFgAnsi("syntaxString")}\0${theme.getFgAnsi("toolOutput")}`;

/** Another renderer's component, its lines recolored. Pi hands it back as `lastComponent`. */
class Recolored implements Component {
	readonly inner: Component;
	private readonly theme: Theme;
	private readonly recolor: (lines: string[], width: number) => string[];
	private cache?: { width: number; key: string; input: string[]; output: string[] };

	constructor(inner: Component, theme: Theme, recolor: (lines: string[], width: number) => string[]) {
		this.inner = inner;
		this.theme = theme;
		this.recolor = recolor;
	}

	render(width: number): string[] {
		const input = this.inner.render(width);
		const key = themeKey(this.theme);
		const cache = this.cache;
		if (cache && cache.width === width && cache.key === key && sameLines(cache.input, input)) return cache.output;
		let output: string[];
		try {
			output = this.recolor(input, width);
		} catch {
			output = input;
		}
		this.cache = { width, key, input: [...input], output };
		return output;
	}

	invalidate(): void {
		this.cache = undefined;
		this.inner.invalidate();
	}

	handleMouse(event: Parameters<NonNullable<Component["handleMouse"]>>[0]) {
		return this.inner.handleMouse?.(event);
	}

	handleInput(data: string): void {
		this.inner.handleInput?.(data);
	}
}

function sameLines(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((line, i) => line === b[i]);
}

// The inner renderer reuses its own previous component (Pi's bash renderer
// calls setText on it), never this wrapper.
function innerContext(context: RenderContext): RenderContext {
	const last = context.lastComponent;
	return { ...context, lastComponent: last instanceof Recolored ? last.inner : undefined };
}

// One-entry memo per row: renders repeat with the same input on every frame.
function memo<T>(compute: (key: string) => T): (key: string) => T {
	let last: { key: string; value: T } | undefined;
	return (key) => {
		if (last?.key !== key) last = { key, value: compute(key) };
		return last.value;
	};
}

// What Pi's bash renderer prints of a result, the same way: colors, carriage
// returns and other control characters removed, tabs expanded by its Text.
function outputText(result: ToolResult): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => stripAnsi(block.text ?? ""))
		.join("\n")
		.replace(/\r/g, "")
		.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
		.trim()
		.replace(/\t/g, "   ");
}

interface Settings {
	commandPreview: Preview;
	expandWhileWriting: boolean;
}

export default function (pi: ExtensionAPI) {
	// Settings can't be read while extensions load.
	let settings: Settings = { commandPreview: 2, expandWhileWriting: true };
	let showWholeCommands = false;
	const rows = new Map<string, () => void>();

	const remember = (context: RenderContext) => {
		rows.delete(context.toolCallId);
		rows.set(context.toolCallId, context.invalidate);
		if (rows.size > MAX_ROWS) rows.delete(rows.keys().next().value!);
	};

	const renderCall =
		(inner: RenderCall): RenderCall =>
		(args, theme, context) => {
			remember(context);
			const raw = (args as { command?: unknown } | undefined)?.command;
			if (typeof raw !== "string") return new Recolored(inner(args, theme, innerContext(context)), theme, (lines) => lines);
			const lines = displayedCommand(normalizeCommand(raw), context.cwd).split("\n");
			const writing = settings.expandWhileWriting && !context.argsComplete && !context.executionStarted && context.isPartial;
			const limit: Preview = writing || showWholeCommands ? "all" : context.expanded ? settings.commandPreview : 1;
			const { shown, hidden } = fold(lines, limit);
			const component = inner({ ...(args as object), command: shown.join("\n") }, theme, innerContext(context));
			const doc = memo((): Document => {
				const styled = highlightShell(paintFor(theme), lines.join("\n"));
				return { plain: shown, styled: styled.slice(0, shown.length) };
			});
			return new Recolored(component, theme, (drawn, width) => {
				const lead = { text: "$ ", styled: theme.fg("bashMode", theme.bold("$")) + " " };
				const out = overlay(drawn, doc(themeKey(theme)), { match: "run", lead });
				if (hidden > 0) {
					const hint = `… ${hidden} more command line${hidden === 1 ? "" : "s"} · ${SHORTCUT} shows all`;
					out.push(truncateToWidth(theme.fg("dim", hint), width));
				}
				return out;
			});
		};

	const renderResult =
		(inner: RenderResult): RenderResult =>
		(result, options, theme, context) => {
			const component = inner(result, options, theme, innerContext(context));
			const text = outputText(result);
			const doc = memo((): Document => {
				const plain = text.split("\n");
				return { plain, styled: styleOutput(paintFor(theme), plain) };
			});
			// Only lines drawn in the plain output color are output; hints,
			// warnings and other extensions' lines have their own colors.
			const plainOutput = (line: string) => {
				// A faint toolOutput opens with SGR 2 too and closes with 22.
				const own = new Set([...escapes(theme.fg("toolOutput", "x")), FG_RESET]);
				const codes = escapes(line);
				return codes.includes(theme.getFgAnsi("toolOutput")) && codes.every((code) => own.has(code));
			};
			return new Recolored(component, theme, (drawn) => (text ? overlay(drawn, doc(themeKey(theme)), { match: "line", accept: plainOutput }) : drawn));
		};

	pi.registerToolRenderer((toolName, next) => {
		const renderers = next();
		if (toolName !== "bash" || !renderers) return renderers;
		return {
			...renderers,
			...(renderers.renderCall && { renderCall: renderCall(renderers.renderCall) }),
			...(renderers.renderResult && { renderResult: renderResult(renderers.renderResult) }),
		};
	});

	pi.on("session_start", async () => {
		const own = (pi.getSettings() as { syntaxHighlighting?: Record<string, unknown> }).syntaxHighlighting ?? {};
		settings = {
			commandPreview: readPreview(own.commandPreview, 2),
			expandWhileWriting: own.expandWhileWriting !== false,
		};
	});

	pi.registerShortcut(SHORTCUT, {
		description: "Show or fold multi-line bash commands",
		handler: () => {
			showWholeCommands = !showWholeCommands;
			// Redrawing a row renders it again, which moves it to the end of `rows`.
			for (const invalidate of [...rows.values()]) invalidate();
		},
	});

	pi.registerCommand("syntax-highlighting-status", {
		description: "Show what the bash syntax highlighting can color",
		handler: async (_args, ctx) => {
			const languages = ["javascript", "typescript", "python", "perl", "ruby", "php", "lua", "sql", "awk", "json", "yaml", "applescript"];
			const missing = languages.filter((language) => !knows(language));
			const lines = [
				`Bash commands: colored with theme "${ctx.ui.theme.name ?? "custom"}".`,
				missing.length
					? `Embedded code: ${languages.filter((l) => !missing.includes(l)).join(", ")}; not loaded yet: ${missing.join(", ")}.`
					: `Embedded code: ${languages.join(", ")}.`,
				`Commands fold to 1 line, ${settings.commandPreview} expanded; ${SHORTCUT} shows them whole (${showWholeCommands ? "on" : "off"}).`,
			];
			ctx.ui.notify(lines.join("\n"), missing.length ? "warning" : "info");
		},
	});
}
