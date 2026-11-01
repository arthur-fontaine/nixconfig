-- Neovim as a light editor for files opened from Herdr: Ayu like Zed, LSP and
-- tree-sitter out of the box, a picker for everything. Plugins, parsers and
-- language servers come from Nix (see default.nix), so nothing installs at
-- startup and there is no plugin manager.

vim.g.mapleader = " "
vim.g.maplocalleader = " "

local o = vim.opt
o.number = true
o.signcolumn = "yes"
o.cursorline = true
o.mouse = "a"
o.mousemoveevent = true
o.clipboard = "unnamedplus"
o.expandtab = true
o.shiftwidth = 2
o.tabstop = 2
o.smartindent = true
o.ignorecase = true
o.smartcase = true
o.splitright = true
o.splitbelow = true
o.scrolloff = 8
o.sidescrolloff = 8
o.wrap = false
o.undofile = true
o.swapfile = false
o.updatetime = 200
o.timeoutlen = 400
o.laststatus = 3
o.showmode = false
o.pumheight = 12
o.fillchars = { eob = " " }
o.confirm = true

-- Theme ----------------------------------------------------------------------

-- The terminal's own colors, as Pi does: Neovim asks Herdr (or Ghostty) for
-- its background, foreground and 16 ANSI colors and builds a base16 theme from
-- them, so it always matches the terminal, Herdr's panels and Pi. The last
-- answer is kept for the next start, to draw right away.
o.termguicolors = true
require("mini.icons").setup()
MiniIcons.mock_nvim_web_devicons()

local cache = vim.fn.stdpath("state") .. "/terminal-palette.json"

local function hex2rgb(h) return tonumber(h:sub(2, 3), 16), tonumber(h:sub(4, 5), 16), tonumber(h:sub(6, 7), 16) end
local function mix(a, b, t)
  local ar, ag, ab = hex2rgb(a)
  local br, bg, bb = hex2rgb(b)
  local f = function(x, y) return math.floor(x + (y - x) * t + 0.5) end
  return ("#%02x%02x%02x"):format(f(ar, br), f(ag, bg), f(ab, bb))
end

local function apply(p)
  local bg, fg = p.bg, p.fg
  local r, g, b = hex2rgb(bg)
  o.background = (0.299 * r + 0.587 * g + 0.114 * b) < 128 and "dark" or "light"
  require("mini.base16").setup({
    palette = {
      base00 = bg, base01 = mix(bg, fg, 0.07), base02 = mix(bg, fg, 0.15), base03 = mix(bg, fg, 0.42),
      base04 = mix(bg, fg, 0.62), base05 = fg, base06 = mix(fg, p[15], 0.5), base07 = p[15],
      base08 = p[1], base09 = mix(p[1], p[3], 0.5), base0A = p[3], base0B = p[2],
      base0C = p[6], base0D = p[4], base0E = p[5], base0F = mix(p[1], bg, 0.35),
    },
  })
  vim.g.colors_name = "terminal"
end

local function query()
  local got, count = {}, 0
  vim.api.nvim_create_autocmd("TermResponse", {
    callback = function(ev)
      local seq = ev.data.sequence
      local key, rr, gg, bb
      local i
      i, rr, gg, bb = seq:match("^\027%]4;(%d+);rgb:(%x+)/(%x+)/(%x+)")
      if i then key = tonumber(i) else
        i, rr, gg, bb = seq:match("^\027%]1([01]);rgb:(%x+)/(%x+)/(%x+)")
        if i then key = i == "0" and "fg" or "bg" end
      end
      if key == nil or got[key] then return end
      got[key] = "#" .. rr:sub(1, 2) .. gg:sub(1, 2) .. bb:sub(1, 2)
      count = count + 1
      if count < 18 then return end
      vim.schedule(function()
        apply(got)
        pcall(vim.fn.writefile, { vim.json.encode(got) }, cache)
      end)
      return true -- this query is answered: drop the autocmd
    end,
  })
  local q = "\027]10;?\027\\\027]11;?\027\\"
  for n = 0, 15 do q = q .. ("\027]4;%d;?\027\\"):format(n) end
  vim.api.nvim_ui_send(q)
end

do
  local ok, saved = pcall(function() return vim.json.decode(table.concat(vim.fn.readfile(cache))) end)
  if ok and type(saved) == "table" and saved.bg then
    -- JSON keys are strings: put the ANSI colors back at 0..15.
    for n = 0, 15 do saved[n] = saved[n] or saved[tostring(n)] end
    apply(saved)
  end
