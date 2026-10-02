return {
  {
    "neovim/nvim-lspconfig",
    config = function()

      -- TypeScript
      vim.lsp.config('ts_ls', {
        init_options = {
          tsserver = {
            path = vim.fn.expand("~/.local/share/mise/installs/npm-typescript/latest/lib/node_modules/typescript/lib/tsserver.js"),
          }
        }
      })

      vim.lsp.enable('ts_ls')

      -- Biome
      vim.lsp.enable("biome", {
        root_dir = function(fname)
          local root = util.root_pattern(".git")(fname)
          if not root then return nil end

          local found = vim.fs.find(
            { "biome.json", "biome.jsonc" },
            { path = root, upward = false }
          )

          if #found == 0 then return nil end

          return root
        end,
      })

    end
  }
}
