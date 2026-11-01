{ pkgs, ... }:
let
  plugins = with pkgs.vimPlugins; [
    # mini.base16 (the terminal's palette as a theme) and mini.icons.
    mini-nvim
    snacks-nvim
    blink-cmp
    nvim-lspconfig
    gitsigns-nvim
    bufferline-nvim
    lualine-nvim
    which-key-nvim
    (nvim-treesitter.withPlugins (g: with g; [
      bash css diff dockerfile gitcommit go html javascript json lua markdown
      markdown_inline nix python query regex rust sql swift toml tsx typescript
      vim vimdoc yaml
    ]))
  ];

  # Neovim itself is Homebrew's (brews-dev-workflow.nix). Plugins go where it
  # looks for packages on its own, ~/.local/share/nvim/site/pack.
  pack = pkgs.vimUtils.packDir { nix.start = plugins; };

  # Exits 0 while Command is held: Cmd+click (init.lua).
  cmdHeld = pkgs.runCommandCC "cmd-held" { } ''
    mkdir -p $out/bin
    $CC -O2 -framework CoreGraphics ${./cmd-held/cmd-held.c} -o $out/bin/cmd-held
  '';

  # On Neovim's PATH only (init.lua), not the shell's.
  servers = pkgs.symlinkJoin {
    name = "neovim-tools";
    paths = with pkgs; [
      cmdHeld
      typescript-language-server
      typescript
      vscode-langservers-extracted
      tailwindcss-language-server
      biome
      yaml-language-server
      nixd
      lua-language-server
    ];
  };
in
{
  xdg.configFile."nvim/init.lua".text = ''
    vim.env.PATH = "${servers}/bin:" .. vim.env.PATH
    ${builtins.readFile ./init.lua}
  '';
  xdg.dataFile."nvim/site/pack".source = "${pack}/pack";
}
