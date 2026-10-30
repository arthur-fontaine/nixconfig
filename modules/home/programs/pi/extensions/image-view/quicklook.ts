import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".heif", ".avif", ".bmp", ".tif", ".tiff"]);

/** The local image file a link points at, if it does: `file://` URLs only. */
export function imagePathFromUrl(url: string, exists: (file: string) => boolean = existsSync): string | undefined {
	let path: string;
	try {
		// Throws for a URL that isn't file: or names a remote host.
		path = fileURLToPath(url);
	} catch {
		return undefined;
	}
	return IMAGE_EXTENSIONS.has(extname(path).toLowerCase()) && exists(path) ? path : undefined;
}

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
