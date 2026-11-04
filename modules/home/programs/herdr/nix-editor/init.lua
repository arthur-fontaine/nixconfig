-- The backend of Herdr's nix-editor: `nvim --embed`, drawn by the mod. Neovim does the
-- editing and talks to the language servers; the mod renders the grid and its popups.
-- Not modal: the buffer stays in Insert mode, Shift+arrows and the mouse select (Select
-- mode), and the Cmd keys the mod sends as <D-…> do what they do in any editor.
-- Language servers come from the PATH (nothing is installed for them).
vim.g.herdr_editor = 1

-- Only the parsers and server configs of the nix-installed pack, not its other plugins
-- (they're set up for the user's own Neovim).
vim.o.loadplugins = false
local start = vim.fn.stdpath("data") .. "/site/pack/nix/start/"
for _, dir in ipairs({ "nvim-lspconfig", "nvim-treesitter/runtime", "nvim-treesitter-grammars" }) do
  if vim.uv.fs_stat(start .. dir) then vim.opt.runtimepath:append(start .. dir) end
end

local o = vim.opt
o.number = true
o.signcolumn = "yes"
-- The current line's number stands out; the line itself isn't highlighted.
o.cursorline = true
o.cursorlineopt = "number"
-- Floats come without a border: the mod draws their frame.
o.winborder = "none"
o.laststatus = 0
-- Several files are tab pages; the mod draws their strip, nvim none.
o.showtabline = 0
o.ruler = false
o.showmode = false
o.showcmd = false
o.cmdheight = 1
o.shortmess:append("IcsW")
o.mouse = "a"
o.mousemoveevent = true
-- A line per wheel step (a trackpad sends one per line height it moves): the view slides
-- each scroll, so the text follows the fingers.
o.mousescroll = "ver:1,hor:2"
o.termguicolors = true
o.updatetime = 300
o.scrolloff = 4
o.expandtab = true
o.shiftwidth = 2
o.tabstop = 2
o.autoread = true
o.undolevels = 10000
-- No info float: the mod draws its own menu, which the float would sit under.
o.completeopt = { "menuone", "noinsert" }
-- Shift+arrows and the mouse start Select mode; a plain arrow ends it.
o.keymodel = { "startsel", "stopsel" }
o.selectmode = { "key", "mouse" }
o.selection = "exclusive"
o.whichwrap = "<,>,[,]"

-- Agents change files under the editor: pick their edits up.
vim.api.nvim_create_autocmd({ "FocusGained", "BufEnter", "CursorHold", "CursorHoldI" }, {
  command = "silent! checktime",
})

-- Always typing, never in Normal mode by accident.
vim.api.nvim_create_autocmd({ "BufEnter", "VimEnter" }, {
  callback = function() if vim.bo.buftype == "" and vim.fn.mode() == "n" then vim.cmd.startinsert() end end,
})

-- Syntax: tree-sitter where a parser exists.
vim.api.nvim_create_autocmd("FileType", {
  callback = function(args) pcall(vim.treesitter.start, args.buf) end,
})

-- Language servers: configs from nvim-lspconfig, servers from the PATH.
-- A project without its own TypeScript gets the one beside `tsc` on the PATH.
local function global_tsserver()
  local tsc = vim.fn.exepath("tsc")
  local real = tsc ~= "" and vim.uv.fs_realpath(tsc)
  if not real then return nil end
  local lib = vim.fs.dirname(vim.fs.dirname(real)) .. "/lib"
  return vim.uv.fs_stat(lib .. "/tsserver.js") and lib or nil
end
vim.lsp.config("ts_ls", {
  before_init = function(params, config)
    local root = config.root_dir or vim.fn.getcwd()
    if vim.fs.find("node_modules/typescript", { upward = true, path = root, type = "directory" })[1] then return end
    local lib = global_tsserver()
    if lib then
      params.initializationOptions = vim.tbl_deep_extend("force", params.initializationOptions or {}, { tsserver = { path = lib } })
    end
  end,
})
-- Not for a diff tab (diff.lua): one light process however many files it shows.
if not vim.g.herdr_diff then vim.lsp.enable({ "ts_ls" }) end
vim.diagnostic.config({
  virtual_text = false,
  underline = true,
  signs = { text = { [vim.diagnostic.severity.ERROR] = "●", [vim.diagnostic.severity.WARN] = "●", [vim.diagnostic.severity.INFO] = "●", [vim.diagnostic.severity.HINT] = "●" } },
  severity_sort = true,
  update_in_insert = true,
  float = { border = "none", source = "if_many" },
})
-- Code in Ayu, as Zed and Ghostty show it (Ayu Dark or Ayu Light after Herdr's appearance;
-- the plugin is installed beside this file). Herdr's theme, sent by the mod when it starts
-- and whenever it changes (_G.herdr_theme), gives the surfaces and the groups the design
-- sets their colors. Kept, so loading the scheme again applies them again.
local here = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h")
vim.opt.runtimepath:append(here .. "/ayu")
local loaded
local function scheme(appearance)
  loaded = appearance
  pcall(vim.cmd.colorscheme, "ayu-" .. appearance)
