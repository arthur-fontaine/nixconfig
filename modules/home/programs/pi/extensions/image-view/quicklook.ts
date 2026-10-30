import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * The command that shows `path` in Quick Look: the `quicklook` helper (built
 * from the Claude Code mod's quicklook/main.swift by nixconfig: no Dock icon,
 * opens on the display under the pointer) from PI_IMAGE_VIEW_QUICKLOOK or
 * this extension's bin/, else `qlmanage -p`.
 */
export function quickLookArgv(
	path: string,
	extensionDir: string,
	env: NodeJS.ProcessEnv = process.env,
	exists: (file: string) => boolean = existsSync,
): string[] {
	const helpers = [env.PI_IMAGE_VIEW_QUICKLOOK, `${extensionDir}/bin/quicklook`];
	const helper = helpers.find((file): file is string => !!file && exists(file));
	return helper ? [helper, path] : ["/usr/bin/qlmanage", "-p", path];
}

/** Opens one preview at a time: both commands run until the panel closes, so the last one is ended first. */
export class QuickLook {
	private preview: ChildProcess | undefined;
	private readonly extensionDir: string;

	constructor(extensionDir: string) {
		this.extensionDir = extensionDir;
	}

	open(path: string): void {
		this.close();
		const [command, ...args] = quickLookArgv(path, this.extensionDir);
		const child = spawn(command!, args, { stdio: "ignore" });
		child.on("error", () => {});
		child.on("exit", () => {
			if (this.preview === child) this.preview = undefined;
		});
		this.preview = child;
	}

	close(): void {
		this.preview?.kill();
		this.preview = undefined;
	}
}
