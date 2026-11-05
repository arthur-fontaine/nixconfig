// The mouse wheel over the editor, in rows of its wrapped text. No Pi imports.

export interface View {
	// The first row shown, how many are shown, and how many there are.
	offset: number;
	visible: number;
	total: number;
	// The row the cursor is on.
	cursor: number;
}

/**
 * The rows shown after the wheel moved `delta` rows (negative is up), and the
 * row the cursor goes to: Pi's Editor scrolls back to the cursor on every
 * render, so a cursor scrolled out of view is taken along to the nearest row
 * still shown. Undefined when everything fits, so the chat scrolls instead.
 */
export function wheel(view: View, delta: number): { offset: number; cursor: number } | undefined {
	const { visible, total, cursor } = view;
	if (visible <= 0 || total <= visible) return undefined;
	const offset = Math.max(0, Math.min(total - visible, view.offset + delta));
	return { offset, cursor: Math.max(offset, Math.min(offset + visible - 1, cursor)) };
}
