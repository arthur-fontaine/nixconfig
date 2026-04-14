# nixconfig

Converted from `~/.local/share/chezmoi` and selected `~/.config` files.

## Structure

- `flake.nix`: entrypoint.
- `modules/darwin/default.nix`: macOS + Homebrew layer.
- `modules/home/default.nix`: Home Manager layer.
- `modules/home/shell.nix`: zsh setup.
- `modules/home/dev.nix`: VS Code extensions and Go/Cargo tool install hooks.
- `modules/home/files.nix`: exact file mappings.
- `modules/home/files/**`: raw config files copied from your current setup.

## Notes

- I kept your app/tool lists from `.Brewfile`.
- I copied your config files verbatim where possible so behavior stays the same.
- Generated/computed shell behavior still comes from your original zsh files.
- Secrets/auth state files from tools such as `gh`, `gcloud`, `1password`, etc. were not copied.
- This repo has not run `nix` locally.

## Apply later

When you are ready on your machine:

```sh
sudo nix run nix-darwin -- switch --flake .#Arthur-Mac
```
