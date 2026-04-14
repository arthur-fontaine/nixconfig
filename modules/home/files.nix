{ ... }:
{
  xdg.configFile."ghostty/config".source = ./files/ghostty/config;
  xdg.configFile."ghostty/themes/zed-mono-dark".source = ./files/ghostty/themes/zed-mono-dark;
  xdg.configFile."ghostty/themes/zed-mono-light".source = ./files/ghostty/themes/zed-mono-light;
  xdg.configFile."mise/config.toml".source = ./files/mise/config.toml;
  xdg.configFile."zed/keymap.json".source = ./files/zed/keymap.json;
  xdg.configFile."zed/settings.json".source = ./files/zed/settings.json;
  xdg.configFile."karabiner/karabiner.json".source = ./files/karabiner/karabiner.json;
  xdg.configFile."gh/config.yml".source = ./files/gh/config.yml;
  xdg.configFile."codex/config.toml".source = ./files/codex/config.toml;
  xdg.configFile."opencode/opencode.json".source = ./files/opencode/opencode.json;
  xdg.configFile."nix/nix.conf".source = ./files/nix/nix.conf;

  xdg.configFile."zsh/zsh_plugins.txt".source = ./files/zsh/zsh_plugins.txt;
  xdg.configFile."zsh/zshrc.d".source = ./files/zsh/zshrc.d;
  xdg.configFile."zsh/completions/_bun".source = ./files/zsh/completions/_bun;
  xdg.configFile."zsh/completions/_codex".source = ./files/zsh/completions/_codex;

  xdg.configFile."pi/agent/settings.json".source = ./files/pi/settings.json;
  xdg.configFile."pi/agent/nono-sandbox.json".source = ./files/pi/nono-sandbox.json;
  xdg.configFile."pi/agent/extensions".source = ./files/pi/extensions;

  home.file.".gitconfig".source = ./files/git/gitconfig;
  home.file.".p10k.zsh".source = ./files/zsh/p10k.zsh;
  home.file.".Brewfile".source = ./files/brew/Brewfile;
  home.file.".local/bin/env".source = ./files/local/bin/env;
}
