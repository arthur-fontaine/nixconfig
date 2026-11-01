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

-- Ayu like Zed: Dark or Light after macOS. Neovim may also learn the
-- terminal's background later and change 'background'; follow it.
local appearance = vim.fn.system({ "defaults", "read", "-g", "AppleInterfaceStyle" })
o.background = appearance:match("Dark") and "dark" or "light"
require("ayu").setup({ mirage = false, terminal = true })
vim.cmd.colorscheme("ayu")
vim.api.nvim_create_autocmd("OptionSet", {
  pattern = "background",
  callback = function() vim.cmd.colorscheme("ayu") end,
})

require("mini.icons").setup()
MiniIcons.mock_nvim_web_devicons()

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
-- Ctrl-click: the terminal keeps Cmd-click for itself.
map("n", "<C-LeftMouse>", "<LeftMouse><Cmd>lua Snacks.picker.lsp_definitions()<CR>", { desc = "Go to definition" })
map("n", "]]", function() Snacks.words.jump(1, true) end, { desc = "Next reference" })
map("n", "[[", function() Snacks.words.jump(-1, true) end, { desc = "Previous reference" })

map("n", "gt", "<Cmd>BufferLineCycleNext<CR>", { desc = "Next file" })
map("n", "gT", "<Cmd>BufferLineCyclePrev<CR>", { desc = "Previous file" })
map({ "n", "i", "x" }, "<C-s>", "<Cmd>write<CR><Esc>", { desc = "Save" })
map("n", "<Esc>", "<Cmd>nohlsearch<CR>")
