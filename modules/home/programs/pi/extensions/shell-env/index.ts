// Pi's commands run in the environment of the person's terminals, however Pi was started
// (a Herdr tab, `hc run`, a launchd agent): the interactive shell's variables, direnv's
// for the session folder included, taken once per session and put in Pi's own process
// environment, which the bash tool, `!` commands and later servers all inherit. As Claude
// Code's shell snapshot. Taken in the background: startup doesn't wait, the first command does.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { capture, changes } from "./capture.ts";

export default function (pi: ExtensionAPI) {
	let ready: Promise<void> | undefined;
	let cwd: string | undefined;

	pi.on("session_start", async (_event, ctx) => {
		if (ready && cwd === ctx.cwd) return;
		cwd = ctx.cwd;
		ready = capture(ctx.cwd, process.env)
			.then((vars) => { Object.assign(process.env, changes(process.env, vars)); })
			.catch((error) => {
				if (ctx.hasUI) ctx.ui.notify(`shell-env: kept Pi's own environment (${error.message})`, "warning");
			});
	});

	pi.on("tool_call", async (event) => {
		if (event.toolName === "bash" && ready) await ready;
	});

	pi.on("user_bash", async () => {
		if (ready) await ready;
	});
}