end
if #vim.api.nvim_list_uis() > 0 then query() end
-- Herdr switches light and dark with macOS; look again when we come back.
vim.api.nvim_create_autocmd("FocusGained", { callback = query })

-- Syntax: tree-sitter for every language with a parser ------------------------

vim.api.nvim_create_autocmd("FileType", {
  callback = function(args)
    if pcall(vim.treesitter.start, args.buf) then
      vim.bo[args.buf].indentexpr = "v:lua.require'nvim-treesitter'.indentexpr()"
    end
  end,
})

-- Language servers ------------------------------------------------------------

-- Configs from nvim-lspconfig; the servers are on PATH (default.nix).
vim.lsp.enable({
  "ts_ls", "biome", "eslint", "jsonls", "cssls", "html", "tailwindcss",
  "yamlls", "nixd", "lua_ls", "rust_analyzer",
})
vim.lsp.config("lua_ls", {
  settings = { Lua = { workspace = { library = vim.api.nvim_get_runtime_file("", true) } } },
})

vim.diagnostic.config({
  severity_sort = true,
  virtual_text = { spacing = 2, prefix = "●" },
  float = { border = "rounded", source = "if_many" },
  signs = {
    text = {
      [vim.diagnostic.severity.ERROR] = "",
      [vim.diagnostic.severity.WARN] = "",
      [vim.diagnostic.severity.INFO] = "",
      [vim.diagnostic.severity.HINT] = "",
    },
  },
})
o.winborder = "rounded"

-- Completion: blink's Rust matcher is built by Nix, never downloaded.
require("blink.cmp").setup({
  keymap = { preset = "enter", ["<Tab>"] = { "select_and_accept", "fallback" } },
  completion = {
    documentation = { auto_show = true, auto_show_delay_ms = 200 },
    menu = { draw = { treesitter = { "lsp" } } },
  },
  signature = { enabled = true },
  fuzzy = { implementation = "prefer_rust", prebuilt_binaries = { download = false } },
})

-- UI -------------------------------------------------------------------------

local Snacks = require("snacks")
Snacks.setup({
  bigfile = { enabled = true },
  quickfile = { enabled = true },
  explorer = { enabled = true, replace_netrw = true },
  picker = {
    enabled = true,
    sources = { explorer = { layout = { layout = { position = "left", width = 32 } } } },
  },
  indent = { enabled = true, animate = { enabled = false } },
  input = { enabled = true },
  notifier = { enabled = true },
  words = { enabled = true },
  scope = { enabled = true },
})

require("gitsigns").setup({ current_line_blame = false })

require("bufferline").setup({
  options = {
    diagnostics = "nvim_lsp",
    show_buffer_close_icons = true,
    show_close_icon = false,
    separator_style = "thin",
    always_show_bufferline = false,
    close_command = function(n) Snacks.bufdelete(n) end,
    offsets = { { filetype = "snacks_layout_box", text = "", separator = true } },
  },
})

require("lualine").setup({
  options = {
    theme = "auto",
    globalstatus = true,
    component_separators = "",
    section_separators = "",
  },
  sections = {
    lualine_a = { "mode" },
    lualine_b = { "branch", "diff" },
    lualine_c = { { "filename", path = 1 } },
    lualine_x = { "diagnostics", "filetype" },
    lualine_y = { "location" },
    lualine_z = {},
  },
})

local wk = require("which-key")
wk.setup({ preset = "helix", delay = 300 })
wk.add({
  { "<leader>g", group = "git" },
  { "<leader>c", group = "code" },
})

-- Keys -----------------------------------------------------------------------
-- Zed's vim-mode bindings where it has one: gd, gD, gy, gI, gA, g., cd.

local map = vim.keymap.set
local pick = Snacks.picker

map("n", "<leader><leader>", function() pick.smart() end, { desc = "Find file" })
map("n", "<leader>f", function() pick.files() end, { desc = "Files" })
map("n", "<leader>/", function() pick.grep() end, { desc = "Search in project" })
map({ "n", "x" }, "<leader>*", function() pick.grep_word() end, { desc = "Search word" })
map("n", "<leader>e", function() Snacks.explorer() end, { desc = "Explorer" })
map("n", "<leader>b", function() pick.buffers() end, { desc = "Open files" })
map("n", "<leader>s", function() pick.lsp_symbols() end, { desc = "Symbols in file" })
map("n", "<leader>S", function() pick.lsp_workspace_symbols() end, { desc = "Symbols in project" })
map("n", "<leader>d", function() pick.diagnostics() end, { desc = "Diagnostics" })
map("n", "<leader>gs", function() pick.git_status() end, { desc = "Changed files" })
map("n", "<leader>gb", function() Snacks.git.blame_line() end, { desc = "Blame line" })
map("n", "<leader>gh", function() require("gitsigns").preview_hunk() end, { desc = "Preview change" })
map("n", "<leader>gr", function() require("gitsigns").reset_hunk() end, { desc = "Revert change" })
map("n", "<leader>cf", function() vim.lsp.buf.format() end, { desc = "Format" })
map("n", "<leader>q", function() Snacks.bufdelete() end, { desc = "Close file" })
map("n", "<leader>:", function() pick.commands() end, { desc = "Commands" })
map("n", "<leader>?", function() pick.keymaps() end, { desc = "Keys" })

