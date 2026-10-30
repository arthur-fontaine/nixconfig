// CSI (colors) and OSC (links) sequences; the rest of the text is what's compared.
const ESCAPES = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/gu;
const stripTerminalSequences = (line: string) => line.replace(ESCAPES, "");

const ONBOARDING = "Pi can explain its own features";

// Drops the onboarding paragraph (however it wrapped) and the blank line above it.
export function withoutOnboarding(lines: string[]): string[] {
	const plain = lines.map((line) => stripTerminalSequences(line).trim());
	const start = plain.findIndex((line) => line.startsWith(ONBOARDING));
	if (start < 0) return lines;
	let end = start;
	while (end < lines.length && plain[end] !== "") end++;
	const from = start > 0 && plain[start - 1] === "" ? start - 1 : start;
	return [...lines.slice(0, from), ...lines.slice(end)];
}
