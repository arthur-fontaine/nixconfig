{ ... }:
{
  xdg.configFile."ghostty/config".text = ''
    window-padding-x = 8
    window-padding-y = 8

    # macos-titlebar-style = "tabs"

    font-family = "JetBrains Mono"

    bold-is-bright = true

    keybind = cmd+alt+left=previous_tab
    keybind = cmd+alt+right=next_tab
    keybind = cmd+backspace=text:\x15
    keybind = global:cmd+ctrl+t=toggle_quick_terminal

    theme = dark:Ayu Mirage,light:Ayu Light

    macos-option-as-alt = left

    adjust-cell-height = 10
  '';

  xdg.configFile."ghostty/themes/zed-mono-dark".source = ../files/ghostty/themes/zed-mono-dark;
  xdg.configFile."ghostty/themes/zed-mono-light".source = ../files/ghostty/themes/zed-mono-light;
}
