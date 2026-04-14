{ lib, ... }:
let
  vscodeExtensions = builtins.concatLists [
    (import ./vscode-theme-and-ui.nix)
    (import ./vscode-languages-and-frameworks.nix)
    (import ./vscode-workflow-and-tools.nix)
  ];

  goTools = import ./go-tools.nix;
  cargoBins = import ./cargo-bins.nix;

  asLines = items: lib.concatStringsSep "\n" items;
in
{
  # Keep these installs grouped here because they extend tools installed by Homebrew,
  # but are still easier to maintain as explicit lists than as many tiny Nix modules.
  home.activation.installDevTools = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"

    if command -v code >/dev/null 2>&1; then
      while IFS= read -r extension; do
        [ -n "$extension" ] || continue
        code --install-extension "$extension" --force || true
      done <<'EOF'
${asLines vscodeExtensions}
EOF
    fi

    if command -v go >/dev/null 2>&1; then
      while IFS= read -r tool; do
        [ -n "$tool" ] || continue

        case "$tool" in
          cmd/go|cmd/gofmt)
            continue
            ;;
        esac

        go install "$tool@latest" || true
      done <<'EOF'
${asLines goTools}
EOF
    fi

    if command -v cargo >/dev/null 2>&1; then
      while IFS= read -r bin; do
        [ -n "$bin" ] || continue
        cargo install "$bin" || true
      done <<'EOF'
${asLines cargoBins}
EOF
    fi
  '';
}
