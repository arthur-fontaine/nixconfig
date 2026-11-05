// Tool rows drawn fainter, their colors kept, so they read apart from the agent's own words. Wraps every tool's
// renderers, compact-tools' included (loaded before it, see extensionsManifest), and keeps
// clicks and the inner renderer's reuse of its own component working.
import { type ExtensionAPI, type Theme, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { type Component } from "@earendil-works/pi-tui";
import { type Fade, fadeOf, faint } from "./faint.ts";

// How far toward the background the rows go.
const AMOUNT = 0.3;

type RenderCall = NonNullable<ToolRenderers["renderCall"]>;
type RenderResult = NonNullable<ToolRenderers["renderResult"]>;
type RenderContext = Parameters<RenderCall>[2];

class Faint implements Component {
	readonly inner: Component;
	private readonly fade: () => Fade | undefined;
	private cache?: { input: string[]; output: string[]; fade?: Fade };

	constructor(inner: Component, fade: () => Fade | undefined) {
		this.inner = inner;
		this.fade = fade;
	}

	render(width: number): string[] {
		const input = this.inner.render(width);
		const fade = this.fade();
		if (!fade) return input;
		const cache = this.cache;
		if (cache && cache.fade === fade && cache.input.length === input.length && cache.input.every((line, i) => line === input[i])) return cache.output;
		const output = input.map((line) => faint(line, fade));
		this.cache = { input: [...input], output, fade };
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

// The inner renderer gets back its own component, never this wrapper.
function innerContext(context: RenderContext): RenderContext {
	const last = context.lastComponent;
	return { ...context, lastComponent: last instanceof Faint ? last.inner : last };
}

// One fade per palette, a theme switch (light to dark) included.
let last: { key: string; fade?: Fade } | undefined;
function fadeFor(theme: Theme): Fade | undefined {
	const key = `${theme.getFgAnsi("text")}\0${(theme as { appearance?: string }).appearance ?? ""}`;
	if (last?.key !== key) last = { key, fade: fadeOf(theme as never, AMOUNT) };
	return last.fade;
}

export default function (pi: ExtensionAPI) {
	pi.registerToolRenderer((_toolName, next) => {
		const renderers = next();
		if (!renderers) return renderers;
		const call = renderers.renderCall;
		const result = renderers.renderResult;
		return {
			...renderers,
			...(call && { renderCall: ((args, theme, context) => new Faint(call(args, theme, innerContext(context)), () => fadeFor(theme))) as RenderCall }),
			...(result && {
				renderResult: ((res, options, theme, context) => new Faint(result(res, options, theme, innerContext(context)), () => fadeFor(theme))) as RenderResult,
			}),
		};
	});
}
