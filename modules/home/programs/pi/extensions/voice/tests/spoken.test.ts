import assert from "node:assert/strict";
import { test } from "node:test";
import { Blocks, isPlain, languageOf, request, sentences } from "../spoken.ts";

test("short plain text is said as it is", () => {
	assert.ok(isPlain("Je regarde le footer."));
	assert.ok(isPlain("Done. The daemon now listens on a socket."));
});

test("code, paths, lists, tables, links, hashes and long text go through Haiku", () => {
	for (const text of [
		"Lance `pnpm test`.",
		"J'ai modifié modules/home/programs/pi/default.nix.",
		"J'ai modifié layout.ts.",
		"- un\n- deux",
		"1. un",
		"| a | b |",
		"Voir [la doc](https://x.y).",
		"Le commit 9af1b0f a renommé la clé.",
		"## Résumé",
		"x".repeat(250),
		"Une ligne.\nUne autre.",
	])
		assert.equal(isPlain(text), false, text);
});

test("sentences split for the TTS", () => {
	assert.deepEqual(sentences("D'accord. Je lance le build ! Ça marche ?"), ["D'accord.", "Je lance le build !", "Ça marche ?"]);
	assert.deepEqual(sentences("v1.2 est sortie."), ["v1.2 est sortie."]);
});

test("blocks end at blank lines, not inside code fences", () => {
	const b = new Blocks();
	assert.deepEqual(b.push("Premier paragraphe.\n"), []);
	assert.deepEqual(b.push("\nDeuxième"), ["Premier paragraphe."]);
	assert.deepEqual(b.push(" avec du code :\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n"), []);
	assert.deepEqual(b.push("\nFin."), ["Deuxième avec du code :\n```ts\nconst a = 1;\n\nconst b = 2;\n```"]);
	assert.equal(b.flush(), "Fin.");
	assert.equal(b.flush(), undefined);
});

test("language of an answer", () => {
	assert.equal(languageOf("J'ai trouvé la cause du problème dans le fichier."), "fr");
	assert.equal(languageOf("I found the cause of the problem in the file."), "en");
});

test("the request carries what was already said for this answer", () => {
	assert.equal(request("Texte.", ""), "Réponse écrite :\nTexte.");
	assert.ok(request("Suite.", "Début.").startsWith("Déjà dit à voix haute pour cette réponse : « Début. »"));
});
