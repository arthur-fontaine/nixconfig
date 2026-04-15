{
  description = "Declarative macOS setup with nix-darwin and home-manager";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    nix-darwin.url = "github:LnL7/nix-darwin";
    nix-darwin.inputs.nixpkgs.follows = "nixpkgs";
    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = inputs@{ nixpkgs, nix-darwin, home-manager, ... }:
    let
      hosts = import ./hosts;

      mkDarwinConfiguration = hostName: hostConfig@{
        system,
        username,
        homeDirectory ? "/Users/${username}",
        ...
      }:
        let
          specialArgs = hostConfig // { inherit inputs hostName homeDirectory; };
        in
        nix-darwin.lib.darwinSystem {
          inherit system;
          inherit specialArgs;
          modules = [
            ./modules/darwin
            home-manager.darwinModules.home-manager
            {
              users.users.${username}.home = homeDirectory;
              home-manager.useGlobalPkgs = true;
              home-manager.useUserPackages = true;
              home-manager.backupCommand = "mkdir -p \"$HOME/.hm-backup\" && relative=\"\${1#$HOME/}\" && mkdir -p \"$HOME/.hm-backup/$(dirname \"$relative\")\" && mv \"$1\" \"$HOME/.hm-backup/$relative\"";
              home-manager.extraSpecialArgs = specialArgs;
              home-manager.users.${username} = import ./modules/home;
            }
          ];
        };
    in {
      darwinConfigurations = nixpkgs.lib.mapAttrs mkDarwinConfiguration hosts;
    };
}
