// The layout's pane radius (the "main" block's content.pane.radius), 0 if none. A mod shown as a
// tab in main rounds its own fills by it: a pane's rounded frame doesn't clip what the mod paints.
export function paneRadius(node) {
  if (!node) return 0;
  if (node.id === "main") return Number(node.content?.pane?.radius) || 0;
  for (const child of node.children ?? []) { const r = paneRadius(child); if (r || child.id === "main") return r; }
  return 0;
}
