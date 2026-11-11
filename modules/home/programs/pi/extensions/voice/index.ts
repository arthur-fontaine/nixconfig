// Voice calls with Pi (DESIGN.md, README.md): the extension's wiring to the real daemon and pi-tui.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey, MouseRegion, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Client } from "./client.ts";
import { voice } from "./extension.ts";

export default function (pi: ExtensionAPI) {
	voice(pi, {
		client: (onEvent, onClose) => new Client(onEvent, onClose),
		tui: { MouseRegion, truncateToWidth, visibleWidth, wrapTextWithAnsi },
		isEscape: (data) => matchesKey(data, "escape"),
	});
}
