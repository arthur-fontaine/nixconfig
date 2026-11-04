import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { capture, changes, MARK, parseEnv } from "../capture.ts";

test("only what follows the mark is the environment", () => {
	const out = `welcome banner\nA=noise\0${MARK}\0PATH=/a:/b\0MULTI=x\ny\0EQ=a=b\0`;
	assert.deepEqual([...parseEnv(out)!], [["PATH", "/a:/b"], ["MULTI", "x\ny"], ["EQ", "a=b"]]);
	assert.equal(parseEnv("no mark here"), null);
});

test("changes keep the terminal's identity and the shell's own state", () => {
	const current = { PATH: "/usr/bin", TERM: "xterm-ghostty", HC_TERMINAL_ID: "t1" };
	const captured = new Map([
		["PATH", "/mise/bin:/usr/bin"], ["TERM", "dumb"], ["PWD", "/x"], ["SHLVL", "2"],
		["P9K_TTY", "old"], ["HC_TERMINAL_ID", "t1"], ["DIRENV_DIR", "-/repo"],
	]);
	assert.deepEqual(changes(current, captured), { PATH: "/mise/bin:/usr/bin", DIRENV_DIR: "-/repo" });
});

test("capture runs the shell in the folder and reads its env", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "shell-env-"));
	try {
		// A stand-in shell: prints noise, then runs the script with sh in the folder.
		const shell = path.join(dir, "fake-shell");
		writeFileSync(shell, `#!/bin/sh\necho noise\nFROM_RC=yes; export FROM_RC\nexec /bin/sh -c "$2"\n`, { mode: 0o755 });
		const vars = await capture(dir, { PATH: process.env.PATH, SHELL: shell });
		assert.equal(vars.get("FROM_RC"), "yes");
		assert.equal(vars.get("PI_SHELL_ENV"), "capture");
		assert.equal(vars.get("PWD"), dir.replace(/^\/var\//, "/private/var/")) ;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