end
local theme
local function apply_theme()
  local hl = function(name, spec) vim.api.nvim_set_hl(0, name, spec) end
  local levels = theme and { Error = theme.blocked, Warn = theme.ansi3, Info = theme.ansi4, Hint = theme.dim } or {}
  if theme then
    hl("Normal", { fg = theme.foreground, bg = theme.background })
    hl("NormalFloat", { fg = theme.foreground, bg = theme.popover })
    hl("FloatBorder", { fg = theme.border, bg = theme.popover })
    hl("SignColumn", { bg = theme.background })
    hl("CursorLineNr", { fg = theme.foreground })
    hl("Search", { bg = theme.selection })
    hl("CurSearch", { fg = theme.accent_foreground, bg = theme.accent })
    hl("IncSearch", { fg = theme.accent_foreground, bg = theme.accent })
    hl("Visual", { bg = theme.selection })
    hl("MatchParen", { bg = theme.raised, bold = true })
    for level, color in pairs(levels) do hl("Diagnostic" .. level, { fg = color }) end
  end
  -- Signs and wavy lines from the diagnostic colors, the theme's or the scheme's.
  for _, level in ipairs({ "Error", "Warn", "Info", "Hint" }) do
    local fg = levels[level] or vim.api.nvim_get_hl(0, { name = "Diagnostic" .. level, link = false }).fg
    hl("DiagnosticSign" .. level, { fg = fg, bg = theme and theme.background or nil })
    hl("DiagnosticUnderline" .. level, { undercurl = true, sp = fg })
  end
end
_G.herdr_theme = function(colors)
  theme = colors
  if loaded ~= colors.appearance then scheme(colors.appearance) else apply_theme() end
end
scheme("dark")
apply_theme()
vim.api.nvim_create_autocmd("ColorScheme", { callback = apply_theme })

vim.api.nvim_create_autocmd("LspAttach", {
  callback = function(args)
    local client = vim.lsp.get_client_by_id(args.data.client_id)
    if client and client:supports_method("textDocument/completion") then
      vim.lsp.completion.enable(true, client.id, args.buf, { autotrigger = true })
    end
  end,
})

-- The tab pages, for the mod's strip: the file each one shows, whether any of its
-- files has unsaved changes, how many windows (splits) it has, and which is current.
local function editable(win) return vim.api.nvim_win_get_config(win).relative == "" end
local function tabs()
  local out, current = {}, vim.api.nvim_get_current_tabpage()
  for i, tab in ipairs(vim.api.nvim_list_tabpages()) do
    local wins = vim.tbl_filter(editable, vim.api.nvim_tabpage_list_wins(tab))
    local modified = false
    for _, w in ipairs(wins) do modified = modified or vim.bo[vim.api.nvim_win_get_buf(w)].modified end
    local win = vim.api.nvim_tabpage_get_win(tab)
    if not editable(win) then win = wins[1] or win end
    out[i] = {
      file = vim.api.nvim_buf_get_name(vim.api.nvim_win_get_buf(win)),
      modified = modified,
      splits = #wins,
      current = tab == current,
    }
  end
  return out
end

