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
            ({ pkgs, ... }: {
              users.users.${username}.home = homeDirectory;
              home-manager.useGlobalPkgs = true;
              home-manager.useUserPackages = true;
              home-manager.backupCommand =
                let
                  script = pkgs.writeShellScript "hm-backup" ''
                    set -e
                    backup_dir="$HOME/.hm-backup"
                    file="$1"
                    relative="''${file#"$HOME/"}"
                    mkdir -p "$backup_dir/$(dirname "$relative")"
                    mv "$file" "$backup_dir/$relative"
                  '';
                in "${script}";
              home-manager.extraSpecialArgs = specialArgs;
              home-manager.users.${username} = import ./modules/home;
            })
          ];
        };
    in {
      darwinConfigurations = nixpkgs.lib.mapAttrs mkDarwinConfiguration hosts;
    };
}
