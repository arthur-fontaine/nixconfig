// bash-changes for Pi: records which files each bash call changed in its git
// repository and shows their diff under the call, like edit and write do.
import { type ExtensionAPI, getLanguageFromPath, highlightCode, keyHint } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { bashChanges } from "./extension.ts";

export default function (pi: ExtensionAPI) {
	bashChanges(pi, {
		highlight: highlightCode,
		language: getLanguageFromPath,
		wrap: wrapTextWithAnsi,
		expandHint: () => keyHint("app.tools.expand", "to show all changes"),
	});
}
