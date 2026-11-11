"""pi-voice: `serve` runs the daemon; `fetch` downloads every model into the HF cache ahead of a first call."""

import sys


def main() -> None:
    args = sys.argv[1:]
    command = args[0] if args else "serve"
    if command == "serve":
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
