{ pkgs, lib, config, ... }:
let
  # Llama.app serves every GGUF it finds in the Hugging Face cache, as
  # `repo:QUANT`. Vision models need their mmproj file beside the weights, and an
  # `mtp-` head turns on speculative decoding. Sized for a 24 GB Mac, where the
  # app lets a model's weights take about 16 GB.
  models = [
    # Main model: best quality that fits. MoE with 4B active, so it stays fast.
    {
      repo = "ggml-org/gemma-4-26B-A4B-it-GGUF";
      quant = "Q4_0";
      files = [
        "gemma-4-26B-A4B-it-Q4_0.gguf"
        "mmproj-gemma-4-26B-A4B-it-Q8_0.gguf"
        "mtp-gemma-4-26B-A4B-it-Q4_0.gguf"
      ];
    }
    # Quick answers where latency beats quality (Smallcast).
    {
      repo = "LiquidAI/LFM2.5-1.2B-Instruct-GGUF";
      quant = "Q8_0";
      files = [ "LFM2.5-1.2B-Instruct-Q8_0.gguf" ];
    }
    # Structured extraction from images and documents.
    {
      repo = "LiquidAI/LFM2.5-VL-1.6B-Extract-GGUF";
      quant = "Q8_0";
      files = [
        "LFM2.5-VL-1.6B-Extract-Q8_0.gguf"
        "mmproj-LFM2.5-VL-1.6B-Extract-Q8_0.gguf"
      ];
    }
    # Code search: much better than small embedders, but 7B.
    {
      repo = "Mungert/nomic-embed-code-GGUF";
      quant = "Q8_0";
      files = [ "nomic-embed-code-q8_0.gguf" ];
      settings.embeddings = true;
    }
    # Fast multilingual text embeddings.
    {
      repo = "Qwen/Qwen3-Embedding-0.6B-GGUF";
      quant = "Q8_0";
      files = [ "Qwen3-Embedding-0.6B-Q8_0.gguf" ];
      settings.embeddings = true;
    }
  ];

  # The app only reads this file and merges it over the models.ini it
  # generates. Both embedders carry their pooling type in the GGUF.
  userOverrides = lib.generators.toINI { } (lib.listToAttrs (map (m: {
    name = "${m.repo}:${m.quant}";
    value = m.settings;
  }) (lib.filter (m: m ? settings) models)));

  hf = "${pkgs.python3Packages.huggingface-hub}/bin/hf";
in
{
  xdg.configFile."llama/models.user.ini".text = userOverrides;

  # Checks the cache before calling `hf`, which would otherwise make a network
  # round trip per file on every rebuild.
  home.activation.llamaModels = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    hub="${config.home.homeDirectory}/.cache/huggingface/hub"
    fetchModel() {
      local repo="$1"; shift
      local dir="$hub/models--''${repo//\//--}/snapshots"
      local missing=()
      for file in "$@"; do
        compgen -G "$dir/*/$file" >/dev/null || missing+=("$file")
      done
      [ ''${#missing[@]} -eq 0 ] && return
      echo "Downloading $repo: ''${missing[*]}"
      run ${hf} download "$repo" "''${missing[@]}" >/dev/null \
        || echo "Failed to download $repo" >&2
    }
    ${lib.concatMapStrings (m: ''
      fetchModel ${lib.escapeShellArgs ([ m.repo ] ++ m.files)}
    '') models}

    # Installing the cask doesn't launch the app, and it only registers itself
    # as a login item on its first launch. Opened after the downloads so its
    # first cache scan already sees every model.
    if [ -d /Applications/Llama.app ] && ! /usr/bin/pgrep -xq Llama; then
      run /usr/bin/open -g -a /Applications/Llama.app || true
    fi
  '';
}
