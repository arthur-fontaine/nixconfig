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
    # Copies Ghostty's selection; with none, cmd+c goes to the program, so Pi's
    # fullscreen mode (which draws its own selection) can copy it.
    keybind = performable:cmd+c=copy_to_clipboard
    keybind = alt+delete=text:\x1bd
    keybind = global:cmd+ctrl+t=toggle_quick_terminal

    theme = dark:Ayu Mirage,light:Ayu Light

    macos-option-as-alt = true

    adjust-cell-height = 10
  '';

  xdg.configFile."ghostty/themes/zed-mono-dark".source = ./themes/zed-mono-dark;
  xdg.configFile."ghostty/themes/zed-mono-light".source = ./themes/zed-mono-light;
}
