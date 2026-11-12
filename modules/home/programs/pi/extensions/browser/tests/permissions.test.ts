import assert from "node:assert/strict";
import { test } from "node:test";
import { callPermissions, hostOf, targetUrl } from "../permissions.ts";

const handler = () => true;

test("a call the classifier let through, on a resolved host: the site checks are lifted for that call", () => {
	const options = callPermissions({ classifierAllowed: true, host: "127.0.0.1:8917", deniedHosts: [], onPermissionRequest: handler });
	assert.deepEqual(options, { permissionMode: "skip_all_permission_checks" });
});

test("a batch that clicks then zooms on the same host goes out lifted, so its zoom never stops on a prompt", () => {
	const args = { actions: [{ name: "computer", input: { action: "left_click", coordinate: [123, 138], tabId: 7 } }, { name: "computer", input: { action: "zoom", region: [0, 90, 500, 230], tabId: 7 } }] };
	const url = targetUrl("browser_batch", args, "http://127.0.0.1:8917/");
	assert.equal(url, "http://127.0.0.1:8917/");
	assert.deepEqual(callPermissions({ classifierAllowed: true, host: hostOf(url), deniedHosts: [], onPermissionRequest: handler }), {
		permissionMode: "skip_all_permission_checks",
	});
});

test("not classified (a fast path, auto-mode off) but a resolved host: follow_a_plan on that host, prompts answered", () => {
	const options = callPermissions({ classifierAllowed: false, host: "127.0.0.1:8917", deniedHosts: [], onPermissionRequest: handler });
	assert.deepEqual(options, { permissionMode: "follow_a_plan", allowedDomains: ["127.0.0.1:8917"], onPermissionRequest: handler });
});

test("classified but no resolved host (a new tab, chrome:// page): follow_a_plan if hosts are known, else ask", () => {
	assert.deepEqual(callPermissions({ classifierAllowed: true, host: undefined, deniedHosts: [], allowedHosts: ["example.com"], onPermissionRequest: handler }), {
		permissionMode: "follow_a_plan",
		allowedDomains: ["example.com"],
	});
	assert.deepEqual(callPermissions({ classifierAllowed: true, host: undefined, deniedHosts: [], onPermissionRequest: handler }), { permissionMode: "ask" });
});

test("a deny rule keeps the site checks on, even for a classified call", () => {
	const options = callPermissions({ classifierAllowed: true, host: "127.0.0.1:8917", deniedHosts: ["bank.example"], onPermissionRequest: handler });
	assert.equal(options.permissionMode, "follow_a_plan");
});

test("the target: navigate's URL, the batch's own navigate, else the tab's page; only web URLs have a host", () => {
	assert.equal(targetUrl("navigate", { url: "127.0.0.1:8917/x" }, "chrome://newtab/"), "https://127.0.0.1:8917/x");
	assert.equal(targetUrl("navigate", { url: "back", tabId: 1 }, "https://a.example/"), "https://a.example/");
	assert.equal(targetUrl("browser_batch", { actions: [{ name: "navigate", input: { url: "http://b.example/" } }] }, "https://a.example/"), "http://b.example/");
	assert.equal(targetUrl("find", { query: "x", tabId: 1 }, "https://a.example/p"), "https://a.example/p");
	assert.equal(hostOf("http://127.0.0.1:8917/"), "127.0.0.1:8917");
	assert.equal(hostOf("chrome://newtab/"), undefined);
	assert.equal(hostOf(undefined), undefined);
});
