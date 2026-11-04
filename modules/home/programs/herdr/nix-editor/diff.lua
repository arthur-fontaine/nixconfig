-- The backend of nix-diff's editable diff: one `nvim --embed` per diff tab holding each
-- changed file as a buffer. Neovim edits; this file diffs each buffer against its HEAD
-- version (vim.diff) after every change and sends the hunks to the view, which draws them
-- as the diff it always drew. Same setup as the editor (init.lua), without its language
-- servers: a diff tab stays one light process however many files it shows.
vim.g.herdr_diff = 1
local here = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h")
dofile(here .. "/init.lua")

-- Tabs as the view draws them (2 columns), so a column here is a column there.
vim.o.tabstop = 2
vim.o.swapfile = false
-- The view keeps the caret in sight: no scrolling of a window nobody sees.
vim.o.scrolloff = 0

local CONTEXT = 3
local files = {} -- path → { buf, base, root, rel, head, shown }
local by_buf = {}
local queued = {}

local function git_lines(root, rel)
  if not rel then return {} end
  local r = vim.system({ "git", "-C", root, "--no-optional-locks", "show", "HEAD:" .. rel }, { text = true }):wait()
  if r.code ~= 0 then return {} end
  local lines = vim.split(r.stdout, "\n", { plain = true })
  if lines[#lines] == "" then table.remove(lines) end
  return lines
end

local function mtime(path)
  local st = vim.uv.fs_stat(path)
  return st and (st.mtime.sec .. "." .. st.mtime.nsec) or nil
end

local function joined(lines) return #lines > 0 and table.concat(lines, "\n") .. "\n" or "" end
local function display(text) return (text:gsub("\t", "  ")) end

-- The changes as blocks: removed base lines [a, a + ac) replaced by buffer lines [b, b + bc).
local function blocks(f, cur)
  local out = {}
  local idx = vim.diff(joined(f.base), joined(cur), { result_type = "indices", algorithm = "histogram", indent_heuristic = true })
  for _, h in ipairs(idx) do
    local a, ac, b, bc = h[1], h[2], h[3], h[4]
    out[#out + 1] = { a = ac == 0 and a + 1 or a, ac = ac, b = bc == 0 and b + 1 or b, bc = bc }
  end
  return out
end

-- The rows of the diff: hunks of changed lines with CONTEXT lines around, as git shows them,
-- plus the caret's line when it is in this file (it stays in sight while it moves through
-- unchanged lines). Each line is { kind, old, new, text }.
local function hunks_of(f, cur, caret)
  local bl = blocks(f, cur)
  local add, del = 0, 0
  for _, k in ipairs(bl) do add, del = add + k.bc, del + k.ac end
  local marks = vim.deepcopy(bl)
  if caret then
    -- Where the caret's line sits in the base: past the blocks before it, shifted by them.
    local shift, inside = 0, false
    for _, k in ipairs(bl) do
      if caret >= k.b and caret < k.b + k.bc then inside = true end
      if k.b + k.bc <= caret then shift = shift + k.ac - k.bc end
    end
    if not inside then marks[#marks + 1] = { a = caret + shift, ac = 0, b = caret, bc = 0, caret = true } end
    table.sort(marks, function(x, y) return x.b < y.b or (x.b == y.b and x.a < y.a) end)
  end
  local out, shown = {}, {}
  local i = 1
  while i <= #marks do
    -- A hunk: blocks whose context touches, as git groups them.
    local j = i
    local reach = function(k) return k.b + math.max(k.bc, k.caret and 1 or 0) - 1 + (k.caret and 1 or CONTEXT) end
    while j < #marks and marks[j + 1].b - (marks[j + 1].caret and 1 or CONTEXT) <= reach(marks[j]) + 1 do j = j + 1 end
    local first, last = marks[i], marks[j]
    local before = first.caret and 1 or CONTEXT
    local b = math.max(1, first.b - before)
    local a = first.a - (first.b - b)
    local stop = math.min(#cur, reach(last))
    local lines = {}
    local hunk = { oldStart = a, newStart = b, lines = lines }
    for k = i, j do
      local m = marks[k]
      while b < m.b do lines[#lines + 1] = { " ", a, b, display(cur[b]) }; a, b = a + 1, b + 1 end
      for x = m.a, m.a + m.ac - 1 do lines[#lines + 1] = { "-", x, vim.NIL, display(f.base[x] or "") } end
      for y = m.b, m.b + m.bc - 1 do lines[#lines + 1] = { "+", vim.NIL, y, display(cur[y] or "") } end
      a, b = m.a + m.ac, m.b + m.bc
    end
    while b <= stop do lines[#lines + 1] = { " ", a, b, display(cur[b]) }; a, b = a + 1, b + 1 end
    shown[#shown + 1] = { hunk.newStart, stop }
    out[#out + 1] = hunk
    i = j + 1
  end
  return out, add, del, shown
end

local function caret_line(f)
  if vim.api.nvim_get_current_buf() ~= f.buf then return nil end
  return vim.api.nvim_win_get_cursor(0)[1]
end

local function send(path)
  queued[path] = nil
  local f = files[path]
  if not f or not vim.api.nvim_buf_is_valid(f.buf) then return end
  local cur = vim.api.nvim_buf_get_lines(f.buf, 0, -1, false)
  local hunks, add, del, shown = hunks_of(f, cur, caret_line(f))
  f.shown = shown
  vim.rpcnotify(0, "herdr_diff", { file = path, hunks = hunks, add = add, del = del, modified = vim.bo[f.buf].modified })
end

-- Changes come by the keystroke: one diff per batch, sent before the next redraw.
local function queue(path)
  if queued[path] then return end
  queued[path] = true
  vim.schedule(function() send(path) end)
end

-- Where the caret is (line, display column), and the selection when there is one, for the
-- view to draw. A caret moving out of the lines shown sends the hunks again, with its line.
local function caret()
  local buf = vim.api.nvim_get_current_buf()
  local path = by_buf[buf]
  if not path then return end
  local f = files[path]
  local line = vim.api.nvim_win_get_cursor(0)[1]
  local inside = false
  for _, r in ipairs(f.shown or {}) do if line >= r[1] and line <= r[2] then inside = true end end
  if not inside then send(path) end
  local mode = vim.api.nvim_get_mode().mode
  local sel = vim.NIL
  if mode:match("^[vVsS\22\19]") then
    local v, c = vim.fn.getpos("v"), vim.fn.getpos(".")
    local from, to = { v[2], vim.fn.virtcol({ v[2], v[3] }) - 1 }, { c[2], vim.fn.virtcol({ c[2], c[3] }) - 1 }
    if from[1] > to[1] or (from[1] == to[1] and from[2] > to[2]) then from, to = to, from end
    local linewise = mode:match("^[VS]") ~= nil
    sel = { from = from, to = to, lines = linewise }
  end
  vim.rpcnotify(0, "herdr_diff_caret", { file = path, line = line, col = vim.fn.virtcol(".") - 1, mode = mode, sel = sel })
end
vim.api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI", "ModeChanged", "BufEnter" }, { callback = function() vim.schedule(caret) end })
vim.api.nvim_create_autocmd({ "BufWritePost", "BufModifiedSet" }, {
  callback = function(args)
    local path = by_buf[args.buf]
    if not path then return end
    if args.event == "BufWritePost" then files[path].mtime = mtime(path) end
    queue(path)
  end,
})

-- The files the view shows: { path, root, rel, base }, `base` the HEAD path (renames) or
-- nil (new files). Buffers of files no longer in the diff go, unless they have unsaved edits.
_G.herdr_diff_files = function(list)
  local keep = {}
  for _, item in ipairs(list) do
    keep[item.path] = true
    local f = files[item.path]
    if not f then
      local buf = vim.fn.bufadd(item.path)
      vim.fn.bufload(buf)
      vim.bo[buf].buflisted = true
      f = { buf = buf, root = item.root, rel = item.base, mtime = mtime(item.path) }
      files[item.path], by_buf[buf] = f, item.path
      vim.api.nvim_buf_attach(buf, false, { on_lines = function() queue(item.path) end, on_reload = function() queue(item.path) end })
    end
    -- Its HEAD version, read again only when HEAD moved (a commit): a save lists the files
    -- again, and a git process per file at each save would be most of its cost.
    local head = vim.system({ "git", "-C", item.root, "--no-optional-locks", "rev-parse", "-q", "--verify", "HEAD" }, { text = true }):wait().stdout
    if f.head ~= head or f.rel ~= item.base then
      f.head, f.rel = head, item.base
      f.base = git_lines(item.root, item.base)
      queue(item.path)
    end
  end
  for path, f in pairs(files) do
    if not keep[path] and not vim.bo[f.buf].modified then
      files[path], by_buf[f.buf] = nil, nil
      pcall(vim.api.nvim_buf_delete, f.buf, { force = true })
    end
  end
  -- Edits made on disk (an agent) come in for buffers without changes of their own
  -- (:checktime leaves a buffer no window shows as it was).
  for path, f in pairs(files) do
    local now = mtime(path)
    if now and now ~= f.mtime and not vim.bo[f.buf].modified then
      f.mtime = now
      vim.api.nvim_buf_call(f.buf, function() vim.cmd("silent! edit") end)
      queue(path)
    end
  end
end

-- A click in the diff: the caret in that file, on that line, at that display column.
_G.herdr_diff_focus = function(path, line, col)
  local f = files[path]
  if not f then return end
  if vim.api.nvim_get_current_buf() ~= f.buf then vim.api.nvim_win_set_buf(0, f.buf) end
  local count = vim.api.nvim_buf_line_count(f.buf)
  line = math.max(1, math.min(line, count))
  local text = vim.api.nvim_buf_get_lines(f.buf, line - 1, line, false)[1] or ""
  local byte = col <= 0 and 0 or (vim.fn.virtcol2col(0, line, col + 1) or #text + 1) - 1
  if col >= vim.fn.strdisplaywidth(text) then byte = #text end
  if vim.fn.mode() ~= "i" then vim.cmd.startinsert() end
  vim.api.nvim_win_set_cursor(0, { line, byte })
  vim.schedule(caret)
end

-- ⌘S saves every file of the diff with unsaved edits, not only the one with the caret.
vim.keymap.set({ "n", "i", "v", "s", "x" }, "<D-s>", "<Cmd>silent! wall<CR>")

-- Leaving the diff's text: Normal mode, no caret drawn, edits kept.
_G.herdr_diff_blur = function()
  vim.cmd.stopinsert()
end

-- For the tests: the hunks of `cur` against `base`, the caret on line `caret` (or nil).
_G.herdr_diff_hunks = function(base, cur, caret)
  local hunks, add, del = hunks_of({ base = base }, cur, caret)
  return { hunks = hunks, add = add, del = del }
end