-- The status the mod draws: file, modified, diagnostics, servers, mode, tab pages.
local function status()
  local buf = vim.api.nvim_get_current_buf()
  local count = function(s) return #vim.diagnostic.get(buf, { severity = s }) end
  local names = {}
  for _, c in ipairs(vim.lsp.get_clients({ bufnr = buf })) do
    names[#names + 1] = c.name .. (c.initialized and "" or " (starting)")
  end
  vim.rpcnotify(0, "herdr_status", {
    file = vim.api.nvim_buf_get_name(buf),
    modified = vim.bo[buf].modified,
    errors = count(vim.diagnostic.severity.ERROR),
    warnings = count(vim.diagnostic.severity.WARN),
    lsp = names,
    mode = vim.api.nvim_get_mode().mode,
    tabs = tabs(),
  })
end
vim.api.nvim_create_autocmd({ "BufEnter", "BufWritePost", "BufModifiedSet", "DiagnosticChanged", "ModeChanged", "LspAttach", "LspDetach",
  "TabEnter", "TabNew", "TabClosed", "WinNew", "WinClosed" }, {
  callback = function() vim.schedule(status) end,
})

-- A file from the panels (the mod calls these): in its tab, or a new one, or beside the
-- current window with `side`; then at `line`.
_G.herdr_open = function(file, line, side)
  local name = vim.fn.fnameescape(file)
  vim.cmd((side and "vsplit " or "tab drop ") .. name)
  if line and line > 0 then
    pcall(vim.api.nvim_win_set_cursor, 0, { line, 0 })
    vim.cmd("normal! zz")
  end
end

-- Closes tab page n, and its files no other tab shows. Unsaved changes keep it open
-- ("modified") unless `force`; the last one stays ("last": the mod closes its Herdr tab).
_G.herdr_close_tab = function(n, force)
  local list = vim.api.nvim_list_tabpages()
  local tab = list[n]
  if not tab then return "gone" end
  local bufs = {}
  for _, w in ipairs(vim.tbl_filter(editable, vim.api.nvim_tabpage_list_wins(tab))) do bufs[vim.api.nvim_win_get_buf(w)] = true end
  for _, other in ipairs(list) do
    if other ~= tab then
      for _, w in ipairs(vim.api.nvim_tabpage_list_wins(other)) do bufs[vim.api.nvim_win_get_buf(w)] = nil end
    end
  end
  if not force then
    for b in pairs(bufs) do if vim.bo[b].modified then return "modified" end end
  end
  if #list == 1 then return "last" end
  vim.cmd("tabclose! " .. n)
  for b in pairs(bufs) do pcall(vim.api.nvim_buf_delete, b, { force = true }) end
  return "closed"
end

-- Keys ------------------------------------------------------------------------------
local map = vim.keymap.set
local all = { "n", "i", "v", "s", "x" }

map(all, "<D-s>", "<Cmd>silent! update<CR>")
map(all, "<D-z>", "<Cmd>undo<CR>")
map(all, "<D-S-z>", "<Cmd>redo<CR>")
map({ "n", "i" }, "<D-a>", "<C-\\><C-n>ggVG<C-g>")
-- The clipboard is the mod's: it reads the + register after <D-c>/<D-x>, and fills it
-- before sending <D-v>.
map({ "v", "s", "x" }, "<D-c>", '<C-g>"+ygv<C-g>')
map({ "v", "s", "x" }, "<D-x>", '<C-g>"+d<Cmd>startinsert<CR>')
map("i", "<D-v>", "<C-r><C-o>+")
map("n", "<D-v>", '"+gP<Cmd>startinsert<CR>')
map({ "v", "s", "x" }, "<D-v>", '<C-g>"_d"+P<Cmd>startinsert<CR>')
-- Esc closes the completion menu first, as in any editor.
map("i", "<Esc>", function() return vim.fn.pumvisible() == 1 and "<C-e>" or "<Cmd>nohlsearch<CR>" end, { expr = true })
map("n", "<Esc>", "<Cmd>startinsert<CR>")
map({ "n", "i" }, "<D-f>", "<C-\\><C-n>/")
-- macOS moves: Cmd+arrows to the line's or the file's ends, Option+arrows by word, with
-- Shift to select (keymodel starts Select mode on these shifted keys).
for from, to in pairs({
  ["<D-Left>"] = "<Home>", ["<D-Right>"] = "<End>", ["<D-Up>"] = "<C-Home>", ["<D-Down>"] = "<C-End>",
  ["<A-Left>"] = "<C-Left>", ["<A-Right>"] = "<C-Right>",
  ["<D-S-Left>"] = "<S-Home>", ["<D-S-Right>"] = "<S-End>", ["<D-S-Up>"] = "<C-S-Home>", ["<D-S-Down>"] = "<C-S-End>",
  ["<A-S-Left>"] = "<C-S-Left>", ["<A-S-Right>"] = "<C-S-Right>",
}) do
  map({ "i", "s" }, from, to)
end
map("i", "<A-BS>", "<C-w>")
-- Cmd+\ splits: the same file beside itself; Cmd+Shift+\ closes the split the cursor is in.
map(all, "<D-\\>", "<Cmd>vsplit<CR>")
map(all, "<D-S-\\>", function() if #vim.tbl_filter(editable, vim.api.nvim_tabpage_list_wins(0)) > 1 then vim.cmd.close() end end)
map("i", "<D-BS>", "<C-u>")

-- Code navigation: Cmd+click or F12 to the definition, Shift+F12 to references.
map({ "n", "i" }, "<D-LeftMouse>", "<LeftMouse><Cmd>lua vim.lsp.buf.definition()<CR>")
map({ "n", "i" }, "<F12>", "<Cmd>lua vim.lsp.buf.definition()<CR>")
map({ "n", "i" }, "<S-F12>", "<Cmd>lua vim.lsp.buf.references()<CR>")
map({ "n", "i" }, "<F2>", "<Cmd>lua vim.lsp.buf.rename()<CR>")
map({ "n", "i" }, "<D-.>", "<Cmd>lua vim.lsp.buf.code_action()<CR>")
map("n", "gd", vim.lsp.buf.definition)
map("n", "K", vim.lsp.buf.hover)

-- Hover under the resting mouse (as the user's own Neovim does): the type, or the
-- diagnostics there, in a float the grid draws.
local hover = { timer = vim.uv.new_timer(), at = nil, win = nil }
local function close_hover()
  if hover.win and vim.api.nvim_win_is_valid(hover.win) then vim.api.nvim_win_close(hover.win, true) end
  hover.win = nil
end
local function under_mouse()
  local m = vim.fn.getmousepos()
  if m.winid == 0 or m.line == 0 or vim.api.nvim_win_get_config(m.winid).relative ~= "" then return nil end
  local buf = vim.api.nvim_win_get_buf(m.winid)
  local text = vim.api.nvim_buf_get_lines(buf, m.line - 1, m.line, false)[1] or ""
  local col = m.column - 1
  if col >= #text then return nil end
  return { buf = buf, line = m.line - 1, col = col, text = text, key = ("%d:%d:%d"):format(buf, m.line, col) }
end
local function show_hover(at)
  local diags = vim.diagnostic.get(at.buf, { lnum = at.line })
  local here = vim.tbl_filter(function(d) return at.col >= d.col and at.col < math.max(d.end_col, d.col + 1) end, diags)
  if #here > 0 then
    local lines = vim.tbl_map(function(d) return d.message end, here)
    local _, win = vim.lsp.util.open_floating_preview(lines, "plaintext", { relative = "mouse", focusable = false, max_width = 80 })
    hover.win = win
    return
  end
  local client = vim.lsp.get_clients({ bufnr = at.buf, method = "textDocument/hover" })[1]
  if not client then return end
  local params = {
    textDocument = { uri = vim.uri_from_bufnr(at.buf) },
    position = { line = at.line, character = vim.str_utfindex(at.text, client.offset_encoding, at.col, false) },
  }
  client:request("textDocument/hover", params, function(err, result)
    if err or not result or not result.contents or hover.at ~= at.key then return end
    local lines = vim.lsp.util.convert_input_to_markdown_lines(result.contents)
    if vim.tbl_isempty(lines) then return end
    local _, win = vim.lsp.util.open_floating_preview(lines, "markdown", {
      relative = "mouse", focusable = false, max_width = 80, max_height = 20,
      close_events = { "CursorMoved", "CursorMovedI", "InsertCharPre", "BufLeave", "WinScrolled" },
    })
    hover.win = win
  end, at.buf)
end
map({ "n", "i" }, "<MouseMove>", function()
  local at = under_mouse()
  -- Same cell: nothing to do while its float is up (or still coming); once it has closed
  -- (the cursor moved, the text changed), resting there again shows it again.
  local open = hover.win and vim.api.nvim_win_is_valid(hover.win)
  if at and at.key == hover.at and (open or hover.timer:get_due_in() > 0) then return end
  close_hover()
  hover.timer:stop()
  hover.at = at and at.key
  if not at then return end
  hover.timer:start(400, 0, vim.schedule_wrap(function()
    if hover.at == at.key then show_hover(at) end
  end))
end)

-- No ~ past the end of the file: the editor area ends where the text does.
vim.opt.fillchars:append({ eob = " " })
