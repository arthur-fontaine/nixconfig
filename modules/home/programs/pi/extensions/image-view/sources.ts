// Where the images come from: pi-image-view's markers and blobs, user
// messages, and tool results.
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { imageNumbers } from "./layout.ts";

export type ImageBlock = { type: "image"; data: string; mimeType: string };
type Block = { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };

/** An image to tile: a file, or bytes the caller still has to save. */
export type Source = { id: string; label: string; alt: string } & ({ path: string } | { image: ImageBlock });

const BLOB = String.raw`[a-f0-9]{64}\.(?:png|jpg|gif|webp)`;
// pi-image-view rewrites a sent `[Image #n]` as a Markdown link to the blob it
// stored, `[[Image #n]](file:///…/image-view/blobs/<sha256>.<ext>)` (earlier
// versions: `[Image #n](…)`, or an `image-view://sha256/…` target).
const LINK = new RegExp(String.raw`\[?\[Image #(\d+)\]\]?\((file:\/\/\/[^)\s]*\/image-view\/blobs\/${BLOB}|image-view:\/\/sha256\/${BLOB})\)`, "g");

export function blobRoot(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "image-view", "blobs");
}

/** The file behind one of pi-image-view's references (a file URL or its internal scheme). */
export function referencePath(reference: string, root = blobRoot()): string | undefined {
	const internal = new RegExp(`^image-view://sha256/(${BLOB})$`).exec(reference);
	if (internal) return join(root, internal[1]!);
	try {
		const url = new URL(reference);
		return url.protocol === "file:" && !url.hostname ? fileURLToPath(url) : undefined;
	} catch {
		return undefined;
	}
}

/** pi-image-view's linked markers in a sent prompt, by number, in order. */
export function linkedImages(text: string, root = blobRoot()): { n: number; path: string }[] {
	const seen = new Map<number, string>();
	for (const match of text.matchAll(LINK)) {
		const path = referencePath(match[2]!, root);
		const n = Number(match[1]);
		if (path && !seen.has(n)) seen.set(n, path);
	}
	return [...seen].map(([n, path]) => ({ n, path }));
}

function blocks(content: unknown): Block[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? (content as Block[]) : [];
}

function isImage(block: Block): block is ImageBlock {
	return block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string";
}

/**
 * A user message's images: the blobs pi-image-view linked, or else the image
 * blocks themselves (pasted without pi-image-view, sent from the Claude apps,
 * an extension's sendUserMessage), numbered like their `[Image #n]` markers
 * when there is one per image.
 */
export function messageSources(content: unknown, root = blobRoot()): Source[] {
	const all = blocks(content);
	const text = all.flatMap((b) => (b.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("\n");
	const images = all.filter(isImage);
	const linked = linkedImages(text, root);
	if (linked.length > 0 && linked.length >= images.length) {
		return linked.map(({ n, path }) => ({ id: String(n), label: `#${n}`, alt: `[Image #${n}]`, path }));
	}
	const numbers = imageNumbers(text);
	return images.map((image, i) => {
		const n = numbers.length === images.length ? numbers[i]! : i + 1;
		return { id: String(n), label: `#${n}`, alt: `[Image #${n}]`, image };
	});
}

/**
 * The images a tool result carries. `read` gets the file it read, which keeps
 * its name and full resolution for Quick Look; any other tool (an MCP
 * screenshot, say) only has the bytes.
 */
export function toolSources(toolName: string, args: unknown, content: unknown, cwd: string): Source[] {
	const images = blocks(content).filter(isImage);
	const path = (args as { path?: unknown; file_path?: unknown } | null)?.path ?? (args as { file_path?: unknown } | null)?.file_path;
	if (toolName === "read" && images.length === 1 && typeof path === "string") {
		const name = basename(path);
		return [{ id: "read", label: name, alt: `[${name}]`, path: resolve(cwd, path.replace(/^~(?=\/|$)/, homedir())) }];
	}
	return images.map((image, i) => ({ id: `tool-${i}`, label: `#${i + 1}`, alt: `[image ${i + 1}]`, image }));
}

const DRAFT_LINK_OPTIONS = Symbol.for("pi-image-view.draft-link-options");
type DraftEditor = { [DRAFT_LINK_OPTIONS]?: { draftReference?: (marker: string) => string | undefined } };

/**
 * pi-image-view keeps which blob a draft's `[Image #n]` stands for in memory;
 * the one handle on it from outside is the options object it hangs on the
 * editor instance under this symbol. Finds that editor in Pi's component tree.
 */
export function findDraftEditor(root: unknown): DraftEditor | undefined {
	const queue: unknown[] = [root];
	const seen = new Set<unknown>();
	while (queue.length > 0) {
		const node = queue.shift();
		if (!node || typeof node !== "object" || seen.has(node)) continue;
		seen.add(node);
		if (DRAFT_LINK_OPTIONS in node) return node as DraftEditor;
		const children = (node as { children?: unknown }).children;
		if (Array.isArray(children)) queue.push(...children);
	}
	return undefined;
}

export function draftPath(editor: DraftEditor | undefined, n: number, root = blobRoot()): string | undefined {
	const reference = editor?.[DRAFT_LINK_OPTIONS]?.draftReference?.(`[Image #${n}]`);
	return reference ? referencePath(reference, root) : undefined;
}