map("n", "gd", function() pick.lsp_definitions() end, { desc = "Go to definition" })
map("n", "gD", function() pick.lsp_declarations() end, { desc = "Go to declaration" })
map("n", "gy", function() pick.lsp_type_definitions() end, { desc = "Go to type" })
map("n", "gI", function() pick.lsp_implementations() end, { desc = "Go to implementation" })
map("n", "gA", function() pick.lsp_references() end, { nowait = true, desc = "References" })
map({ "n", "x" }, "g.", vim.lsp.buf.code_action, { desc = "Code actions" })
map("n", "cd", vim.lsp.buf.rename, { desc = "Rename symbol" })
map("n", "gh", vim.diagnostic.open_float, { desc = "Diagnostic" })
map({ "n", "i", "x" }, "<D-s>", "<Cmd>write<CR><Esc>", { desc = "Save" })

-- Mouse, as in Zed ---------------------------------------------------------------

-- Cmd+click goes to the definition. Herdr keeps Cmd and sends a plain click,
-- so a click asks macOS whether Command is down (cmd-held, default.nix).
map("n", "<LeftMouse>", function()
  vim.api.nvim_feedkeys(vim.keycode("<LeftMouse>"), "n", false)
  vim.schedule(function()
    if vim.system({ "cmd-held" }):wait().code == 0 then pick.lsp_definitions() end
  end)
end, { desc = "Cmd+click: go to definition" })

-- Resting the pointer on a symbol shows its hover, like Zed. The float closes
-- when the pointer moves to another symbol or anything else happens.
o.mousemoveevent = true
local hover = { timer = assert(vim.uv.new_timer()), win = nil, at = nil }

local function close_hover()
  if hover.win and vim.api.nvim_win_is_valid(hover.win) then vim.api.nvim_win_close(hover.win, true) end
  hover.win, hover.at = nil, nil
end

-- The symbol under the pointer: its window, buffer, line and byte range.
local function under_mouse()
  local m = vim.fn.getmousepos()
  if m.winid == 0 or m.line == 0 or m.winid == hover.win then return nil end
  local buf = vim.api.nvim_win_get_buf(m.winid)
  if vim.bo[buf].buftype ~= "" then return nil end
  local text = vim.api.nvim_buf_get_lines(buf, m.line - 1, m.line, false)[1] or ""
  local col = m.column - 1
  if col >= #text or not text:sub(col + 1, col + 1):match("[%w_$]") then return nil end
  local s, e = col, col
  while s > 0 and text:sub(s, s):match("[%w_$]") do s = s - 1 end
  while e < #text and text:sub(e + 2, e + 2):match("[%w_$]") do e = e + 1 end
  return { win = m.winid, buf = buf, line = m.line - 1, col = col, key = (("%d:%d:%d"):format(buf, m.line, s)), text = text }
end

local function show_hover(at)
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
      close_events = { "CursorMoved", "InsertEnter", "BufLeave", "WinScrolled" },
    })
    hover.win = win
  end, at.buf)
end

map({ "n", "i" }, "<MouseMove>", function()
  local at = under_mouse()
  if at and at.key == hover.at then return end
  close_hover()
  hover.timer:stop()
  if not at then return end
  hover.at = at.key
  hover.timer:start(350, 0, vim.schedule_wrap(function()
    if hover.at == at.key then show_hover(at) end
  end))
end)
map("n", "]]", function() Snacks.words.jump(1, true) end, { desc = "Next reference" })
map("n", "[[", function() Snacks.words.jump(-1, true) end, { desc = "Previous reference" })

map("n", "gt", "<Cmd>BufferLineCycleNext<CR>", { desc = "Next file" })
map("n", "gT", "<Cmd>BufferLineCyclePrev<CR>", { desc = "Previous file" })
map({ "n", "i", "x" }, "<C-s>", "<Cmd>write<CR><Esc>", { desc = "Save" })
map("n", "<Esc>", "<Cmd>nohlsearch<CR>")
