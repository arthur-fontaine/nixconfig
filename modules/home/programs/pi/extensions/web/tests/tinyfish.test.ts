import assert from "node:assert/strict";
import { test } from "node:test";
import { apiError, formatFetch, formatSearch, imageType, searchUrl } from "../tinyfish.ts";

test("searchUrl sets only the given parameters, domains comma-joined", () => {
	const url = new URL(searchUrl({ query: "zed git panel", include_domains: ["zed.dev", "github.com"], page: 0 }));
	assert.equal(url.origin, "https://api.search.tinyfish.ai");
	assert.equal(url.searchParams.get("query"), "zed git panel");
	assert.equal(url.searchParams.get("include_domains"), "zed.dev,github.com");
	assert.equal(url.searchParams.get("page"), "0");
	assert.equal(url.searchParams.has("purpose"), false);
});

test("formatSearch lists results, and says when there are none", () => {
	const text = formatSearch("q", [{ position: 1, title: "Zed", url: "https://zed.dev", site_name: "zed.dev", snippet: "An editor" }]);
	assert.match(text, /^1\. Zed\n   https:\/\/zed\.dev\n   zed\.dev\n   An editor$/);
	assert.equal(formatSearch("q", []), 'No results for "q".');
});

test("formatFetch cuts long pages and lists images and failures", () => {
	const text = formatFetch(
		[{ url: "https://a.dev", title: "A", text: "x".repeat(50), image_links: ["https://a.dev/1.png"] }],
		[{ url: "https://b.dev", message: "timeout" }],
		10,
	);
	assert.match(text, /\[… cut at 10 of 50 characters\]/);
	assert.match(text, /## Images \(1\)\nhttps:\/\/a\.dev\/1\.png/);
	assert.match(text, /# Could not fetch https:\/\/b\.dev\ntimeout/);
});

test("imageType trusts a readable declared type, else the file's signature", () => {
	assert.equal(imageType("image/png; charset=binary", new Uint8Array()), "image/png");
	assert.equal(imageType("application/octet-stream", new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
	const webp = new Uint8Array(12);
	webp.set([0x57, 0x45, 0x42, 0x50], 8);
	assert.equal(imageType(null, webp), "image/webp");
	assert.equal(imageType("image/svg+xml", new TextEncoder().encode("<svg")), undefined);
});

test("apiError explains the statuses worth acting on", () => {
	assert.match(apiError(401, ""), /TINYFISH_API_KEY/);
	assert.match(apiError(500, "boom"), /500: boom/);
});
