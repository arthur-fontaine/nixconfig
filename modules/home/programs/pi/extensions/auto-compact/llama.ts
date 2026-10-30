// The Spisev provider: spisev-alpha, the distilled classifier served by llama.cpp's llama-server.
// Pure helpers; index.ts makes the calls.

import { SPISEV } from "./policy.ts";

// `llama` is llama.cpp's unified CLI, whose server is `llama serve`; it takes the same flags.
export function serverCommand(binary: string) {
	return /(^|\/)llama$/.test(binary) ? [binary, "serve"] : [binary];
}

export function serverArgs(config: { model?: string; port?: number | null }, binary: string) {
	const model = config.model ?? SPISEV.model;
	const source = /\.gguf$/i.test(model) ? ["-m", model] : ["-hf", model];
	return [
		...serverCommand(binary), ...source,
		"--host", "127.0.0.1", "--port", String(config.port),
		"--alias", SPISEV.alias,
		// States are at most 12k tokens; one slot keeps the prompt cache for the session's prefix.
		"-c", "16384", "-np", "1",
	];
}

export function parseBuild(output: string) {
	const m = output.match(/build (\d+)/);
	return m ? Number(m[1]) : null;
}

export function parseServerOutput(text: string): { ready?: true; percent?: number } {
	if (/listening on/i.test(text)) return { ready: true };
	const percent = /download/i.test(text) && text.match(/(\d{1,3}(?:\.\d+)?)%/);
	return percent ? { percent: Math.round(Number(percent[1])) } : {};
}

export function servesOurModel(text: string) {
	try {
		return ((JSON.parse(text).data ?? []) as { id?: string }[]).some((m) => m.id === SPISEV.alias);
	} catch {
		return false;
	}
}
