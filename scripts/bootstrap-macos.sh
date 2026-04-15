#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${NIXCONFIG_REPO_URL:-https://github.com/arthur-fontaine/nixconfig.git}"
BOOTSTRAP_URL="${NIXCONFIG_BOOTSTRAP_URL:-https://raw.githubusercontent.com/arthur-fontaine/nixconfig/main/scripts/bootstrap-macos.sh}"
DEFAULT_REPO_DIR="${NIXCONFIG_REPO_DIR:-$HOME/nixconfig}"
NIX_INSTALLER_URL="https://install.determinate.systems/nix"
HOMEBREW_INSTALL_URL="https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh"

if [ ! -t 0 ] && [ ! -r "${BASH_SOURCE[0]:-}" ] && [ -z "${NIXCONFIG_BOOTSTRAP_REEXEC:-}" ]; then
  tmp_script="$(mktemp -t nixconfig-bootstrap.XXXXXX.sh)"
  trap 'rm -f "$tmp_script"' EXIT
  curl -fsSL "$BOOTSTRAP_URL" -o "$tmp_script"
  chmod +x "$tmp_script"

  if [ -r /dev/tty ] && [ -w /dev/tty ]; then
    NIXCONFIG_BOOTSTRAP_REEXEC=1 exec </dev/tty >/dev/tty 2>/dev/tty bash "$tmp_script" "$@"
  fi

  die "Interactive terminal required. Re-run from Terminal app, or download script then run it locally."
fi

if [ -t 1 ]; then
  BOLD='\033[1m'
  DIM='\033[2m'
  RED='\033[31m'
  GREEN='\033[32m'
  YELLOW='\033[33m'
  BLUE='\033[34m'
  CYAN='\033[36m'
  RESET='\033[0m'
else
  BOLD=''
  DIM=''
  RED=''
  GREEN=''
  YELLOW=''
  BLUE=''
  CYAN=''
  RESET=''
fi

say() {
  printf '%b\n' "$1"
}

step() {
  say "${BLUE}▶${RESET} ${BOLD}$1${RESET}"
}

info() {
  say "${CYAN}ℹ${RESET} $1"
}

ok() {
  say "${GREEN}✓${RESET} $1"
}

warn() {
  say "${YELLOW}!${RESET} $1"
}

die() {
  say "${RED}✗${RESET} $1" >&2
  exit 1
}

trim() {
  printf '%s' "$1" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
}

init_input_source() {
  if [ -t 0 ] && [ -t 1 ]; then
    return
  fi

  die "Interactive terminal required. Re-run from Terminal app, or download script then run it locally."
}

