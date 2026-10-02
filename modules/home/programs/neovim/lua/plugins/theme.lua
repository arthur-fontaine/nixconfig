return {
  "Shatur/neovim-ayu",
  lazy = false,
  priority = 1000,
  config = function()
    require('ayu').setup({
      mirage = false,
      terminal = true,
      overrides = function()
        if vim.o.background == 'dark' then
          return { NormalNC = {bg = '#0f151e', fg = '#808080'} }
        else
          return { NormalNC = {bg = '#eae8e8', fg = '#808080'} }
        end
      end,
    })
    
    -- Détection automatique du mode clair/sombre système
    -- Utilise $THEME_MODE ou détecte via les paramètres macOS/Linux
    local function get_system_appearance()
      -- Pour macOS
      local handle = io.popen("defaults read -g AppleInterfaceStyle 2>/dev/null")
      if handle then
        local result = handle:read("*a")
        handle:close()
        if result: match("Dark") then
          return "dark"
        else
          return "light"
        end
      end
      
      -- Fallback:  utiliser la variable d'environnement si disponible
      local theme = os.getenv("THEME_MODE")
      if theme then
        return theme
      end
      
      -- Par défaut
      return "dark"
    end
    
    local appearance = get_system_appearance()
    
    if appearance == "light" then
      vim.cmd("colorscheme ayu-light")
    else
      vim.cmd("colorscheme ayu-dark")
    end
  end,
}
