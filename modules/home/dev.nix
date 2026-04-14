{ lib, ... }:
let
  vscodeExtensions = import ./lists/vscode-extensions.nix;
  goTools = import ./lists/go-tools.nix;
  cargoBins = import ./lists/cargo-bins.nix;

  asLines = items: lib.concatStringsSep "\n" items;
in
{
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
