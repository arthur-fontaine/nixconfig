// ancestor-skills for Pi: loads the `.agents/skills` of the folders above the git root, so a
// worktree nested anywhere under a bare-repo folder gets the skills kept in that folder.
import { homedir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { skillDirsAboveGitRoot } from "./dirs.ts";

export default function (pi: ExtensionAPI) {
	pi.on("resources_discover", async (event, ctx) => {
		if (!ctx.isProjectTrusted()) return {};
		return { skillPaths: skillDirsAboveGitRoot(event.cwd, homedir()) };
	});
}
