-- nvim --headless -u NONE -l tests/diff_test.lua: the hunks diff.lua sends.
local here = vim.fn.fnamemodify(debug.getinfo(1, "S").source:sub(2), ":h:h")
dofile(here .. "/diff.lua")
local fails = 0
local function eq(name, got, want)
  if vim.deep_equal(got, want) then return end
  fails = fails + 1
  print("FAIL " .. name .. "\n  got  " .. vim.inspect(got) .. "\n  want " .. vim.inspect(want))
end
local function kinds(r) local out = {} for _, h in ipairs(r.hunks) do local s = {} for _, l in ipairs(h.lines) do s[#s + 1] = l[1] .. (l[2] == vim.NIL and "_" or l[2]) .. "/" .. (l[3] == vim.NIL and "_" or l[3]) end out[#out + 1] = table.concat(s, " ") end return out end
local base = {}
for i = 1, 20 do base[i] = "line " .. i end

-- One replaced line in the middle: three lines around it, numbered on both sides.
local cur = vim.deepcopy(base); cur[10] = "changed"
local r = _G.herdr_diff_hunks(base, cur, nil)
eq("replace", kinds(r), { " 7/7  8/8  9/9 -10/_ +_/10  11/11  12/12  13/13" })
eq("counts", { r.add, r.del }, { 1, 1 })

-- Two changes 5 lines apart share a hunk; far apart they don't.
cur = vim.deepcopy(base); cur[3] = "a"; cur[9] = "b"
eq("near", #_G.herdr_diff_hunks(base, cur, nil).hunks, 1)
cur = vim.deepcopy(base); cur[2] = "a"; cur[18] = "b"
eq("far", #_G.herdr_diff_hunks(base, cur, nil).hunks, 2)

-- An inserted line and a deleted one keep the numbers right.
cur = vim.deepcopy(base); table.insert(cur, 5, "new")
eq("insert", kinds(_G.herdr_diff_hunks(base, cur, nil)), { " 2/2  3/3  4/4 +_/5  5/6  6/7  7/8" })
cur = vim.deepcopy(base); table.remove(cur, 5)
eq("delete", kinds(_G.herdr_diff_hunks(base, cur, nil)), { " 2/2  3/3  4/4 -5/_  6/5  7/6  8/7" })

-- A new file: every line added.
eq("new file", kinds(_G.herdr_diff_hunks({}, { "a", "b" }, nil)), { "+_/1 +_/2" })

-- The caret on an unchanged line far from the change brings its line (and one around) in.
cur = vim.deepcopy(base); cur[2] = "x"; table.insert(cur, 3, "y")
eq("caret", kinds(_G.herdr_diff_hunks(base, cur, 16)), { " 1/1 -2/_ +_/2 +_/3  3/4  4/5  5/6", " 14/15  15/16  16/17" })
-- On a line already shown, nothing more.
eq("caret inside", #_G.herdr_diff_hunks(base, cur, 4).hunks, 1)

-- Tabs read as two columns, as the view draws them.
eq("tabs", _G.herdr_diff_hunks({ "a" }, { "\tb" }, nil).hunks[1].lines[2][4], "  b")

if fails > 0 then print(fails .. " failing") os.exit(1) end
print("ok")
