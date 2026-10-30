// `@<session>` in the editor: completion of the sessions pi-intercom sees, and finding the
// sessions a message is addressed to.

export interface Peer {
	name: string;
	cwd: string;
	status?: string;
	unnamed?: boolean;
}

// The `@…` word ending at the cursor, as Pi's own file completion reads it.
export function mentionAt(line: string, col: number): string | undefined {
	const match = /(?:^|\s)(@[^\s@]*)$/.exec(line.slice(0, col));
	return match?.[1];
}

export function matchingPeers(peers: Peer[], token: string): Peer[] {
	const query = token.slice(1).toLowerCase();
	return peers
		.filter((p) => p.name.toLowerCase().startsWith(query))
		.sort((a, b) => Number(a.unnamed ?? false) - Number(b.unnamed ?? false) || a.name.localeCompare(b.name));
}

// Trailing punctuation belongs to the sentence, not the name: "@api-worker, can you…".
const MENTION = /(?:^|\s)@([^\s@]+?)[.,:;!?)]*(?=\s|$)/g;

// The live sessions a message mentions, and the text to send them. Mentions at the start are
// only the address and are dropped; mentions inside the sentence stay as written.
export function addressees(text: string, peers: Peer[]): { to: string[]; message: string } | undefined {
	const byName = new Map(peers.map((p) => [p.name.toLowerCase(), p.name]));
	const to: string[] = [];
	for (const match of text.matchAll(MENTION)) {
		const name = byName.get(match[1]!.toLowerCase());
		if (name && !to.includes(name)) to.push(name);
	}
	if (to.length === 0) return undefined;
	let message = text;
	for (let lead = /^\s*@([^\s@]+?)[,:]?(?:\s+|$)/.exec(message); lead && byName.has(lead[1]!.toLowerCase()); lead = /^\s*@([^\s@]+?)[,:]?(?:\s+|$)/.exec(message)) {
		message = message.slice(lead[0].length);
	}
	message = message.trim();
	return message ? { to, message } : undefined;
}
