// What the footer says and how it fits, without Pi imports so its tests run under
// plain node. index.ts gathers the state and paints the segments.
import { isAbsolute, relative, resolve, sep } from "node:path";

export type Tone = "dim" | "muted" | "warning" | "error";
// A segment is either plain text the footer paints, or an extension's status,
// already painted by the extension.
export type Segment = { text: string; tone: Tone } | { painted: string };

export interface Measure {
	visibleWidth(text: string): number;
	truncateToWidth(text: string, width: number, ellipsis?: string): string;
}

export type Paint = (tone: Tone, text: string) => string;

export interface FooterState {
	cwd: string;
	home: string | undefined;
	// null outside a repo; Pi says "detached" for a detached HEAD.
	branch: string | null;
	sessionName: string | undefined;
	model: string | undefined;
	// undefined for a model that doesn't reason.
	thinking: string | undefined;
	// undefined or null when unknown.
	contextPercent: number | null | undefined;
	// undefined on a subscription.
	cost: number | undefined;
	statuses: Iterable<[string, string]>;
}

// Extensions' statuses, in the order line 2 shows them; the footer's own items
// (context, cost) slot in between. Unknown keys follow, sorted.
const BEFORE_CONTEXT = ["auto-mode", "remote-control"];
const AFTER_CONTEXT = ["cache-timer", "cache-warmer", "background-tools"];
const KNOWN = new Set([...BEFORE_CONTEXT, ...AFTER_CONTEXT]);

const LEFT_GAP = "   ";
const RIGHT_GAP = "  ";
const MIN_GAP = 2;
const MIN_SESSION_NAME = 12;

