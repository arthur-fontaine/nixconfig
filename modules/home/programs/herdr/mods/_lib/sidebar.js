// The left sidebar's three states and the runs that bring it back; nix-head folds it,
// nix-tabs shows a toggle in the tab bar when the sidebar has none of its own.

// The rail goes by width, not a flag: dragging the sidebar's edge narrows it too.
export function sidebarState(node) {
  if (node?.hidden) return "hidden";
  return (node?.size?.px ?? Infinity) < 160 ? "rail" : "open";
}

// The [action, args] runs that bring the sidebar back to the width it had (or 256).
export function sidebarReopen(node, savedWidth) {
  const runs = [];
  if (node?.hidden) runs.push(["layout.show", { id: "sidebar" }]);
  if ((node?.size?.px ?? Infinity) < 160) runs.push(["layout.resize", { id: "sidebar", px: savedWidth ?? 256 }]);
  return runs;
}

// The rail's width: on macOS wide enough for the traffic lights.
export function sidebarFold(platform) {
  return platform === "macos" ? 76 : 44;
}

// On the macOS rail the traffic lights take the head's row, so the head has no toggle there.
export function sidebarToggleInBar(state, platform) {
  return state === "hidden" || (state === "rail" && platform === "macos");
}
