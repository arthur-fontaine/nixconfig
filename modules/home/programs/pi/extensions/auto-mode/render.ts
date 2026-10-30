// Adds "Allowed by auto mode" to the rows of calls the classifier allowed, whatever renderer
// draws them (Pi's own, or other extensions' chained on it), beside bash's `Took Xs`.
import type { ToolRendererResolver } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { allowedIn, isTimer, NOTE, placeNote } from "./note.ts";

type RenderResult = NonNullable<NonNullable<ReturnType<ToolRendererResolver>>["renderResult"]>;
type Theme = Parameters<RenderResult>[2];

class Noted implements Component {
	readonly inner: Component;
	private readonly theme: Theme;

	constructor(inner: Component, theme: Theme) {
		this.inner = inner;
		this.theme = theme;
	}

	render(width: number): string[] {
		const muted = this.theme.getFgAnsi("muted");
		return placeNote(this.inner.render(width), width, this.theme.fg("dim", NOTE), NOTE.length, (line) => isTimer(line, muted));
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

export function noteRenderer(allowed: (toolCallId: string) => boolean): ToolRendererResolver {
	return (toolName, next) => {
		const base = next();
		// Without a result renderer Pi draws its own fallback, which it keeps private: adding one
		// would replace that fallback for every call, so those tools go without the note.
		// Claude Code leaves the Agent row out.
		if (!base?.renderResult || toolName === "Agent") return base;
		const renderResult = base.renderResult;
		return {
			...base,
			renderResult(result, options, theme, context) {
				const last = context.lastComponent;
				const component = renderResult(result, options, theme, { ...context, lastComponent: last instanceof Noted ? last.inner : last });
				// Claude Code draws the note under successful results only. A running call is
				// known allowed already, but its row would carry the note beside "Elapsed".
				const show = !options.isPartial && !context.isError && (allowedIn(result.details) || allowed(context.toolCallId));
				return show ? new Noted(component, theme) : component;
			},
		};
	};
}
