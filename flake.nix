{
  description = "Arthur Fontaine's nix-darwin + home-manager config";

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

      mkDarwinConfiguration = hostName: {
        system,
        username,
        homeDirectory ? "/Users/${username}",
      }:
        nix-darwin.lib.darwinSystem {
          inherit system;
          specialArgs = { inherit inputs hostName username homeDirectory; };
          modules = [
            ./modules/darwin
            home-manager.darwinModules.home-manager
            {
              users.users.${username}.home = homeDirectory;
              home-manager.useGlobalPkgs = true;
              home-manager.useUserPackages = true;
              home-manager.extraSpecialArgs = { inherit inputs hostName username homeDirectory; };
              home-manager.users.${username} = import ./modules/home;
            }
          ];
        };
    in {
      darwinConfigurations = nixpkgs.lib.mapAttrs mkDarwinConfiguration hosts;
    };
}
