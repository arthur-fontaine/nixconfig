// Web tools for Pi: search the web and read pages through TinyFish
// (tinyfish.ai/search), and look at an image from a URL. See README.md.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	apiError,
	FETCH_URL,
	type FetchError,
	type FetchResult,
	formatFetch,
	formatSearch,
	imageType,
	KEY_ENV,
	type SearchResult,
	searchUrl,
} from "./tinyfish.ts";

const run = promisify(execFile);
const TIMEOUT_MS = 60_000;
// Over this the image is shrunk before the model sees it (its limit is 5 MB,
// and it scales anything past ~1568 px down anyway).
const MAX_IMAGE_BYTES = 3_500_000;
const MAX_DOWNLOAD_BYTES = 30_000_000;

// The shell exports ~/.config/.env (zshrc.d/902_dotenv.sh); a Pi started some
// other way reads the file itself.
async function apiKey(): Promise<string> {
	if (process.env[KEY_ENV]) return process.env[KEY_ENV] as string;
	const file = await readFile(join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), ".env"), "utf8").catch(() => "");
	const line = file.split("\n").find((l) => l.trim().startsWith(`${KEY_ENV}=`));
	const key = line?.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
	if (!key) throw new Error(`No TinyFish API key: add ${KEY_ENV}=… to ~/.config/.env (get one at https://agent.tinyfish.ai/api-keys)`);
	return key;
}

function deadline(signal: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

const webSearch = defineTool({
	name: "web_search",
	label: "Web search",
	description:
		"Search the live web (TinyFish). Returns ranked results with title, URL and snippet. " +
		"Use web_fetch to read a result, and view_image to look at an image.",
	parameters: Type.Object({
		query: Type.String({ description: "The search query" }),
		purpose: Type.Optional(Type.String({ description: "Why you are searching, in a sentence; improves results" })),
		include_domains: Type.Optional(Type.Array(Type.String(), { description: "Only these domains, e.g. github.com" })),
		exclude_domains: Type.Optional(Type.Array(Type.String(), { description: "Never these domains" })),
		recency_minutes: Type.Optional(Type.Integer({ minimum: 1, description: "Only results from the last N minutes" })),
		domain_type: Type.Optional(Type.Union([Type.Literal("web"), Type.Literal("news"), Type.Literal("research_paper")])),
		language: Type.Optional(Type.String({ description: "Result language code, e.g. en, fr" })),
		page: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "Results page, from 0" })),
	}),
	async execute(_id, params, signal) {
		const res = await fetch(searchUrl(params), { headers: { "X-API-Key": await apiKey() }, signal: deadline(signal) });
		const body = await res.text();
		if (!res.ok) throw new Error(apiError(res.status, body));
		const results = (JSON.parse(body).results ?? []) as SearchResult[];
		return {
			content: [{ type: "text", text: formatSearch(params.query, results) }],
			details: { query: params.query, count: results.length },
		};
	},
});

const webFetch = defineTool({
	name: "web_fetch",
	label: "Web fetch",
	description:
		"Read web pages as clean Markdown (TinyFish), up to 10 URLs at once. " +
		"Set images to also list the page's image URLs, to open with view_image.",
	parameters: Type.Object({
		urls: Type.Array(Type.String(), { minItems: 1, maxItems: 10, description: "http(s) URLs" }),
		purpose: Type.Optional(Type.String({ description: "Why you are reading these pages, in a sentence" })),
		images: Type.Optional(Type.Boolean({ description: "Also list the <img> URLs of each page" })),
		links: Type.Optional(Type.Boolean({ description: "Also list the links of each page" })),
	}),
	async execute(_id, params, signal) {
		const res = await fetch(FETCH_URL, {
			method: "POST",
			headers: { "X-API-Key": await apiKey(), "Content-Type": "application/json" },
			body: JSON.stringify({
				urls: params.urls,
				format: "markdown",
				purpose: params.purpose,
				image_links: params.images ?? false,
				links: params.links ?? false,
			}),
			signal: deadline(signal),
		});
		const body = await res.text();
		if (!res.ok) throw new Error(apiError(res.status, body));
		const data = JSON.parse(body) as { results?: (FetchResult & { links?: string[] })[]; errors?: FetchError[] };
		const results = data.results ?? [];
		let text = formatFetch(results, data.errors ?? []);
		if (params.links) {
			for (const r of results) if (r.links?.length) text += `\n\n## Links of ${r.url}\n${r.links.slice(0, 200).join("\n")}`;
		}
		return {
			content: [{ type: "text", text }],
			details: { urls: params.urls, fetched: results.length, failed: data.errors?.length ?? 0 },
		};
	},
});

// Too big for the model: macOS's sips turns it into a JPEG at most 1568 px wide.
async function shrink(bytes: Uint8Array): Promise<{ data: Buffer; mimeType: string }> {
	const dir = await mkdtemp(join(tmpdir(), "pi-view-image-"));
	try {
		const src = join(dir, "in"), out = join(dir, "out.jpg");
		await writeFile(src, bytes);
		await run("sips", ["-s", "format", "jpeg", "-s", "formatOptions", "80", "-Z", "1568", src, "--out", out]);
		return { data: await readFile(out), mimeType: "image/jpeg" };
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const viewImage = defineTool({
	name: "view_image",
	label: "View image",
	description: "Download an image from a URL (PNG, JPEG, GIF or WebP) and look at it.",
	parameters: Type.Object({
		url: Type.String({ description: "The image's http(s) URL" }),
	}),
	async execute(_id, params, signal) {
		const res = await fetch(params.url, {
			headers: { "User-Agent": "Mozilla/5.0 (Macintosh) Pi", Accept: "image/*" },
			redirect: "follow",
			signal: deadline(signal),
		});
		if (!res.ok) throw new Error(`The image answered ${res.status} ${res.statusText}`);
		const length = Number(res.headers.get("content-length") ?? 0);
		if (length > MAX_DOWNLOAD_BYTES) throw new Error(`The image is ${Math.round(length / 1e6)} MB, too big to download`);
		const bytes = new Uint8Array(await res.arrayBuffer());
		const type = imageType(res.headers.get("content-type"), bytes);
		if (!type) throw new Error(`Not an image the model can read (${res.headers.get("content-type") ?? "no type"}); PNG, JPEG, GIF and WebP work`);
		const image = bytes.length > MAX_IMAGE_BYTES ? await shrink(bytes) : { data: Buffer.from(bytes), mimeType: type };
		return {
			content: [
				{ type: "text", text: `${params.url} (${image.mimeType}, ${Math.round(image.data.length / 1024)} KB)` },
				{ type: "image", data: image.data.toString("base64"), mimeType: image.mimeType },
			],
			details: { url: params.url, mimeType: image.mimeType, bytes: image.data.length },
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(webSearch);
	pi.registerTool(webFetch);
	pi.registerTool(viewImage);
}
