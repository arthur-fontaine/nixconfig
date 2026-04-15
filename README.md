# nixconfig

If you land on this repo and want to configure a Mac with it, start here.

## What this gives you

This repo installs and manages:

- macOS defaults
- Homebrew formulae and casks
- shell setup
- Git, GitHub CLI, Zed, Ghostty, Karabiner, Pi, Codex, OpenCode, Mise, and more
- development tooling such as VS Code extensions, Go tools, and Cargo binaries

It is designed for Apple Silicon Macs but it might work on Intel Macs too (I have not tested it).

## Quick start

Paste this into a fresh macOS terminal:

```sh
tmp="$(mktemp -t nixconfig-bootstrap.XXXXXX.sh)" &&
curl -fsSL https://raw.githubusercontent.com/arthur-fontaine/nixconfig/main/scripts/bootstrap-macos.sh -o "$tmp" &&
chmod +x "$tmp" &&
"$tmp"
```

The bootstrap script will:

1. ask you for the machine-specific values it cannot guess safely
2. install Apple Command Line Tools if needed
3. install Nix
4. install Homebrew
5. clone this repo locally
6. create `hosts/local.nix` for your machine
7. run `darwin-rebuild switch`

### What it asks you

The script prompts for:

- the local host/configuration name
- your macOS username
- your Git author name
- your Git author email
- an optional Git SSH signing key

### Important note

If Apple Command Line Tools are not already installed, macOS may open a system dialog during bootstrap. Approve it, let it finish, then return to the terminal and continue.

## After the install

Some app sign-ins and permissions are still intentionally manual.
See:

- [`MANUAL_SETUP.md`](./MANUAL_SETUP.md)

## Updating later

Once the machine is bootstrapped:

```sh
cd ~/nixconfig
sudo darwin-rebuild switch --flake "path:$PWD#<your-host-name>"
```

If you installed the repo somewhere else, replace `~/nixconfig` with your chosen path.
Use the `path:` prefix as long as your machine definition lives in git-ignored `hosts/local.nix`.

## Manual setup path

If you do not want to run the bootstrap script, the manual flow is:

1. install Apple Command Line Tools
2. install Nix
3. install Homebrew
4. clone the repo
5. create `hosts/local.nix` from `hosts/local.nix.example`
6. run:

```sh
sudo nix --extra-experimental-features 'nix-command flakes' \
  run github:LnL7/nix-darwin/master#darwin-rebuild -- switch --flake "path:$PWD#<your-host-name>"
```

## Host configuration

Machine-specific values live in one of these files:

- `hosts/shared.nix`: tracked hosts already in the repo
- `hosts/local.nix`: local machine config created by the bootstrap script
- `hosts/local.nix.example`: template for manual setup

`hosts/local.nix` is git-ignored on purpose, so you can bootstrap a new machine without editing tracked files first.
If you want to version your host definition, move it into `hosts/shared.nix` after the first successful install.

## Use your fork instead of this repo

If you fork this repository, you can still use the same bootstrap script while pointing it at your fork:

```sh
tmp="$(mktemp -t nixconfig-bootstrap.XXXXXX.sh)" &&
curl -fsSL https://raw.githubusercontent.com/arthur-fontaine/nixconfig/main/scripts/bootstrap-macos.sh -o "$tmp" &&
chmod +x "$tmp" &&
NIXCONFIG_REPO_URL=https://github.com/<you>/nixconfig.git "$tmp"
```

## Want the implementation details?

The technical structure was moved out of the main README.
See:

- [`docs/repository-layout.md`](./docs/repository-layout.md)
