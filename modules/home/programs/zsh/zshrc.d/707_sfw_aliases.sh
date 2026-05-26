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

if command -v sfw &>/dev/null; then
  alias npm='sfw npm'
  alias yarn='sfw yarn'
  alias pnpm='sfw pnpm'
  alias pip='sfw pip'
  alias uv='sfw uv'
  alias cargo='sfw cargo'
fi
