{ lib, pkgs, ... }:
let
  toml = pkgs.formats.toml { };
in
{
  home.packages = [ pkgs.mise ];

  xdg.configFile."mise/config.toml".source = toml.generate "mise-config.toml" {
    tools = {
      node = "lts";
      deno = "latest";
      python = "latest";
      uv = "latest";
      go = "latest";
      rust = "latest";
      "npm:pnpm" = "12.9.1";
      "npm:bun" = "latest";
      "npm:yarn" = "latest";
      "npm:gitignore.cli" = "latest";
      "npm:@go-task/cli" = "latest";
      "npm:gacp" = "latest";
      "npm:typescript-language-server" = "latest";
      "npm:typescript" = "latest";
      "npm:osgrep" = "latest";
      "npm:sfw" = "latest";
      # mbx: shared Cargo build cache. Not in the mise registry yet. Pinned:
      # once a version is installed, mise keeps resolving `latest` to it.
      "github:jdx/mr-boxington" = "1.28.0";
      # blaze's engine, `ra-jit`, which mbx's blaze setting runs dev builds
      # through. Only nightly builds are published so far.
      "github:indexable-inc/blaze" = "nightly";
    };

    settings = {
      idiomatic_version_file_enable_tools = [ "python" ];
    };
  };

  # Install the tools declared above whenever the config changes. Runs after
  # writeBoundary so config.toml is already in place. mise itself comes from
  # home.packages, so this works on a first-time activation.
  #
  # mise must be on PATH (not just invoked by absolute path) because the
  # shims it generates — e.g. ~/.local/share/mise/installs/node/<v>/bin/npm
  # for `npm:*` tools — shell out to `mise` by name to resolve binaries.
  home.activation.miseInstall = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    export PATH="${pkgs.mise}/bin:$PATH"
    $DRY_RUN_CMD mise install --yes || true
  '';
}
