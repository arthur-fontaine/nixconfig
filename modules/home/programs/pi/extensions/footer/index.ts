// A two-line footer in place of Pi's: line 1 says where you are, line 2 what's
// going on. Pi's token counts, window size and provider are left out; layout.ts
// decides what shows and how it fits.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type FooterState, footerLines, type Measure } from "./layout.ts";

// Pi's VIRTUAL_MODEL_API, which it doesn't export.
const VIRTUAL_MODEL_API = "pi-virtual";

type Model = NonNullable<ExtensionContext["model"]>;
type Usage = { cost?: { total?: number } };
type Response = { provider: string; model: string; thinkingLevel?: string; stopReason?: string };
type Entry = {
	type: string;
	usage?: Usage;
	message?: { role: string; usage?: Usage } & Partial<Response>;
};

const measure: Measure = { visibleWidth, truncateToWidth };

// Pi's getSessionStats(): every request's cost, on every branch.
function sessionCost(entries: Entry[]): number {
	let cost = 0;
	for (const entry of entries) {
		const usage =
			entry.type === "usage" || entry.type === "branch_summary" || entry.type === "compaction"
				? entry.usage
				: entry.type === "message" && (entry.message?.role === "assistant" || entry.message?.role === "toolResult")
					? entry.message.usage
					: undefined;
		cost += usage?.cost?.total ?? 0;
	}
	return cost;
}

// Pi's routedModel: the latest successful response under a virtual model.
function latestResponse(branch: Entry[]): Response | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const message = branch[i]!.message;
		if (branch[i]!.type !== "message" || message?.role !== "assistant") continue;
		if (message.stopReason === "error" || message.stopReason === "aborted") continue;
		if (message.provider && message.model) return message as Response;
	}
	return undefined;
}

function onSubscription(ctx: ExtensionContext, model: Model): boolean {
	// As in Pi's footer: Kimi Coding is subscription-backed despite using API-key authentication.
	if (model.provider === "kimi-coding") return true;
	return ctx.modelRegistry.isUsingOAuth(model) && ctx.modelRegistry.getProvider(model.provider)?.auth.oauth?.isSubscription === true;
}

export default function footer(pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;

		// The footer renders on every frame; these only change with the session's entries.
		// Every append moves the leaf, so the leaf (and the model) is the cache key.
		let cached: { key: string; model: Model | undefined; cost: number; response: Response | undefined; context: number | null | undefined } | undefined;
		function stats() {
			const session = ctx.sessionManager;
			const key = `${session.getSessionId()}\0${session.getLeafId() ?? ""}`;
			const model = ctx.model;
			if (cached?.key === key && cached.model === model) return cached;
			const virtual = model?.api === VIRTUAL_MODEL_API;
			cached = {
				key,
				model,
				cost: sessionCost(session.getEntries() as unknown as Entry[]),
				response: virtual ? latestResponse(session.getBranch() as unknown as Entry[]) : undefined,
				context: ctx.getContextUsage()?.percent,
			};
			return cached;
		}

		function state(branch: string | null, statuses: ReadonlyMap<string, string>): FooterState {
			const { cost, response, context } = stats();
			const selected = ctx.model;
			const routed = response && ctx.modelRegistry.find(response.provider, response.model);
			const answering = routed ?? selected;
			const level = response?.thinkingLevel ?? ctx.thinkingLevel ?? pi.getThinkingLevel();
			return {
				cwd: ctx.sessionManager.getCwd(),
				home: process.env.HOME || process.env.USERPROFILE,
				branch,
				sessionName: ctx.sessionManager.getSessionName(),
				model: response?.model ?? selected?.id ?? "no model",
				thinking: answering?.reasoning ? level || "off" : undefined,
				contextPercent: context,
				cost: answering && onSubscription(ctx, answering) ? undefined : cost,
				statuses,
			};
		}

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			let last: string[] = ["", ""];
			return {
				render(width: number) {
					// A context gone stale throws; a throw here would stop every render.
					try {
						const lines = footerLines(
							state(footerData.getGitBranch(), footerData.getExtensionStatuses()),
							width,
							(tone, text) => theme.fg(tone, text),
							measure,
						);
						last = lines;
					} catch {}
					return last.map((line) => truncateToWidth(line, width, "…"));
				},
				invalidate() {},
				dispose: unsubscribe,
			};
		});
	});
}
