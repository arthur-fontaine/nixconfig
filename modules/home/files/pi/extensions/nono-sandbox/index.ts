import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path, { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AccessMode, apply, CapabilitySet, QueryContext, SandboxState, supportInfo } from "nono-ts";
import { spawnSync } from "node:child_process";
import { createBashTool, type BashOperations, getAgentDir, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

type PathAccess = "read" | "write" | "readwrite";

type SandboxConfig = {
	enabled?: boolean;
	skipIfCwdIsHome?: boolean;
	allowNetwork?: boolean;
	readOnlyPaths?: string[];
	readWritePaths?: string[];
	protectedPaths?: string[];
	dangerousCommandPatterns?: string[];
	alwaysAllowCommands?: string[];
};

type EffectivePolicy = {
	active: boolean;
	reason?: string;
	cwd: string;
	configFiles: string[];
	allowNetwork: boolean;
	workspaceGranted: boolean;
	readOnlyPaths: string[];
	readWritePaths: string[];
	protectedPaths: string[];
	autoApprovedCommands: string[];
};

type ToolPathRequest = {
	path: string;
	absolutePath: string;
	access: PathAccess;
	toolName: string;
};

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULTS_PATH = path.join(EXTENSION_DIR, "defaults.json");
const CONFIG_NAME = "nono-sandbox.json";
const APPLIED_ENV = "PI_NONO_TS_SANDBOX_APPLIED";
const STATE_ENV = "PI_NONO_TS_SANDBOX_STATE";
const POLICY_ENV = "PI_NONO_TS_SANDBOX_POLICY";
const NOTE_ENV = "PI_NONO_TS_SANDBOX_NOTE";

function unique(values: string[]): string[] {
	return [...new Set(values.filter(Boolean))];
}

function collapseHome(input: string): string {
	const home = os.homedir();
	return input === home || input.startsWith(`${home}${path.sep}`) ? `~${input.slice(home.length)}` : input;
}

function isWithin(base: string, target: string): boolean {
	const rel = relative(base, target);
	return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function expandPath(input: string, baseDir: string): string {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	if (trimmed === "~") return os.homedir();
	if (trimmed.startsWith("~/")) return resolve(os.homedir(), trimmed.slice(2));
	return path.isAbsolute(trimmed) ? resolve(trimmed) : resolve(baseDir, trimmed);
}

function readJsonFile<T>(filePath: string): Partial<T> {
	if (!existsSync(filePath)) return {};
	try {
		return JSON.parse(readFileSync(filePath, "utf8")) as Partial<T>;
	} catch {
		return {};
	}
}

function mergeConfig(base: Required<SandboxConfig>, override: Partial<SandboxConfig>): Required<SandboxConfig> {
	return {
		enabled: override.enabled ?? base.enabled,
		skipIfCwdIsHome: override.skipIfCwdIsHome ?? base.skipIfCwdIsHome,
		allowNetwork: override.allowNetwork ?? base.allowNetwork,
		readOnlyPaths: unique([...(base.readOnlyPaths ?? []), ...(override.readOnlyPaths ?? [])]),
		readWritePaths: unique([...(base.readWritePaths ?? []), ...(override.readWritePaths ?? [])]),
		protectedPaths: unique([...(base.protectedPaths ?? []), ...(override.protectedPaths ?? [])]),
		dangerousCommandPatterns: unique([
			...(base.dangerousCommandPatterns ?? []),
			...(override.dangerousCommandPatterns ?? []),
		]),
		alwaysAllowCommands: unique([...(base.alwaysAllowCommands ?? []), ...(override.alwaysAllowCommands ?? [])]),
	};
}

function loadDefaults(): Required<SandboxConfig> {
	return mergeConfig(
		{
			enabled: true,
			skipIfCwdIsHome: true,
			allowNetwork: true,
			readOnlyPaths: [],
			readWritePaths: [],
			protectedPaths: [],
			dangerousCommandPatterns: [],
			alwaysAllowCommands: [],
		},
		readJsonFile<SandboxConfig>(DEFAULTS_PATH),
	);
}

function getConfigPaths(cwd: string) {
	const agentDir = getAgentDir();
	return {
		global: path.join(agentDir, CONFIG_NAME),
		project: path.join(cwd, ".pi", CONFIG_NAME),
	};
}

function loadConfig(cwd: string): { config: Required<SandboxConfig>; files: string[] } {
	const defaults = loadDefaults();
	const paths = getConfigPaths(cwd);
	const globalConfig = readJsonFile<SandboxConfig>(paths.global);
	const projectConfig = readJsonFile<SandboxConfig>(paths.project);
	return {
		config: mergeConfig(mergeConfig(defaults, globalConfig), projectConfig),
		files: [DEFAULTS_PATH, paths.global, paths.project].filter((filePath) => existsSync(filePath)),
	};
}

function compileDangerousPatterns(config: Required<SandboxConfig>): RegExp[] {
	const patterns: RegExp[] = [];
	for (const pattern of config.dangerousCommandPatterns) {
		try {
			patterns.push(new RegExp(pattern, "i"));
		} catch {
			// Ignore invalid regexes in user config.
		}
	}
	return patterns;
}

function cleanToolPath(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	return trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
}

function getToolPathRequest(event: { toolName: string; input: Record<string, unknown> }, cwd: string): ToolPathRequest | undefined {
	const rawPath = cleanToolPath(event.input.path);
	if (!rawPath) return undefined;

	if (event.toolName === "read") {
		return { path: rawPath, absolutePath: expandPath(rawPath, cwd), access: "read", toolName: event.toolName };
	}
	if (event.toolName === "write") {
		return { path: rawPath, absolutePath: expandPath(rawPath, cwd), access: "write", toolName: event.toolName };
	}
	if (event.toolName === "edit") {
		return { path: rawPath, absolutePath: expandPath(rawPath, cwd), access: "readwrite", toolName: event.toolName };
	}
	return undefined;
}

function accessToMode(access: PathAccess): AccessMode {
	switch (access) {
		case "read":
			return AccessMode.Read;
		case "write":
			return AccessMode.Write;
		case "readwrite":
			return AccessMode.ReadWrite;
	}
}

function accessLabel(access: PathAccess): string {
	switch (access) {
		case "read":
			return "read";
		case "write":
			return "write";
		case "readwrite":
			return "read/write";
	}
}

function choosePersistScope(cwd: string, absolutePath?: string): "project" | "global" {
	if (resolve(cwd) === resolve(os.homedir())) return "global";
	if (!absolutePath) return "project";
	return isWithin(cwd, absolutePath) ? "project" : "global";
}

function getStoredPath(cwd: string, scope: "project" | "global", absolutePath: string): string {
	if (scope === "project" && isWithin(cwd, absolutePath)) {
		return relative(cwd, absolutePath) || ".";
	}
	return collapseHome(absolutePath);
}

function persistPathGrant(cwd: string, absolutePath: string, access: PathAccess, scope?: "project" | "global"): string {
	const resolvedScope = scope ?? choosePersistScope(cwd, absolutePath);
	const paths = getConfigPaths(cwd);
	const targetFile = resolvedScope === "project" ? paths.project : paths.global;
	mkdirSync(dirname(targetFile), { recursive: true });

	const current = readJsonFile<SandboxConfig>(targetFile);
	const key = access === "read" ? "readOnlyPaths" : "readWritePaths";
	const next = {
		...current,
		[key]: unique([...(current[key] ?? []), getStoredPath(cwd, resolvedScope, absolutePath)]),
	};
	writeFileSync(targetFile, JSON.stringify(next, null, 2) + "\n", "utf8");
	return targetFile;
}

function getRuntimeReadPaths(): string[] {
	const home = os.homedir();
	const envPath = process.env.PATH ?? "";
	const pathEntries = envPath.split(path.delimiter).filter(Boolean);
	return unique(
		[
			process.execPath,
			dirname(process.execPath),
			"/bin",
			"/sbin",
			"/usr",
			"/etc",
			"/private/etc",
			"/System",
			"/Library",
			"/Applications",
			"/opt/homebrew",
			"/private/tmp",
			"/private/var/folders",
			"/var/folders",
			path.join(home, ".local", "share", "mise"),
			path.join(home, ".cargo"),
			path.join(home, ".rustup"),
			path.join(home, ".bun"),
			path.join(home, ".nix-profile"),
			path.join(home, ".local", "bin"),
			path.join(home, "go"),
			"/nix",
			...pathEntries,
		].filter((candidate) => existsSync(candidate)).map((candidate) => resolve(candidate)),
	);
}

function grantExistingPath(caps: CapabilitySet, target: string, mode: AccessMode): string | undefined {
	let current = resolve(target);
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}

	try {
		const stat = statSync(current);
		if (stat.isDirectory()) {
			caps.allowPath(current, mode);
			return current;
		}
		if (stat.isFile() || stat.isCharacterDevice() || stat.isBlockDevice() || stat.isFIFO() || stat.isSocket()) {
			caps.allowFile(current, mode);
			return current;
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function addExecSupport(caps: CapabilitySet) {
	try {
		caps.platformRule("(allow process-exec)");
	} catch {
		// Linux ignores platform rules; macOS may reject malformed rules.
	}
}

function getSandboxCompatibleBashOps(): BashOperations {
	return {
		exec(command, cwd, { onData, signal, timeout, env }) {
			const shell = existsSync("/bin/bash") ? "/bin/bash" : "sh";
			return new Promise((resolveExec, rejectExec) => {
				if (signal?.aborted) {
					rejectExec(new Error("aborted"));
					return;
				}
				const result = spawnSync(shell, ["-c", command], {
					cwd,
					env: env ?? process.env,
					encoding: "buffer",
					timeout: timeout && timeout > 0 ? timeout * 1000 : undefined,
					maxBuffer: 10 * 1024 * 1024,
				});
				if (result.stdout?.length) onData(result.stdout);
				if (result.stderr?.length) onData(result.stderr);
				if (result.error) {
					const message = result.error.message || String(result.error);
					if (message.includes("ETIMEDOUT")) {
						rejectExec(new Error(`timeout:${timeout}`));
						return;
					}
					rejectExec(result.error);
					return;
				}
				resolveExec({ exitCode: result.status });
			});
		},
	};
}

function buildSandbox(cwd: string, config: Required<SandboxConfig>, configFiles: string[]) {
	const info = supportInfo();
	if (!info.isSupported) {
		return {
			active: false,
			reason: info.details,
			policy: {
				active: false,
				reason: info.details,
				cwd,
				configFiles: configFiles.map(collapseHome),
				allowNetwork: config.allowNetwork,
				workspaceGranted: false,
				readOnlyPaths: [],
				readWritePaths: [],
				protectedPaths: config.protectedPaths.map((value) => collapseHome(expandPath(value, cwd))).sort(),
				autoApprovedCommands: config.alwaysAllowCommands.map((value) => value.trim()).filter(Boolean).sort(),
			} satisfies EffectivePolicy,
		};
	}

	if (!config.enabled) {
		return {
			active: false,
			reason: "disabled in config",
			policy: {
				active: false,
				reason: "disabled in config",
				cwd,
				configFiles: configFiles.map(collapseHome),
				allowNetwork: config.allowNetwork,
				workspaceGranted: false,
				readOnlyPaths: [],
				readWritePaths: [],
				protectedPaths: config.protectedPaths.map((value) => collapseHome(expandPath(value, cwd))).sort(),
				autoApprovedCommands: config.alwaysAllowCommands.map((value) => value.trim()).filter(Boolean).sort(),
			} satisfies EffectivePolicy,
		};
	}

	const caps = new CapabilitySet();
	const readOnlyPaths: string[] = [];
	const readWritePaths: string[] = [];
	const workspaceGranted = !(config.skipIfCwdIsHome && resolve(cwd) === resolve(os.homedir()));

	for (const runtimePath of getRuntimeReadPaths()) {
		const granted = grantExistingPath(caps, runtimePath, AccessMode.Read);
		if (granted) readOnlyPaths.push(collapseHome(granted));
	}

	for (const writablePath of unique([getAgentDir(), os.tmpdir(), "/tmp", "/private/tmp"])) {
		const granted = grantExistingPath(caps, writablePath, AccessMode.ReadWrite);
		if (granted) readWritePaths.push(collapseHome(granted));
	}

	if (workspaceGranted) {
		const granted = grantExistingPath(caps, cwd, AccessMode.ReadWrite);
		if (granted) readWritePaths.push(collapseHome(granted));
	}

	for (const configuredPath of config.readOnlyPaths) {
		const granted = grantExistingPath(caps, expandPath(configuredPath, cwd), AccessMode.Read);
		if (granted) readOnlyPaths.push(collapseHome(granted));
	}

	for (const configuredPath of config.readWritePaths) {
		const granted = grantExistingPath(caps, expandPath(configuredPath, cwd), AccessMode.ReadWrite);
		if (granted) readWritePaths.push(collapseHome(granted));
	}

	caps.deduplicate();
	if (!config.allowNetwork) caps.blockNetwork();
	addExecSupport(caps);

	const policy: EffectivePolicy = {
		active: true,
		cwd,
		configFiles: configFiles.map(collapseHome),
		allowNetwork: config.allowNetwork,
		workspaceGranted,
		readOnlyPaths: unique(readOnlyPaths).sort(),
		readWritePaths: unique(readWritePaths).sort(),
		protectedPaths: config.protectedPaths.map((value) => collapseHome(expandPath(value, cwd))).sort(),
		autoApprovedCommands: config.alwaysAllowCommands.map((value) => value.trim()).filter(Boolean).sort(),
	};

	return {
		active: true,
		caps,
		query: new QueryContext(caps),
		stateJson: SandboxState.fromCaps(caps).toJson(),
		policy,
	};
}

function formatPolicy(policy: EffectivePolicy): string {
	const block = (title: string, values: string[]) => [title, ...(values.length > 0 ? values.map((value) => `  - ${value}`) : ["  - (none)"])];
	return [
		`Sandbox: ${policy.active ? "strict nono-ts process sandbox" : "inactive"}`,
		policy.reason ? `Reason: ${policy.reason}` : undefined,
		`Network: ${policy.allowNetwork ? "allowed" : "blocked"}`,
		`Workspace granted: ${policy.workspaceGranted ? "yes" : "no"}`,
		"",
		...block("Read/write", policy.readWritePaths),
		"",
		...block("Read-only", policy.readOnlyPaths),
		"",
		...block("Protected", policy.protectedPaths),
		"",
		...block("Auto-approved dangerous commands", policy.autoApprovedCommands),
		"",
		...block("Config", policy.configFiles),
		"",
		"Notes:",
		"  - This sandbox is process-wide and OS-enforced.",
		"  - New grants require a full Pi restart.",
	]
		.filter(Boolean)
		.join("\n");
}

export default function (pi: ExtensionAPI) {
	let query: QueryContext | undefined;
	let policy: EffectivePolicy | undefined;
	let dangerousPatterns: RegExp[] = [];
	let autoApprovedCommands = new Set<string>();
	let sandboxActive = process.env[APPLIED_ENV] === "1";

	const restoreAppliedState = () => {
		const stateJson = process.env[STATE_ENV];
		const policyJson = process.env[POLICY_ENV];
		if (stateJson) {
			try {
				query = new QueryContext(SandboxState.fromJson(stateJson).toCaps());
				sandboxActive = true;
			} catch {
				query = undefined;
				sandboxActive = false;
			}
		}
		if (policyJson) {
			try {
				policy = JSON.parse(policyJson) as EffectivePolicy;
			} catch {
				policy = undefined;
			}
		}
	};

	const setSandboxStatus = (ctx: any) => {
		if (sandboxActive && policy) {
			const cwdLabel = collapseHome(policy.cwd);
			const workspace = policy.workspaceGranted ? cwdLabel : `${cwdLabel} (not granted)`;
			const network = policy.allowNetwork ? "network allowed" : "network blocked";
			ctx.ui.setStatus("nono-sandbox:top-left", ctx.ui.theme.fg("accent", `sandbox ${workspace}`));
			ctx.ui.setStatus("nono-sandbox-details:top-left", ctx.ui.theme.fg("muted", network));
			ctx.ui.setStatus("nono-sandbox:bottom-left", undefined);
			return;
		}
		ctx.ui.setStatus("nono-sandbox:top-left", ctx.ui.theme.fg("warning", "sandbox inactive"));
		ctx.ui.setStatus("nono-sandbox-details:top-left", ctx.ui.theme.fg("muted", "Pi is running without sandbox enforcement"));
		ctx.ui.setStatus("nono-sandbox:bottom-left", undefined);
	};

	restoreAppliedState();

	const sandboxCompatibleBash = createBashTool(process.cwd(), {
		operations: getSandboxCompatibleBashOps(),
	});

	pi.registerTool({
		...sandboxCompatibleBash,
		label: "bash",
	});

	pi.on("session_start", async (_event, ctx) => {
		const loaded = loadConfig(ctx.cwd);
		dangerousPatterns = compileDangerousPatterns(loaded.config);
		autoApprovedCommands = new Set(loaded.config.alwaysAllowCommands.map((value) => value.trim()).filter(Boolean));

		if (!sandboxActive) {
			const built = buildSandbox(ctx.cwd, loaded.config, loaded.files);
			policy = built.policy;

			if (built.active && built.caps && built.query && built.stateJson) {
				try {
					apply(built.caps);
					query = built.query;
					sandboxActive = true;
					process.env[APPLIED_ENV] = "1";
					process.env[STATE_ENV] = built.stateJson;
					process.env[POLICY_ENV] = JSON.stringify(built.policy);
					process.env[NOTE_ENV] = "Strict nono-ts sandbox applied. Restart Pi to change grants.";
				} catch (error) {
					sandboxActive = false;
					query = undefined;
					policy = {
						...built.policy,
						active: false,
						reason: error instanceof Error ? error.message : String(error),
					};
				}
			}
		}

		if (sandboxActive && !policy) {
			restoreAppliedState();
		}

		setSandboxStatus(ctx);
		if (!sandboxActive && policy?.reason) {
			ctx.ui.notify(`Sandbox inactive: ${policy.reason}`, "warning");
		}
	});

	pi.on("before_agent_start", async (event, _ctx) => {
		if (!sandboxActive || !policy) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\nSandbox policy:\n- This Pi process runs inside a strict nono-ts OS sandbox.\n- Access outside granted paths will fail.\n- New filesystem grants require a full Pi restart.\n- Avoid unnecessary writes outside the workspace.`,
		};
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "bash") {
			const command = typeof event.input.command === "string" ? event.input.command.trim() : "";
			if (!command) return;
			if (autoApprovedCommands.has(command)) return;
			const dangerous = dangerousPatterns.some((pattern) => pattern.test(command));
			if (!dangerous) return;
			if (!ctx.hasUI) {
				return { block: true, reason: "Dangerous command blocked (no UI available)" };
			}
			const ok = await ctx.ui.confirm("Dangerous command", `Allow this command?\n\n${command}`);
			if (!ok) return { block: true, reason: "Blocked by user" };
			return;
		}

		if (event.toolName !== "read" && event.toolName !== "write" && event.toolName !== "edit") return;
		if (!policy || !query) return;

		const request = getToolPathRequest(event as { toolName: string; input: Record<string, unknown> }, ctx.cwd);
		if (!request) return;

		const protectedPath = policy.protectedPaths.find((value) => isWithin(expandPath(value, ctx.cwd), request.absolutePath));
		const result = query.queryPath(request.absolutePath, accessToMode(request.access));
		const outsideWorkspace = !isWithin(ctx.cwd, request.absolutePath) && !isWithin(getAgentDir(), request.absolutePath);

		if (result.status === "allowed" && !protectedPath) {
			if ((request.access === "write" || request.access === "readwrite") && outsideWorkspace && ctx.hasUI) {
				const ok = await ctx.ui.confirm(
					"Write outside workspace",
					`${request.toolName} wants to modify:\n\n${collapseHome(request.absolutePath)}\n\nThis path is allowed by sandbox policy. Proceed?`,
				);
				if (!ok) return { block: true, reason: "Blocked by user" };
			}
			return;
		}

		if (!ctx.hasUI) {
			return { block: true, reason: `Sandbox denied ${accessLabel(request.access)} access to ${collapseHome(request.absolutePath)}` };
		}

		const messageLines = [
			`${request.toolName} needs ${accessLabel(request.access)} access to:`,
			"",
			collapseHome(request.absolutePath),
			"",
		];
		if (protectedPath) {
			messageLines.push(`Protected path match: ${collapseHome(protectedPath)}`, "");
		}
		if (result.status !== "allowed") {
			messageLines.push(`Current sandbox denies it: ${result.reason}`, "");
		}
		messageLines.push("You can save a future grant, but the current Pi process cannot be expanded.");

		const choices = [
			choosePersistScope(ctx.cwd, request.absolutePath) === "project"
				? "Save for this project (restart Pi)"
				: undefined,
			"Save globally (restart Pi)",
			"Keep blocked",
		].filter(Boolean) as string[];

		const choice = await ctx.ui.select(messageLines.join("\n"), choices);
		if (choice === "Save for this project (restart Pi)" || choice === "Save globally (restart Pi)") {
			const scope = choice.includes("project") ? "project" : "global";
			const filePath = persistPathGrant(ctx.cwd, request.absolutePath, request.access, scope);
			ctx.ui.notify(`Saved grant to ${collapseHome(filePath)}. Restart Pi to apply it.`, "warning");
		}

		return { block: true, reason: `Sandbox denied ${accessLabel(request.access)} access to ${collapseHome(request.absolutePath)}` };
	});

	pi.on("user_bash", async (event, ctx) => {
		const command = (event.command ?? "").trim();
		if (!command) return { operations: getSandboxCompatibleBashOps() };
		if (autoApprovedCommands.has(command)) return { operations: getSandboxCompatibleBashOps() };
		const dangerous = dangerousPatterns.some((pattern) => pattern.test(command));
		if (!dangerous) return { operations: getSandboxCompatibleBashOps() };
		if (!ctx.hasUI) {
			return {
				result: {
					output: "Blocked dangerous shell command (no UI available)",
					exitCode: 1,
					cancelled: false,
					truncated: false,
				},
			};
		}
		const ok = await ctx.ui.confirm("Dangerous shell command", `Run this command?\n\n${command}`);
		if (!ok) {
			return {
				result: {
					output: "Blocked by user",
					exitCode: 1,
					cancelled: false,
					truncated: false,
				},
			};
		}
		return { operations: getSandboxCompatibleBashOps() };
	});

	pi.registerCommand("sandbox", {
		description: "Show current strict nono-ts sandbox policy",
		handler: async (_args, ctx) => {
			if (!policy) {
				const loaded = loadConfig(ctx.cwd);
				policy = buildSandbox(ctx.cwd, loaded.config, loaded.files).policy;
			}
			ctx.ui.notify(formatPolicy(policy), sandboxActive ? "info" : "warning");
		},
	});

	pi.registerCommand("sandbox-allow", {
		description: "Persist a filesystem grant for the next Pi launch",
		handler: async (args, ctx) => {
			let requestedPath = args?.trim();
			if (!requestedPath && ctx.hasUI) {
				requestedPath = await ctx.ui.input("Path to allow next launch", "relative or absolute path");
			}
			if (!requestedPath) {
				ctx.ui.notify("No path provided", "warning");
				return;
			}

			const accessChoice = ctx.hasUI ? await ctx.ui.select("Access level", ["Read only", "Read + write"]) : undefined;
			const access: PathAccess = accessChoice === "Read + write" ? "readwrite" : "read";
			const absolutePath = expandPath(requestedPath, ctx.cwd);
			const scopeChoice = ctx.hasUI
				? await ctx.ui.select("Save where?", [
					choosePersistScope(ctx.cwd, absolutePath) === "project" ? "Project config" : undefined,
					"Global config",
				].filter(Boolean) as string[])
				: undefined;
			const scope = scopeChoice === "Global config" ? "global" : choosePersistScope(ctx.cwd, absolutePath);
			const filePath = persistPathGrant(ctx.cwd, absolutePath, access, scope);
			ctx.ui.notify(`Saved ${accessLabel(access)} grant to ${collapseHome(filePath)}. Restart Pi to apply it.`, "warning");
		},
	});
}
