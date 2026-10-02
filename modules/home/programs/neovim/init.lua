vim.keymap.set('n', ';', ':', { noremap = true })
vim.keymap.set('n', ':', ';', { noremap = true })

vim.opt.number = true
vim.opt.guicursor = { "n:block", "v:block", "i:ver35", "c:block", "r:block" }
vim.opt.clipboard = "unnamedplus"
vim.opt.equalalways = false

require("config.lazy")

