// Draws a detached call's row through bash's own renderer (and whatever other
// extensions chained onto it), fed with the live or final result instead of
// the placeholder, plus one line saying it ran in the background.
import type { ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import { type Component, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { withMarker } from "./marker.ts";
import { type Ending, placeholderStart, type Result } from "./records.ts";

export interface View {
	running: boolean;
	ending?: Ending;
	result?: Result;
	elapsedMs: number;
}

type Theme = Parameters<NonNullable<NonNullable<ReturnType<ToolRendererResolver>>["renderResult"]>>[2];

function marker(toolCallId: string, view: View | undefined, theme: Theme): string {
	// A row from a branch or session this extension hasn't loaded: its outcome is unknown here.
	if (!view) return theme.fg("dim", "◌ detached to the background");
	if (view.running) return theme.fg("warning", "◌ running in the background") + theme.fg("dim", ` · ${toolCallId}`);
	switch (view.ending ?? "completed") {
		case "completed":
			return theme.fg("success", "✓ finished in the background");
		case "failed":
			return theme.fg("error", "✗ failed in the background");
		case "stopped":
			return theme.fg("error", "■ stopped in the background");
		case "interrupted":
			return theme.fg("error", "✗ interrupted in the background, not resumed");
	}
}

// The row as drawn, then its marker.
class Marked implements Component {
	readonly inner: Component;
	private readonly marker: string;

	constructor(inner: Component, marker: string) {
		this.inner = inner;
		this.marker = marker;
	}

	render(width: number): string[] {
		return withMarker(this.inner.render(width), this.marker, width, (text, w) => wrapTextWithAnsi(text, w));
	}

	invalidate(): void {
		this.inner.invalidate();
	}

	handleMouse(event: Parameters<NonNullable<Component["handleMouse"]>>[0]) {
		return this.inner.handleMouse?.(event);
	}

	handleInput(data: string): void {
		this.inner.handleInput?.(data);
	}
}

export function detachedRenderer(
	toolName: string,
	lookup: (toolCallId: string) => View | undefined,
	watch: (toolCallId: string, repaint: () => void) => void,
): ToolRendererResolver {
	return (name, next) => {
		const base = next();
		if (name !== toolName || !base?.renderResult) return base;
		const renderResult = base.renderResult;
		return {
			...base,
			renderResult(result, options, theme, context) {
				const lastComponent = context.lastComponent instanceof Marked ? context.lastComponent.inner : context.lastComponent;
				if (placeholderStart(result.details) === undefined) return renderResult(result, options, theme, { ...context, lastComponent });
				const view = lookup(context.toolCallId);
				const running = view?.running ?? false;
				if (running) watch(context.toolCallId, context.invalidate);
				const shown = view?.result ?? (running ? { content: [], details: undefined } : result);
				const component = renderResult(shown, { ...options, isPartial: running }, theme, {
					...context,
					lastComponent,
					isPartial: running,
					isError: !!view && !running && view.ending !== "completed",
					// How long an interrupted call ran is unknown.
					durationMs: running || !view || view.ending === "interrupted" ? undefined : view.elapsedMs,
				});
				return new Marked(component, marker(context.toolCallId, view, theme));
			},
		};
	};
}
