// Whether the editor is still on screen, for its floating popup. No Pi imports.

interface Node {
	children?: readonly unknown[];
}

/**
 * True when `component` is one of `roots` or inside one of them. Pi swaps the editor
 * out of its container for a selector (/resume's picker, a dialog) without telling it,
 * and the popup it floats over the chat must go with it.
 */
export function mounted(component: unknown, roots: readonly unknown[], depth = 0): boolean {
	if (depth > 8) return false;
	return roots.some((root) => root === component || mounted(component, (root as Node | undefined)?.children ?? [], depth + 1));
}
