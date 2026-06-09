# dnsmasq: resolve every *.localhost domain to 127.0.0.1
#
# macOS resolves `localhost` itself, but not arbitrary `*.localhost`
# subdomains (Safari in particular refuses them). Pointing a local dnsmasq
# at the `localhost` TLD fixes this for all browsers.
#
# This single declaration replaces the manual setup:
#   brew install dnsmasq
#   echo 'address=/.localhost/127.0.0.1' >> $(brew --prefix)/etc/dnsmasq.conf
#   sudo brew services start dnsmasq
#   sudo mkdir -p /etc/resolver
#   echo 'nameserver 127.0.0.1' | sudo tee /etc/resolver/localhost
#
# The module installs pkgs.dnsmasq, runs it as a root launchd daemon
# (KeepAlive + RunAtLoad), and generates /etc/resolver/localhost for every
# entry in `addresses`.
{ ... }:
{
  services.dnsmasq = {
    enable = true;
    addresses = {
      localhost = "127.0.0.1";
    };
  };
}
