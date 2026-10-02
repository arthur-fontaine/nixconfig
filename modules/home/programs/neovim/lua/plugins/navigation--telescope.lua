return {
  {
    'nvim-telescope/telescope.nvim',
    version = '*',
    dependencies = {
      'nvim-lua/plenary.nvim',
      { 'nvim-telescope/telescope-fzf-native.nvim', build = 'make' },
      'nvim-telescope/telescope-frecency.nvim',
    },
    config = function()
      local telescope = require('telescope')

      telescope.setup({
        extensions = {
          fzf = {
            fuzzy = true,
            override_generic_sorter = true,
            override_file_sorter = true,
            case_mode = 'smart_case',
          },
          frecency = {
            show_scores = false,
            show_unindexed = true,
            auto_validate = true,
            matcher = "fuzzy",
            path_display = { "filename_first" },
          },
        },
      })

      telescope.load_extension('fzf')
      telescope.load_extension('frecency')
    end,
    keys = {
      -- {
      --   '<leader><leader>',
      --   function()
      --     require("telescope").extensions.frecency.frecency()
      --   end,
      --   desc = 'Find files',
      -- },
      {
        "<leader><leader>",
        "<cmd>Telescope frecency workspace=CWD<cr>",
        mode = "n",
        desc = "Find files",
      },
    },
  }
}
