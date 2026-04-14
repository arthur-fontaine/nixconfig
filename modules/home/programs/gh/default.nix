{ ... }:
{
  programs.gh = {
    enable = true;

    settings = {
      version = 1;
      git_protocol = "https";
      prompt = "enabled";
      prefer_editor_prompt = "disabled";
      color_labels = "disabled";
      accessible_colors = "disabled";
      accessible_prompter = "disabled";
      spinner = "enabled";

      aliases = {
        co = "pr checkout";
      };
    };
  };
}
