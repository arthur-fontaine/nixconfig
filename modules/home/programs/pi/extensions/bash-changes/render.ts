// Draws a bash call's file changes under its output, in the look of Pi's edit
// diffs: `-12 old`, `+12 new`, ` 12 context`.
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { type FilePatch, type Hunk, parsePatch } from "./patch.ts";
import { type ChangedFile, type FileChanges, PATCH_LIMIT } from "./snapshot.ts";

// Pi's rendering helpers, passed in so this module runs without Pi installed.
export type RenderDeps = {
	highlight(code: string, language: string): string[];
	language(path: string): string | undefined;
	wrap(text: string, width: number): string[];
	expandHint(): string;
};

export type Paint = Pick<Theme, "fg">;

export type ViewSettings = {
	// Files whose diff is previewed while the result is collapsed.
	openFiles: number;
	// Preview new files' diffs even past openFiles.
	newFilesOpen: boolean;
	// Diff lines previewed per file while collapsed.
	previewLines: number;
	// Files listed while collapsed; the rest are counted.
	listFiles: number;
};

export const DEFAULT_VIEW: ViewSettings = { openFiles: 3, newFilesOpen: false, previewLines: 10, listFiles: 6 };

export function fileChangesOf(details: unknown): FileChanges | undefined {
	const changes = (details as { fileChanges?: FileChanges } | undefined)?.fileChanges;
	return changes && Array.isArray(changes.files) && typeof changes.patch === "string" ? changes : undefined;
}

const STATUS_TAG: Record<string, string> = { A: "new", D: "deleted", T: "type changed" };

function counts(files: readonly ChangedFile[], theme: Paint) {
	const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0);
	const removed = files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
	return [added ? theme.fg("toolDiffAdded", `+${added}`) : "", removed ? theme.fg("toolDiffRemoved", `−${removed}`) : ""]
		.filter(Boolean)
		.join(" ");
}

function tags(file: ChangedFile, theme: Paint) {
	const status = STATUS_TAG[file.status];
	return [status && theme.fg("muted", status), file.added === undefined ? theme.fg("muted", "binary") : ""].filter(Boolean);
}

function summary(changes: FileChanges, theme: Paint) {
	const { files } = changes;
	const names = files.length === 1 ? files[0]!.path : files.length === 2 ? files.map((file) => basename(file.path)).join(", ") : plural(files.length, "file");
	return [
		theme.fg("accent", `✎ ${names}`),
		counts(files, theme),
		...(files.length === 1 ? tags(files[0]!, theme) : []),
		changes.overlapping ? theme.fg("warning", "overlapping") : "",
	]
		.filter(Boolean)
		.join("  ");
}

function fileHeader(file: ChangedFile, theme: Paint) {
	return [theme.fg("toolOutput", file.path), ...tags(file, theme), counts([file], theme)].filter(Boolean).join("  ");
}

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
const replaceTabs = (text: string) => text.replace(/\t/g, "   ");

// Highlights the new side of each hunk (context and added lines) as one block,
// so constructs spanning lines, like block comments, keep their colors.
function highlightAdded(hunk: Hunk, language: string, deps: RenderDeps): Map<number, string> {
	const indexes: number[] = [];
	const source: string[] = [];
	hunk.lines.forEach((line, index) => {
		if (line.kind === "removed") return;
		indexes.push(index);
		source.push(replaceTabs(line.text));
	});
	let highlighted = deps.highlight(source.join("\n"), language);
	if (highlighted.length !== source.length) highlighted = source.map((text) => deps.highlight(text, language)[0] ?? text);
	const byIndex = new Map<number, string>();
	indexes.forEach((index, i) => {
		if (hunk.lines[index]!.kind === "added") byIndex.set(index, highlighted[i]!);
	});
	return byIndex;
}

