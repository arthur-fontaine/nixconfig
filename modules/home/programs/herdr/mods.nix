# The mods deployed to Herdr's home, and how each main.js is made (default.nix's bundle):
# shared mods/_lib files and the mod's own modules joined before main.js. Kept apart so
# scripts/sandbox deploys the same set.
{
  # The patched copies of shipped mods, and nix-diff (the diff tab nix-changes opens).
  nix-sidebar = {
    shared = [
      "worktree.js"
    ];
  };
  nix-files = { shared = [ "editor.js" ]; };
  nix-changes = { };
  # The diff tab, editable: edit.js (its figures), and the editor's grid.js (key notation) and
  # nvim.js (its Neovim, started on diff.lua) joined in.
  nix-diff = { shared = [ "editor.js" ]; modules = [ "model.js" "syntax.js" "edit.js" "../nix-editor/grid.js" "../nix-editor/nvim.js" ]; };
  nix-worktree = { shared = [ "repo.js" ]; };
  nix-menu = {
    shared = [
      "worktree.js"
    ];
  };
  nix-tabs = {
    shared = [
    ];
  };
  nix-status = {
    shared = [
      "close.js"
    ];
  };
  nix-pane = {
    shared = [
    ];
  };
  nix-head = { };
  # The + popover: an open or idle worktree, or a new one, then Pi or a terminal.
  nix-new = {
    shared = [
      "repo.js"
      "worktree.js"
    ];
  };
  # The code editor: a renderer for a headless Neovim; grid.js (its UI as a grid) and
  # nvim.js (msgpack-RPC to it) joined in.
  nix-editor = { modules = [ "grid.js" "nvim.js" ]; };
  # The Info panel: the selected Pi session and the Claude usage; model.js (the figures) joined in.
  nix-info = { shared = [ "editor.js" ]; modules = [ "model.js" ]; };
  # The Games panel: micro-breaks while an agent works; model.js (the rules and the agent
  # strip) joined in, after nix-info's model.js (the session helpers it reuses).
  nix-games = { modules = [ "../nix-info/model.js" "model.js" ]; };
  # The kanban (the Kanban sidebar, the board as a tab, its dialogs and menu), on the
  # herdr-kanban daemon below; model.js (its figures) joined in.
  nix-kanban = { modules = [ "model.js" ]; };
}
