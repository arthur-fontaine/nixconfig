{ ... }:
{
  xdg.configFile."opencode/opencode.json".text = builtins.toJSON {
    "$schema" = "https://opencode.ai/config.json";

    mcp = {
      Context7 = {
        type = "remote";
        url = "https://mcp.context7.com/mcp";
      };

      Playwright = {
        type = "local";
        command = [ "npx" "@playwright/mcp@latest" ];
        enabled = true;
      };
    };
  };
}