// Diff rows of one file, unwrapped.
function diffRows(path: string, patch: FilePatch, theme: Paint, deps: RenderDeps): string[] {
	const digits = String(Math.max(0, ...patch.hunks.flatMap((hunk) => hunk.lines.map((line) => line.line)))).length;
	const language = deps.language(path);
	const rows: string[] = [];
	patch.hunks.forEach((hunk, index) => {
		if (index > 0) rows.push(theme.fg("toolDiffContext", ` ${" ".repeat(digits)} ...${hunk.heading ? ` ${hunk.heading}` : ""}`));
		const highlighted = language ? highlightAdded(hunk, language, deps) : new Map<number, string>();
		hunk.lines.forEach((line, i) => {
			const number = String(line.line).padStart(digits);
			const text = replaceTabs(line.text);
			if (line.kind === "context") rows.push(theme.fg("toolDiffContext", ` ${number} ${text}`));
			else if (line.kind === "removed") rows.push(theme.fg("toolDiffRemoved", `-${number} ${text}`));
			else {
				const code = highlighted.get(i);
				rows.push(code === undefined ? theme.fg("toolDiffAdded", `+${number} ${text}`) : `${theme.fg("toolDiffAdded", `+${number}`)} ${code}`);
			}
		});
	});
	return rows;
}

const parsed = new WeakMap<FileChanges, Map<string, FilePatch>>();

function patches(changes: FileChanges) {
	let files = parsed.get(changes);
	if (!files) parsed.set(changes, (files = parsePatch(changes.patch)));
	return files;
}

// Unwrapped rows: a summary, then each file with its diff. Collapsed, only the
// first files are listed and previewed, and a hint says how to see the rest.
export function changeRows(changes: FileChanges, expanded: boolean, view: ViewSettings, theme: Paint, deps: RenderDeps): string[] {
	const files = patches(changes);
	const rows = [summary(changes, theme)];
	let hidden = false;
	const single = changes.files.length === 1;
	const listed = expanded ? changes.files : changes.files.slice(0, view.listFiles);
	listed.forEach((file, index) => {
		if (!single) rows.push(fileHeader(file, theme));
		const patch = files.get(file.path);
		if (!patch?.hunks.length) return;
		const open = expanded || index < view.openFiles || (view.newFilesOpen && file.status === "A");
		if (!open) {
			hidden = true;
			return;
		}
		const diff = diffRows(file.path, patch, theme, deps);
		const shown = expanded ? diff : diff.slice(0, view.previewLines);
		rows.push(...shown);
		if (shown.length < diff.length) {
			hidden = true;
			rows.push(theme.fg("muted", `... (${plural(diff.length - shown.length, "more diff line")})`));
		}
	});
	if (listed.length < changes.files.length) {
		hidden = true;
		const rest = changes.files.slice(listed.length);
		rows.push([theme.fg("muted", `... ${plural(rest.length, "more file")}`), counts(rest, theme)].filter(Boolean).join("  "));
	}
	if (changes.patchTruncated && expanded) rows.push(theme.fg("warning", `[Diff truncated at ${PATCH_LIMIT / 1024} KB]`));
	if (hidden) rows.push(deps.expandHint());
	return rows;
}

// The bash result as the inner renderer draws it, followed by the changes.
export class ChangesView implements Component {
	base: Component | undefined;
	#changes: FileChanges;
	#expanded: boolean;
	#view: ViewSettings;
	#theme: Paint;
	#deps: RenderDeps;
	#cache: { width: number; lines: string[] } | undefined;

	constructor(base: Component | undefined, changes: FileChanges, expanded: boolean, view: ViewSettings, theme: Paint, deps: RenderDeps) {
		this.base = base;
		this.#changes = changes;
		this.#expanded = expanded;
		this.#view = view;
		this.#theme = theme;
		this.#deps = deps;
	}

	update(base: Component | undefined, changes: FileChanges, expanded: boolean, view: ViewSettings, theme: Paint) {
		this.base = base;
		if (changes !== this.#changes || expanded !== this.#expanded || view !== this.#view || theme !== this.#theme) this.#cache = undefined;
		this.#changes = changes;
		this.#expanded = expanded;
		this.#view = view;
		this.#theme = theme;
	}

	render(width: number): string[] {
		if (this.#cache?.width !== width) {
			const rows = changeRows(this.#changes, this.#expanded, this.#view, this.#theme, this.#deps);
			this.#cache = { width, lines: ["", ...rows.flatMap((row) => this.#deps.wrap(row, Math.max(1, width)))] };
		}
		return [...(this.base?.render(width) ?? []), ...this.#cache.lines];
	}

	invalidate() {
		this.#cache = undefined;
		this.base?.invalidate();
	}
}
