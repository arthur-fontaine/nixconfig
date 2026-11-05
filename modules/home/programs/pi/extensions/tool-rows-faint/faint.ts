// Faint text (SGR 2) that survives the styles inside it: a bold's end (22) and a reset (0)
// also end faint, so faint is turned on again right after each of them.
const SGR = /\x1b\[([\d;]*)m/g;
const ON = "\x1b[2m";
const OFF = "\x1b[22m";
// Inline images (kitty, iTerm2) are left as they are.
const IMAGE = /\x1b_G|\x1b\]1337;/;

export function faint(line: string): string {
	if (!line || IMAGE.test(line)) return line;
	const body = line.replace(SGR, (code, params: string) =>
		params.split(";").some((p) => p === "" || p === "0" || p === "22") ? code + ON : code,
	);
	return ON + body + OFF;
}
