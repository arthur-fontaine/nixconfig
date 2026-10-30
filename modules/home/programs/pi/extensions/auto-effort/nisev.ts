// The Nisev provider: the fine-tuned classifier, served by llama.cpp. Pure helpers.
import { type Config, NISEV } from "./policy.ts";

// `llama` is llama.cpp's unified CLI, whose server is `llama serve`; it takes the same flags.
export function serverCommand(binary: string) {
	return /(^|\/)llama$/.test(binary) ? [binary, "serve"] : [binary];
}

export function serverArgs(config: Pick<Config, "model" | "port">, binary: string) {
	const model = config.model ?? NISEV.model;
	const source = /\.gguf$/i.test(model) ? ["-m", model] : ["-hf", model];
	return [
		...serverCommand(binary),
		...source,
		"--host",
		"127.0.0.1",
		"--port",
		String(config.port),
		"--alias",
		NISEV.alias,
		// Prompts are at most about 1,300 tokens; two slots let two prompts run at once.
		"-c",
		"8192",
		"-np",
		"2",
	];
}

// `llama-server --version` prints e.g. "version: 0.5.0-dev (build 11408, commit 9f12cd4a4)".
export function parseBuild(output: string) {
	const match = output.match(/build (\d+)/);
	return match ? Number(match[1]) : null;
}

// What a piece of llama-server's output says about its start: { ready }, { percent } or {}.
export function parseServerOutput(text: string): { ready?: true; percent?: number } {
	if (/listening on/i.test(text)) return { ready: true };
	const percent = /download/i.test(text) && text.match(/(\d{1,3}(?:\.\d+)?)%/);
	return percent ? { percent: Math.round(Number(percent[1])) } : {};
}

// True when /v1/models lists our alias, whoever started the server.
export function servesOurModel(text: string) {
	try {
		return ((JSON.parse(text).data ?? []) as { id?: string }[]).some((m) => m.id === NISEV.alias);
	} catch {
		return false;
	}
}