expand_path() {
  case "$1" in
    ~)
      printf '%s' "$HOME"
      ;;
    ~/*)
      printf '%s/%s' "$HOME" "${1#~/}"
      ;;
    *)
      printf '%s' "$1"
      ;;
  esac
}

nix_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\${/\\${/g'
}

prompt() {
  local label="$1"
  local default="${2:-}"
  local value

  if [ -n "$default" ]; then
    printf '%b?%b %s %b[%s]%b: ' "$CYAN" "$RESET" "$label" "$DIM" "$default" "$RESET" >&2
  else
    printf '%b?%b %s: ' "$CYAN" "$RESET" "$label" >&2
  fi

  IFS= read -r value || value=''
  if [ -z "$value" ]; then
    value="$default"
  fi

  printf '%s' "$value"
}

confirm() {
  local label="$1"
  local default="${2:-Y}"
  local reply
  local suffix='[Y/n]'

  if [ "$default" = "N" ]; then
    suffix='[y/N]'
  fi

  printf '%b?%b %s %b%s%b: ' "$CYAN" "$RESET" "$label" "$DIM" "$suffix" "$RESET" >&2
  IFS= read -r reply || reply=''
  reply="$(trim "$reply")"

  if [ -z "$reply" ]; then
    reply="$default"
  fi

  case "$reply" in
    Y|y|yes|YES)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

banner() {
  say ""
  say "${BOLD}════════════════════════════════════════════════════════════${RESET}"
  say "${BOLD}  nixconfig macOS bootstrap${RESET}"
  say "${DIM}  Nix + nix-darwin + Homebrew, from a fresh Mac to a ready setup${RESET}"
  say "${BOLD}════════════════════════════════════════════════════════════${RESET}"
  say ""
}

require_macos() {
  [ "$(uname -s)" = "Darwin" ] || die "This bootstrap script only supports macOS."
}

detect_system() {
  case "$(uname -m)" in
    arm64)
      printf 'aarch64-darwin'
      ;;
    x86_64)
      printf 'x86_64-darwin'
      ;;
    *)
      die "Unsupported macOS architecture: $(uname -m)"
      ;;
  esac
}

ensure_sudo() {
  step "Requesting administrator access"
  sudo -v
  while true; do
    sudo -n true 2>/dev/null || exit 0
    sleep 60
  done &
  SUDO_KEEPALIVE_PID=$!
  trap 'kill "$SUDO_KEEPALIVE_PID" >/dev/null 2>&1 || true' EXIT
  ok "Sudo access ready"
}

ensure_command_line_tools() {
  if xcode-select -p >/dev/null 2>&1; then
    ok "Apple Command Line Tools already installed"
    return
  fi

  step "Installing Apple Command Line Tools"
  warn "macOS may open a system dialog. Please approve the installation."
  xcode-select --install >/dev/null 2>&1 || true

  until xcode-select -p >/dev/null 2>&1; do
    printf '%b↳%b Press %bEnter%b once Command Line Tools finish installing... ' "$DIM" "$RESET" "$BOLD" "$RESET" >&2
    IFS= read -r _ || true
    sleep 2
  done

  ok "Apple Command Line Tools installed"
}

ensure_nix() {
  if command -v nix >/dev/null 2>&1; then
    ok "Nix already installed"
  else
    step "Installing Nix"
    curl --proto '=https' --tlsv1.2 -fsSL "$NIX_INSTALLER_URL" | sh -s -- install --determinate --no-confirm
    ok "Nix installed"
  fi

  if [ -e /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh ]; then
    # shellcheck disable=SC1091
    . /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
  fi

  export PATH="/nix/var/nix/profiles/default/bin:$PATH"
  command -v nix >/dev/null 2>&1 || die "Nix was installed but is not available in PATH."
}

ensure_homebrew() {
  if command -v brew >/dev/null 2>&1; then
    ok "Homebrew already installed"
  else
    step "Installing Homebrew"
    NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL "$HOMEBREW_INSTALL_URL")"
    ok "Homebrew installed"
  fi

  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [ -x /usr/local/bin/brew ]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
}

sync_repo() {
  local repo_dir="$1"

  mkdir -p "$(dirname "$repo_dir")"

  if [ -d "$repo_dir/.git" ]; then
    step "Updating repository"
    git -C "$repo_dir" remote set-url origin "$REPO_URL" || true
    git -C "$repo_dir" fetch --all --prune
    git -C "$repo_dir" pull --ff-only
    ok "Repository updated at $repo_dir"
    return
  fi

  if [ -e "$repo_dir" ] && [ -n "$(ls -A "$repo_dir" 2>/dev/null || true)" ]; then
    die "Target directory already exists and is not an existing git clone: $repo_dir"
  fi

  if [ -d "$repo_dir" ]; then
    rmdir "$repo_dir" 2>/dev/null || true
  fi

  step "Cloning repository"
  git clone "$REPO_URL" "$repo_dir"
  ok "Repository cloned to $repo_dir"
}

write_host_file() {
  local repo_dir="$1"
  local host_key="$2"
  local system="$3"
  local username="$4"
  local git_name="$5"
  local git_email="$6"
  local git_signing_key="$7"
  local host_file="$repo_dir/hosts/local.nix"
  local backup_file
  local path

  mkdir -p "$repo_dir/hosts"

  if [ -f "$host_file" ]; then
    backup_file="$host_file.bak-$(date +%Y%m%d-%H%M%S)"
    cp "$host_file" "$backup_file"
    info "Backed up existing host file to $backup_file"
  fi

  {
    printf '{\n'
    printf '  "%s" = {\n' "$(nix_escape "$host_key")"
    printf '    system = "%s";\n' "$(nix_escape "$system")"
    printf '    username = "%s";\n' "$(nix_escape "$username")"
    printf '    gitName = "%s";\n' "$(nix_escape "$git_name")"
    printf '    gitEmail = "%s";\n' "$(nix_escape "$git_email")"

    if [ -n "$(trim "$git_signing_key")" ]; then
      printf '    gitSigningKey = "%s";\n' "$(nix_escape "$git_signing_key")"
    fi

    printf '  };\n'
    printf '}\n'
  } > "$host_file"

  ok "Wrote $host_file"
}

apply_configuration() {
  local repo_dir="$1"
  local host_key="$2"

  step "Applying nix-darwin configuration"
  sudo env PATH="$PATH" nix --extra-experimental-features 'nix-command flakes' \
    run github:LnL7/nix-darwin/master#darwin-rebuild -- switch --flake "path:$repo_dir#$host_key"
  ok "Configuration applied successfully"
}

main() {
  local detected_system
  local default_host_key
  local default_username
  local default_git_name
  local repo_dir
  local host_key
  local username
  local git_name
  local git_email
  local git_signing_key

  require_macos
  init_input_source
  banner

  detected_system="$(detect_system)"
  default_host_key="$(scutil --get LocalHostName 2>/dev/null || hostname -s || printf 'My-Mac')"
  default_host_key="$(printf '%s' "$default_host_key" | tr ' ' '-' | tr -cd '[:alnum:]._-')"
  default_username="$(id -un)"
  default_git_name="$(id -F 2>/dev/null || printf '')"

  step "Collecting machine-specific values"
  repo_dir="$(expand_path "$(prompt "Repository directory" "$DEFAULT_REPO_DIR")")"
  while printf '%s' "$repo_dir" | grep -q '[[:space:]]'; do
    warn "Please choose a repository directory without spaces."
    repo_dir="$(expand_path "$(prompt "Repository directory" "$DEFAULT_REPO_DIR")")"
  done

  while true; do
    host_key="$(prompt "Host configuration name" "$default_host_key")"
    if printf '%s' "$host_key" | grep -Eq '^[A-Za-z0-9._-]+$'; then
      break
    fi
    warn "Use only letters, numbers, dots, underscores, and hyphens."
  done

  username="$(prompt "macOS username" "$default_username")"

  while [ -z "$(trim "$username")" ]; do
    warn "Username cannot be empty."
    username="$(prompt "macOS username" "$default_username")"
  done

  git_name="$(prompt "Git author name" "$default_git_name")"
  while [ -z "$(trim "$git_name")" ]; do
    warn "Git author name cannot be empty."
    git_name="$(prompt "Git author name" "$default_git_name")"
  done

  git_email="$(prompt "Git author email" "")"
  while [ -z "$(trim "$git_email")" ]; do
    warn "Git author email cannot be empty."
    git_email="$(prompt "Git author email" "")"
  done

  git_signing_key="$(prompt "Git SSH signing key (optional)" "")"

  say ""
  say "${BOLD}Summary${RESET}"
  say "  Repo directory : ${repo_dir}"
  say "  System         : ${detected_system}"
  say "  Host name      : ${host_key}"
  say "  Username       : ${username}"
  say "  Git name       : ${git_name}"
  say "  Git email      : ${git_email}"
  if [ -n "$(trim "$git_signing_key")" ]; then
    say "  Git signing    : enabled"
  else
    say "  Git signing    : disabled"
  fi
  say ""

  confirm "Continue with this setup?" "Y" || die "Bootstrap cancelled."

  ensure_sudo
  ensure_command_line_tools
  ensure_nix
  ensure_homebrew
  sync_repo "$repo_dir"
  write_host_file "$repo_dir" "$host_key" "$detected_system" "$username" "$git_name" "$git_email" "$git_signing_key"
  apply_configuration "$repo_dir" "$host_key"

  say ""
  ok "Your Mac is now configured from this repo."
  info "Manual follow-up: $repo_dir/MANUAL_SETUP.md"
  info "Host config file: $repo_dir/hosts/local.nix"
  info "Next update     : cd $repo_dir && sudo darwin-rebuild switch --flake path:$repo_dir#$host_key"
  say ""
}

main "$@"
