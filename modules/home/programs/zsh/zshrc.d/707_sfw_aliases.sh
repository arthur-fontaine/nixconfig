# Wrap package managers with Socket Firewall for supply-chain protection.
# sfw spins up an ephemeral proxy and checks each package against the Socket API
# before letting the package manager fetch it.
# https://socket.dev/blog/introducing-socket-firewall
#
# sfw is installed by mise (see modules/home/programs/mise). The guard below
# keeps the shell working if mise hasn't installed it yet on a fresh setup.
# Clear caches once so sfw can actually see the requests:
#   npm cache clean --force
#   pnpm store prune
#   pip cache purge
#   cargo cache --autoclean    # or: rm -rf ~/.cargo/registry/cache

# cargo goes through mbx (shared build cache, see modules/home/programs/mbx)
# when it's installed. sfw must stay the outer wrapper: mbx passes sfw's proxy
# env down to the real cargo, the reverse would bypass the firewall. Falls
# back to plain cargo on a fresh setup.
cargo_cmd=cargo
mbx_cargo_shim="$HOME/.local/share/mbx-cargo-shim/cargo"
if command -v mbx &>/dev/null && [[ -x $mbx_cargo_shim ]]; then
  cargo_cmd=$mbx_cargo_shim
  alias cargo="${(q)cargo_cmd}"
fi

if command -v sfw &>/dev/null; then
  alias npm='sfw npm'
  alias npx='sfw npx'
  alias yarn='sfw yarn'
  alias pnpm='sfw pnpm'
  alias pnpx='sfw pnpx'
  alias bun='sfw bun'
  alias bunx='sfw bunx'
  alias pip='sfw pip'
  alias uv='sfw uv'
  alias cargo="sfw ${(q)cargo_cmd}"
fi
unset cargo_cmd mbx_cargo_shim
