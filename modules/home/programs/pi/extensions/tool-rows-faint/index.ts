// Tool rows drawn fainter, their colors kept, so they read apart from the agent's own words. Wraps every tool's
// renderers, compact-tools' included (loaded before it, see extensionsManifest), and keeps
// clicks and the inner renderer's reuse of its own component working.
import { type ExtensionAPI, type ToolRenderers } from "@earendil-works/pi-coding-agent";
import { type Component } from "@earendil-works/pi-tui";
import { type Fade, fadeFor, faint, share } from "./faint.ts";

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

export default function (pi: ExtensionAPI) {
	share();
	pi.registerToolRenderer((_toolName, next) => {
		const renderers = next();
		if (!renderers) return renderers;
		const call = renderers.renderCall;
		const result = renderers.renderResult;
		return {
			...renderers,
			...(call && { renderCall: ((args, theme, context) => new Faint(call(args, theme, innerContext(context)), () => fadeFor(theme as never))) as RenderCall }),
			...(result && {
				renderResult: ((res, options, theme, context) => new Faint(result(res, options, theme, innerContext(context)), () => fadeFor(theme as never))) as RenderResult,
			}),
		};
	});
}
