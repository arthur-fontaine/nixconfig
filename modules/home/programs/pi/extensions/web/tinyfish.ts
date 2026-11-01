// TinyFish's Search and Fetch APIs (docs.tinyfish.ai), and what the model reads
// of their answers. No Pi imports, so the tests run on plain Node.

export const SEARCH_URL = "https://api.search.tinyfish.ai";
export const FETCH_URL = "https://api.fetch.tinyfish.ai";
export const KEY_ENV = "TINYFISH_API_KEY";

export interface SearchParams {
	query: string;
	purpose?: string;
	location?: string;
	language?: string;
	include_domains?: string[];
	exclude_domains?: string[];
	recency_minutes?: number;
	domain_type?: "web" | "news" | "research_paper";
	page?: number;
}

export interface SearchResult {
	position: number;
	site_name?: string;
	title: string;
	snippet?: string;
	url: string;
	date?: string;
	publisher?: string;
}

export interface FetchResult {
	url: string;
	final_url?: string;
	title?: string | null;
	description?: string | null;
	published_date?: string | null;
	text?: string | null;
	image_links?: string[];
}

export interface FetchError {
	url: string;
	error?: string;
	code?: string;
	message?: string;
}

export function searchUrl(p: SearchParams): string {
	const url = new URL(SEARCH_URL);
	const set = (k: string, v: unknown) => {
		if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
	};
	set("query", p.query);
	set("purpose", p.purpose);
	set("location", p.location);
	set("language", p.language);
	set("include_domains", p.include_domains?.join(","));
	set("exclude_domains", p.exclude_domains?.join(","));
	set("recency_minutes", p.recency_minutes);
	set("domain_type", p.domain_type);
	set("page", p.page);
	return url.toString();
}

export function formatSearch(query: string, results: SearchResult[]): string {
	if (!results.length) return `No results for "${query}".`;
	return results
		.map((r) => {
			const meta = [r.site_name, r.publisher, r.date].filter(Boolean).join(" · ");
			return [`${r.position}. ${r.title}`, r.url, meta, r.snippet].filter(Boolean).join("\n   ");
		})
		.join("\n\n");
}

// Pages can be long: the model gets the start, and is told where it was cut.
export const MAX_PAGE_CHARS = 40_000;
const MAX_IMAGES = 60;

export function formatFetch(results: FetchResult[], errors: FetchError[], maxChars = MAX_PAGE_CHARS): string {
	const parts = results.map((r) => {
		const head = [`# ${r.title ?? r.final_url ?? r.url}`, r.final_url ?? r.url, r.published_date ?? "", r.description ?? ""]
			.filter(Boolean)
			.join("\n");
		let text = r.text ?? "";
		if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n\n[… cut at ${maxChars} of ${text.length} characters]`;
		const images = r.image_links?.length
			? `\n\n## Images (${r.image_links.length})\n${r.image_links.slice(0, MAX_IMAGES).join("\n")}${r.image_links.length > MAX_IMAGES ? `\n[… ${r.image_links.length - MAX_IMAGES} more]` : ""}`
			: "";
		return `${head}\n\n${text}${images}`;
	});
	for (const e of errors) parts.push(`# Could not fetch ${e.url}\n${e.message ?? e.error ?? e.code ?? "unknown error"}`);
	return parts.join("\n\n---\n\n");
}

// What the model can read as an image; others (SVG, AVIF, ICO) are refused.
export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function imageType(contentType: string | null, bytes: Uint8Array): string | undefined {
	const declared = contentType?.split(";")[0].trim().toLowerCase();
	if (declared && IMAGE_TYPES.has(declared)) return declared;
	// Servers often say application/octet-stream: trust the file's own signature.
	const b = bytes;
	if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
	if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
	if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
	return undefined;
}

export function apiError(status: number, body: string): string {
	const why: Record<number, string> = {
		401: `the TinyFish API key is missing or invalid (${KEY_ENV} in ~/.config/.env)`,
		402: "TinyFish's free daily allowance is used up",
		429: "TinyFish's rate limit was hit; wait a minute",
	};
	return `TinyFish answered ${status}: ${why[status] ?? body.slice(0, 300)}`;
}
