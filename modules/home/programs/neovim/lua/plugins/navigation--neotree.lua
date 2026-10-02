return {
  {
    "nvim-neo-tree/neo-tree.nvim",
    branch = "v3.x",
    dependencies = {
      "nvim-lua/plenary.nvim",
      "MunifTanjim/nui.nvim",
      "nvim-tree/nvim-web-devicons",
    },
    lazy = false,
    config = function()
      -- buffers = { follow_current_file = { enabled = true } }

      require("neo-tree").setup({
        window = {
          position = "right",
          width = 40,
          auto_expand_width = false,
          mappings = {
            ["<space>"] = "none",
            ["<Right>"] =  function(state)
              local node = state.tree:get_node()
              if node.type == "directory" and not node:is_expanded() then
                state.commands.toggle_node(state)
              end
            end,
            ["<Left>"]  = "close_node",
            ["l"]     =  function(state)
              local node = state.tree:get_node()
              if node.type == "directory" and not node:is_expanded() then
                state.commands.toggle_node(state)
              end
            end,
            ["h"]     = "close_node",
            ["<Esc>"] = function(state)
	      vim.cmd("wincmd p")
	    end,
          },
        },
        buffers = {
          follow_current_file = {
            enabled = true,
          },
        },
        event_handlers = {
          {
            event = require("neo-tree.events").NEO_TREE_BUFFER_ENTER,
            handler = function()
              vim.g._neotree_saved_guicursor = vim.o.guicursor
              vim.o.guicursor = "a:ver1,a:blinkon0"
            end,
          },
          {
            event = require("neo-tree.events").NEO_TREE_BUFFER_LEAVE,
            handler = function()
              if vim.g._neotree_saved_guicursor then
                vim.o.guicursor = vim.g._neotree_saved_guicursor
                vim.g._neotree_saved_guicursor = nil
              end
            end,
          },
        },
      })
    end,
    keys = {
      {
        "<leader>e",
        function()
          local neo_tree = require("neo-tree.sources.manager")
          local state = neo_tree.get_state("filesystem")
      
          if not state or not state.winid or not vim.api.nvim_win_is_valid(state.winid) then
            vim.cmd("Neotree focus reveal")
          elseif vim.api.nvim_get_current_win() ~= state.winid then
            vim.api.nvim_set_current_win(state.winid)
          else
            vim.cmd("Neotree close")
          end
        end,
        desc = "File Explorer",
      },
    }
  },
}

