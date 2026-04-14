/**
 * Bottom-docked amp-style editor for Pi.
 *
 * Architecture:
 * - A real CustomEditor subclass handles all input, submit, keybindings, cursor.
 * - Its normal slot in Pi's layout is hidden (render() => []).
 * - A bottom-anchored overlay renders the same editor state at the terminal bottom.
 * - When built-in selectors like /tree take focus, the overlay is temporarily
 *   removed and recreated afterwards so Pi can shrink/redraw the base layout.
 */

import type { AssistantMessage } from "@mariozechner/pi-ai";
import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { visibleWidth, type Component, type Focusable } from "@mariozechner/pi-tui";

const STATUS_PLACEMENTS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
type StatusPlacement = (typeof STATUS_PLACEMENTS)[number];

const MIN_CONTENT_LINES = 5;

function fmtTokens(n: number): string {
	return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
}

function stripAnsi(s: string): string {
	return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function hasAnsi(s: string): boolean {
	return /\x1b\[[0-9;]*m/.test(s);
}

function isEditorBorderLine(s: string): boolean {
	const plain = stripAnsi(s).trimEnd();
	return /^[─ ]+(?:[↑↓] \d+ more [─ ]*)?$/.test(plain);
}

function colorBorderLabel(colorFn: (s: string) => string, label: string): string {
	if (!label) return "";
	if (!hasAnsi(label)) return colorFn(label);

	const leading = label.match(/^\s*/)?.[0] ?? "";
	const trailing = label.match(/\s*$/)?.[0] ?? "";
	const core = label.slice(leading.length, label.length - trailing.length);
	return colorFn(leading) + core + colorFn(trailing);
}

function buildBorderLine(
	colorFn: (s: string) => string,
	width: number,
	left: string,
	right: string,
	cornerL = "",
	cornerR = "",
): string {
	const innerWidth = width - visibleWidth(cornerL) - visibleWidth(cornerR);
	const dashCount = Math.max(0, innerWidth - visibleWidth(left) - visibleWidth(right));
	return colorFn(cornerL) + colorBorderLabel(colorFn, left) + colorFn("─".repeat(dashCount)) + colorBorderLabel(colorFn, right) + colorFn(cornerR);
}

function getStatusPlacement(key: string): StatusPlacement {
	const match = key.match(/:(top-left|top-right|bottom-left|bottom-right)$/);
	return (match?.[1] as StatusPlacement | undefined) ?? "bottom-left";
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		let activeEditor: AmpEditor | undefined;
		let footerDataRef: any;

		const getStatusSlots = () => {
			const slots: Record<StatusPlacement, string[]> = {
				"top-left": [],
				"top-right": [],
				"bottom-left": [],
				"bottom-right": [],
			};
			const statuses = footerDataRef?.getExtensionStatuses?.();
			if (!statuses) return slots;
			for (const [key, text] of statuses.entries()) {
				if (!text) continue;
				slots[getStatusPlacement(key)].push(text);
			}
			return slots;
		};

		class AmpEditor extends CustomEditor {
			enableClearOnShrink(): void {
				this.tui.setClearOnShrink(true);
			}

			requestFullRender(): void {
				this.tui.requestRender(true);
			}

			private sessionStats() {
				let input = 0,
					output = 0,
					cost = 0;
				let thinking: string | undefined;

				for (const entry of ctx.sessionManager.getBranch()) {
					if (entry.type === "message" && entry.message.role === "assistant") {
						const m = entry.message as AssistantMessage;
						input += m.usage.input;
						output += m.usage.output;
						cost += m.usage.cost.total;
					}
					if (entry.type === "thinking_level_change") {
						thinking = entry.thinkingLevel;
					}
				}
				return { input, output, cost, thinking };
			}

			renderDocked(width: number): string[] {
				const innerWidth = width - 4; // │ + padding + padding + │
				const raw = super.render(innerWidth);
				if (raw.length < 2) return raw;

				const bottomBorderIndex = (() => {
					for (let i = raw.length - 1; i >= 1; i--) {
						if (isEditorBorderLine(raw[i]!)) return i;
					}
					return raw.length - 1;
				})();

				const editorBodyLines = raw.slice(1, bottomBorderIndex);
				const autocompleteLines = raw.slice(bottomBorderIndex + 1);
				const contentLines = [...editorBodyLines, ...autocompleteLines];
				while (contentLines.length < MIN_CONTENT_LINES) {
					contentLines.push(" ".repeat(innerWidth));
				}

				const { input, output, cost, thinking } = this.sessionStats();
				const statusSlots = getStatusSlots();
				const hasTokens = input + output > 0;
				const tokenStats = hasTokens ? `↑${fmtTokens(input)} ↓${fmtTokens(output)} · $${cost.toFixed(3)}` : "";
				const provider = ctx.model?.provider;
				const modelId = ctx.model?.id;
				const modelInfo = [provider, modelId, thinking].filter(Boolean).join(" · ");
				const topLeftParts = statusSlots["top-left"].filter(Boolean);
				const topRightParts = [...statusSlots["top-right"], modelInfo].filter(Boolean);
				const bottomLeftParts = statusSlots["bottom-left"].filter(Boolean);
				const bottomRightParts = [...statusSlots["bottom-right"], tokenStats].filter(Boolean);
				const topLeft = topLeftParts.length > 0 ? ` ${topLeftParts.join(" · ")} ` : "";
				const topRight = topRightParts.length > 0 ? ` ${topRightParts.join(" · ")} ` : "";
				const bottomLeft = bottomLeftParts.length > 0 ? ` ${bottomLeftParts.join(" · ")} ` : "";
				const bottomRight = bottomRightParts.length > 0 ? ` ${bottomRightParts.join(" · ")} ` : "";

				const top = buildBorderLine(this.borderColor, width, topLeft, topRight, "╭", "╮");
				const lb = this.borderColor("│") + " ";
				const rb = " " + this.borderColor("│");
				const content = contentLines.map((l) => lb + l + rb);
				const bottom = buildBorderLine(this.borderColor, width, bottomLeft, bottomRight, "╰", "╯");

				return [top, ...content, bottom];
			}

			// Hide the editor in Pi's normal layout slot.
			override render(_width: number): string[] {
				return [];
			}
		}

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			activeEditor = new AmpEditor(tui, theme, keybindings);
			activeEditor.enableClearOnShrink();
			return activeEditor;
		});

		// Hide the normal footer as well, but keep footerData so the docked input
		// box can display extension statuses in its own chrome.
		ctx.ui.setFooter((_tui, _theme, footerData) => {
			footerDataRef = footerData;
			return {
				dispose() {
					footerDataRef = undefined;
				},
				invalidate() {},
				render(): string[] {
					return [];
				},
			};
		});

		// Reserve vertical space in the normal layout so the bottom overlay does
		// not cover the last visible chat lines when the terminal is full.
		ctx.ui.setWidget(
			"input-box-reserved-space",
			() => ({
				invalidate() {},
				render(width: number): string[] {
					const height = activeEditor?.renderDocked(width).length ?? MIN_CONTENT_LINES + 2;
					return Array.from({ length: height }, () => "");
				},
			}),
			{ placement: "belowEditor" },
		);

		let overlayMounted = false;
		let closeOverlay: (() => void) | undefined;

		const openOverlay = () => {
			if (overlayMounted || !activeEditor) return;
			overlayMounted = true;

			void ctx.ui.custom<void>(
				(tui, _theme, _keybindings, done) => {
					closeOverlay = () => done(undefined);

					class DockedEditorOverlay implements Component, Focusable {
						private _focused = false;
						get focused(): boolean {
							return this._focused;
						}
						set focused(value: boolean) {
							this._focused = value;
							if (activeEditor) activeEditor.focused = value;
						}

						render(width: number): string[] {
							return activeEditor?.renderDocked(width) ?? [];
						}

						handleInput(data: string): void {
							activeEditor?.handleInput(data);
							tui.requestRender();
						}

						invalidate(): void {
							activeEditor?.invalidate();
						}
					}

					return new DockedEditorOverlay();
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "bottom-center",
						width: "100%",
						margin: { left: 0, right: 0, bottom: 0, top: 0 },
					},
				},
			).finally(() => {
				overlayMounted = false;
				closeOverlay = undefined;
				activeEditor?.requestFullRender();
			});
		};

		const closeOverlayNow = () => {
			if (!closeOverlay) return;
			const close = closeOverlay;
			closeOverlay = undefined;
			close();
		};

		openOverlay();

		const overlaySyncTimer = setInterval(() => {
			const shouldShowOverlay = activeEditor?.focused === true;
			if (shouldShowOverlay) {
				openOverlay();
			} else {
				closeOverlayNow();
			}
		}, 50);

		let lastStatusSignature = "";
		const statusSyncTimer = setInterval(() => {
			const statuses = footerDataRef?.getExtensionStatuses?.();
			const signature = statuses ? JSON.stringify(Array.from(statuses.entries())) : "";
			if (signature !== lastStatusSignature) {
				lastStatusSignature = signature;
				activeEditor?.requestFullRender();
			}
		}, 250);

		pi.on("session_shutdown", () => {
			clearInterval(overlaySyncTimer);
			clearInterval(statusSyncTimer);
			closeOverlayNow();
		});
	});
}
