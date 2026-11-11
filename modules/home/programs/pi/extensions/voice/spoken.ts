// The spoken version of Pi's written answer, made beside it (DESIGN.md, "The two outputs").
// Nothing here touches the main model's prompt or messages: the written answer stays exactly
// what Pi produces. Text blocks are cut from the streamed answer; a short plain block is spoken
// as it is, anything with code, paths, lists or tables goes through Claude Haiku (Pi's own
// claude-code provider, as bash-titles does), which says the gist in speech.

export const PROMPT = `Tu transformes la réponse écrite d'un assistant de code en ce qu'il dirait à voix haute à son utilisateur, comme le mode vocal de Claude ou ChatGPT.
Règles : garde la langue de la réponse. Phrases courtes et naturelles, à l'oral. Dis l'essentiel : ce qui a été trouvé ou fait, et la question posée s'il y en a une. Ne lis jamais de code, de chemin complet, de hash ni de liste à puces : résume-les (« j'ai modifié le fichier du footer et ses tests »). Pas de markdown, pas d'emoji. Au plus quatre phrases. Réponds seulement avec le texte à dire. S'il n'y a rien d'important à ajouter à ce qui a déjà été dit, réponds par un texte vide.`;

/** Said when Haiku can't make the spoken version (quota, offline): Q6. */
export const ON_SCREEN = { fr: "La réponse est à l'écran.", en: "The answer is on the screen." };

const PLAIN_MAX = 200;

/** A block Pi wrote that can be said as it is: short, one paragraph, no code, path, list, table, link or URL. */
export function isPlain(block: string): boolean {
	const text = block.trim();
	if (!text || text.length > PLAIN_MAX) return false;
	if (text.includes("\n")) return false;
	if (/`|\*\*|__|\[.+\]\(|https?:\/\/|^[#>|-]|^\d+\.\s|\|/.test(text)) return false;
	if (/(^|\s)(\.{0,2}\/|~\/)?[\w.-]+\/[\w./-]+/.test(text)) return false; // a path
	if (/\b[\w-]+\.(ts|js|py|nix|json|md|sh|swift|toml|yaml|yml|lock)\b/.test(text)) return false;
	if (/\b[0-9a-f]{7,40}\b/.test(text)) return false; // a hash
	return true;
}

/** Sentences of a plain block, for the TTS (one at a time). */
export function sentences(text: string): string[] {
	return text
		.replace(/\s+/g, " ")
		.split(/(?<=[.!?…])\s+(?=[A-ZÀ-ÖØ-Ý«"])/)
		.map((s) => s.trim())
		.filter(Boolean);
}

/**
 * Cuts the streamed text of an assistant message into blocks: a block ends at a blank line
 * (outside a code fence), or when the text before a tool call or the end of the message is
 * flushed.
 */
export class Blocks {
	private text = "";
	private sent = 0;

	/** Appends streamed text; returns the blocks it completed. */
	push(delta: string): string[] {
		this.text += delta;
		const out: string[] = [];
		let i = this.sent;
		let fence = false;
		for (const m of this.text.slice(0, this.sent).matchAll(/```/g)) fence = !fence;
		while (i < this.text.length) {
			const nl = this.text.indexOf("\n", i);
			if (nl === -1) break;
			const line = this.text.slice(i, nl);
			if (line.trimStart().startsWith("```")) fence = !fence;
			if (!fence && line.trim() === "" && this.text.slice(this.sent, i).trim()) {
				out.push(this.text.slice(this.sent, nl).trim());
				this.sent = nl + 1;
			}
			i = nl + 1;
		}
		return out;
	}

	/** What's left, at the end of the message or before a tool call. */
	flush(): string | undefined {
		const rest = this.text.slice(this.sent).trim();
		this.sent = this.text.length;
		return rest || undefined;
	}
}

export function languageOf(text: string): "fr" | "en" {
	const fr = (text.match(/\b(le|la|les|un|une|des|est|et|je|tu|que|pour|avec|dans|pas|du|ce|fichier)\b/gi) ?? []).length;
	const en = (text.match(/\b(the|a|is|and|i|you|that|for|with|in|not|of|this|file)\b/gi) ?? []).length;
	return fr >= en ? "fr" : "en";
}

/** The request for Haiku: the new written part, after what was already said for this answer. */
export function request(written: string, alreadySaid: string): string {
	return (alreadySaid ? `Déjà dit à voix haute pour cette réponse : « ${alreadySaid} »\n\n` : "") + `Réponse écrite :\n${written}`;
}
