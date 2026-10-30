// Pi's tools as the Claude apps know Claude Code's: they render a tool call by
// its Claude Code name and input (Read shows its file and image, Edit a diff),
// and some results by the tool's structured output (`tool_use_result`).
// Display only: Pi still runs its own tools.

type Args = Record<string, any>;

const defined = (input: Args) => Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));

export function claudeToolUse(name: string, args: Args): { name: string; input: Args } {
	switch (name) {
		case "read":
			return { name: "Read", input: defined({ file_path: args.path, offset: args.offset, limit: args.limit }) };
		case "write":
			return { name: "Write", input: { file_path: args.path, content: args.content } };
		case "edit": {
			const edits: { oldText: string; newText: string }[] = Array.isArray(args.edits) ? args.edits : [];
			if (edits.length === 1) return { name: "Edit", input: { file_path: args.path, old_string: edits[0]!.oldText, new_string: edits[0]!.newText } };
			return { name: "MultiEdit", input: { file_path: args.path, edits: edits.map((e) => ({ old_string: e.oldText, new_string: e.newText })) } };
		}
		case "bash":
			return { name: "Bash", input: { command: args.command } };
		case "grep":
			return { name: "Grep", input: defined({ pattern: args.pattern, path: args.path, glob: args.glob, "-i": args.ignoreCase, "-C": args.context, head_limit: args.limit }) };
		case "find":
			return { name: "Glob", input: defined({ pattern: args.pattern, path: args.path }) };
		case "ls":
			return { name: "LS", input: defined({ path: args.path }) };
		case "ask_user_question":
			return { name: "AskUserQuestion", input: args };
		case "send_user_file":
			return { name: "SendUserFile", input: args };
		default:
			return { name, input: args };
	}
}

// Width and height from an image's header, for Read's tool_use_result.
export function imageSize(data: Buffer): { width: number; height: number } | undefined {
	if (data.length >= 24 && data.readUInt32BE(0) === 0x89504e47) return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
	if (data.length >= 10 && data.toString("ascii", 0, 3) === "GIF") return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
	if (data.length >= 30 && data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WEBP") {
		const chunk = data.toString("ascii", 12, 16);
		if (chunk === "VP8X") return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
		if (chunk === "VP8L") {
			const bits = data.readUInt32LE(21);
			return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
		}
		if (chunk === "VP8 ") return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
	}
	if (data.length >= 4 && data[0] === 0xff && data[1] === 0xd8) {
		for (let i = 2; i + 9 < data.length; ) {
			if (data[i] !== 0xff) return undefined;
			const marker = data[i + 1]!;
			const length = data.readUInt16BE(i + 2);
			// SOF0–SOF15, except DHT (c4), JPG (c8) and DAC (cc).
			if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
				return { width: data.readUInt16BE(i + 7), height: data.readUInt16BE(i + 5) };
			}
			i += 2 + length;
		}
	}
	return undefined;
}

// The structured output Claude Code attaches to a tool result, where the apps use one.
export function claudeToolUseResult(toolName: string, content: any[], details: unknown): unknown {
	if (toolName === "send_user_file") return details;
	if (toolName === "read") {
		const image = content.find((c) => c?.type === "image");
		if (!image) return undefined;
		const data = Buffer.from(image.data, "base64");
		const size = imageSize(data);
		return {
			type: "image",
			file: {
				base64: image.data,
				type: image.mimeType,
				originalSize: data.length,
				...(size && { dimensions: { originalWidth: size.width, originalHeight: size.height, displayWidth: size.width, displayHeight: size.height } }),
			},
		};
	}
	return undefined;
}

const MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	pdf: "application/pdf",
	html: "text/html",
	htm: "text/html",
	md: "text/markdown",
	txt: "text/plain",
	json: "application/json",
	csv: "text/csv",
	zip: "application/zip",
	mp4: "video/mp4",
	mov: "video/quicktime",
	mp3: "audio/mpeg",
	wav: "audio/wav",
};

export function mimeType(file: string) {
	return MIME[file.toLowerCase().split(".").pop() ?? ""] ?? "application/octet-stream";
}

// SendUserFile's own test for a picture (its mUt), by extension.
export const isImageFile = (file: string) => /\.(png|jpe?g|gif|webp)$/i.test(file);