const SGR = /\x1b\[[0-9;:]*m/g;
// The `│ ` bar extensions used to put before their status, with or without its colors.
const BAR = /^((?:\x1b\[[0-9;:]*m)*)│ *((?:\x1b\[[0-9;:]*m)*) */;

export function plain(text: string): string {
	return text.replace(SGR, "");
}

export function cleanStatus(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim()
		.replace(BAR, "$1$2");
}

// Pi's own home-as-`~` (formatCwdForFooter), which it doesn't export.
export function formatCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const rel = relative(resolve(home), resolve(cwd));
	const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!inside) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

// `~/a/b/c` → `…/b/c` → `…/c`: the path with ever fewer leading segments.
export function shortenings(path: string): string[] {
	const parts = path.split(sep);
	const out: string[] = [];
	for (let i = 1; i < parts.length; i++) {
		const rest = parts.slice(i).join(sep);
		if (rest) out.push(`…${sep}${rest}`);
	}
	return out;
}

export function contextItem(percent: number | null | undefined): Segment | undefined {
	if (percent === null || percent === undefined || !Number.isFinite(percent)) return undefined;
	const p = Math.round(percent);
	if (p < 50) return undefined;
	return { text: `context ${p}% full`, tone: p > 90 ? "error" : p >= 70 ? "warning" : "dim" };
}

export function costItem(cost: number | undefined): Segment | undefined {
	// Nothing before the first request: `<$0.01` would suggest something was spent.
	if (cost === undefined || !(cost > 0)) return undefined;
	return { text: cost < 0.01 ? "<$0.01 so far" : `$${cost.toFixed(2)} so far`, tone: "dim" };
}

export function thinkingText(level: string | undefined): string | undefined {
	if (!level) return undefined;
	return level === "off" ? "thinking off" : `${level} thinking`;
}

// Line 2's items, with the rank at which a narrow terminal drops them (lower
// goes first; none: never dropped).
type Item = { segment: Segment; drop?: number };

const DROP = { thinking: 1, model: 2, cost: 3, remoteControl: 4, autoMode: 5 } as const;

function statusItem(key: string, text: string): Item {
	const words = plain(text);
	if (key === "remote-control" && words === "remote control on") return { segment: { painted: text }, drop: DROP.remoteControl };
	if (key === "auto-mode" && words === "auto mode") return { segment: { painted: text }, drop: DROP.autoMode };
	return { segment: { painted: text } };
}

export function leftItems(state: Pick<FooterState, "contextPercent" | "cost" | "statuses">): Item[] {
	const statuses = new Map<string, string>();
	for (const [key, text] of state.statuses) {
		const clean = cleanStatus(text);
		if (plain(clean)) statuses.set(key, clean);
	}
	const items: Item[] = [];
	const known = (keys: string[]) => {
		for (const key of keys) {
			const text = statuses.get(key);
			if (text !== undefined) items.push(statusItem(key, text));
		}
	};
	known(BEFORE_CONTEXT);
	const context = contextItem(state.contextPercent);
	if (context) items.push({ segment: context });
	known(AFTER_CONTEXT);
	const cost = costItem(state.cost);
	if (cost) items.push({ segment: cost, drop: DROP.cost });
	const unknown = [...statuses.keys()].filter((key) => !KNOWN.has(key)).sort((a, b) => a.localeCompare(b));
	// Dim up to the first color the extension set itself.
	for (const key of unknown) items.push({ segment: { text: statuses.get(key)!, tone: "dim" } });
	return items;
}

export function rightItems(state: Pick<FooterState, "model" | "thinking">): Item[] {
	const items: Item[] = [];
	if (state.model) items.push({ segment: { text: state.model, tone: "dim" }, drop: DROP.model });
	const thinking = thinkingText(state.thinking);
	if (thinking) items.push({ segment: { text: thinking, tone: "dim" }, drop: DROP.thinking });
	return items;
}

function paintSegment(segment: Segment, paint: Paint): string {
	return "painted" in segment ? segment.painted : paint(segment.tone, segment.text);
}

function join(items: Item[], gap: string, paint: Paint): string {
	return items.map((item) => paintSegment(item.segment, paint)).join(gap);
}

export function statusLine(state: FooterState, width: number, paint: Paint, measure: Measure): string {
	let left = leftItems(state);
	let right = rightItems(state);
	const fits = () => {
		const l = measure.visibleWidth(join(left, LEFT_GAP, paint));
		const r = measure.visibleWidth(join(right, RIGHT_GAP, paint));
		return l + (l && r ? MIN_GAP : 0) + r <= width;
	};
	for (const rank of [DROP.thinking, DROP.model, DROP.cost, DROP.remoteControl, DROP.autoMode]) {
		if (fits()) break;
		left = left.filter((item) => item.drop !== rank);
		right = right.filter((item) => item.drop !== rank);
	}
	let l = join(left, LEFT_GAP, paint);
	const r = join(right, RIGHT_GAP, paint);
	const rw = measure.visibleWidth(r);
	if (!r) return measure.truncateToWidth(l, width, "…");
	const room = width - rw - MIN_GAP;
	if (room <= 0) return measure.truncateToWidth(r, width, "");
	if (measure.visibleWidth(l) > room) l = measure.truncateToWidth(l, room, "…");
	return l + " ".repeat(Math.max(MIN_GAP, width - measure.visibleWidth(l) - rw)) + r;
}

export function locationLine(state: FooterState, width: number, paint: Paint, measure: Measure): string {
	const w = (text: string) => measure.visibleWidth(text);
	const full = formatCwd(state.cwd, state.home);
	const branch = state.branch ? ` (${state.branch})` : "";
	let name = state.sessionName ? state.sessionName.replace(/\s+/g, " ").trim() : "";
	const named = () => (name ? 2 + 1 + w(name) : 0);

	let path = full;
	if (w(path) + w(branch) + named() > width) {
		const shorter = shortenings(full);
		path = shorter.find((candidate) => w(candidate) + w(branch) + named() <= width) ?? shorter.at(-1) ?? full;
	}
	if (name && w(path) + w(branch) + named() > width) {
		const room = Math.max(MIN_SESSION_NAME, width - w(path) - w(branch) - 3);
		if (w(name) > room) name = measure.truncateToWidth(name, room, "…");
	}

	let line = paint("dim", path);
	if (branch) line += " " + paint("dim", branch.slice(1));
	if (name) line += "  " + paint("muted", `@${name}`);
	return measure.truncateToWidth(line, width, paint("dim", "…"));
}

// Always two lines, so the editor above doesn't move as items come and go.
export function footerLines(state: FooterState, width: number, paint: Paint, measure: Measure): [string, string] {
	return [locationLine(state, width, paint, measure), statusLine(state, width, paint, measure)];
}
