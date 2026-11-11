"""pi-voice: `serve` runs the daemon; `fetch` downloads every model into the HF cache ahead of a first call."""

import sys


def offline_if_cached() -> None:
    """With every model already in the HF cache, skip the hub's network checks on each load."""
    import os
    if "HF_HUB_OFFLINE" in os.environ:
        return
    from huggingface_hub import try_to_load_from_cache

    from .models import VOXTRAL, WHISPER
    needed = [(WHISPER, "config.json"), (VOXTRAL, "config.json"), ("onnx-community/silero-vad", "onnx/model.onnx"),
              ("pipecat-ai/smart-turn-v3", "smart-turn-v3.2-cpu.onnx")]
    if all(isinstance(try_to_load_from_cache(r, f), str) for r, f in needed):
        from pathlib import Path
        if (Path.home() / ".cache/pi-voice/voxturn-mlx/model.safetensors").exists():
            os.environ["HF_HUB_OFFLINE"] = "1"


def main() -> None:
    args = sys.argv[1:]
    command = args[0] if args else "serve"
    if command == "serve":
        offline_if_cached()
        from .server import serve
        serve(args[1:])
    elif command == "fetch":
        from huggingface_hub import hf_hub_download, snapshot_download

        from .models import VOXTRAL, WHISPER
        from .voxturn_mlx import convert
        for repo in (WHISPER, VOXTRAL):
            snapshot_download(repo)
        hf_hub_download("onnx-community/silero-vad", "onnx/model.onnx")
        hf_hub_download("pipecat-ai/smart-turn-v3", "smart-turn-v3.2-cpu.onnx")
        print(convert())
    else:
        print("usage: pi-voice [serve [--socket PATH] [--audio CMD] | fetch]", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
