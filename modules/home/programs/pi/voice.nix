# Pi voice: the two programs the voice extension (extensions/voice) starts for a call.
#
# - pi-voice-audio: the Swift helper that holds the microphone and the speakers, with macOS
#   voice processing (echo cancellation). Built here from one file; ad-hoc signed, which is
#   fine: started from Pi inside Herdr, macOS charges the microphone to Herdr. Its embedded
#   Info.plist lets it ask on its own when started from another terminal.
# - pi-voice: the daemon (turn detection, Whisper, Voxtral). Its Python environment is a uv
#   venv in ~/.cache/pi-voice/venv, synced from the locked project on start: MLX and its
#   friends are wheels nixpkgs doesn't follow closely. Models come from the shared Hugging
#   Face cache on the first call (`pi-voice fetch` gets them ahead).
{ pkgs, lib }:
let
  daemonSrc = lib.fileset.toSource {
    root = ./extensions/voice/daemon;
    fileset = lib.fileset.unions [
      ./extensions/voice/daemon/pyproject.toml
      ./extensions/voice/daemon/uv.lock
      ./extensions/voice/daemon/pi_voice
    ];
  };

  audio = pkgs.stdenv.mkDerivation {
    pname = "pi-voice-audio";
    version = "0.1.0";
    src = lib.fileset.toSource {
      root = ./extensions/voice/audio;
      fileset = lib.fileset.unions [ ./extensions/voice/audio/main.swift ./extensions/voice/audio/Info.plist ];
    };
    nativeBuildInputs = [ pkgs.swift ];
    buildPhase = ''
      swiftc -O -o pi-voice-audio main.swift \
        -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker Info.plist
    '';
    installPhase = ''
      install -Dm755 pi-voice-audio $out/bin/pi-voice-audio
    '';
    meta.platforms = lib.platforms.darwin;
  };

  daemon = pkgs.writeShellApplication {
    name = "pi-voice";
    runtimeInputs = [ pkgs.uv ];
    text = ''
      export UV_PROJECT_ENVIRONMENT="''${PI_VOICE_VENV:-$HOME/.cache/pi-voice/venv}"
      export UV_PYTHON_DOWNLOADS=never
      export UV_PYTHON=${pkgs.python312}/bin/python3.12
      export PI_VOICE_AUDIO="''${PI_VOICE_AUDIO:-${audio}/bin/pi-voice-audio}"
      # The project is read-only in the store: uv syncs the venv from its lock and runs it.
      exec uv run --frozen --no-dev --project ${daemonSrc} python -m pi_voice "$@"
    '';
  };
in
{
  inherit audio daemon;
}
