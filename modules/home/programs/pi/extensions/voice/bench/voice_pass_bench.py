"""The second pass that turns Pi's written answer into a spoken one: Haiku (through Pi) vs a local small LLM.

    python voice_pass_bench.py [resultdir] [--no-haiku]

The written answer below is the shape Pi produces (markdown, a code block,
paths). Measured per backend, 3 runs each:
- time to first token (TTFT) and to the end of the first spoken sentence,
  which is when TTS can start;
- the spoken text, kept for reading.

Haiku goes through `pi --mode json -p --no-session`, so it uses
the person’s own provider (claude-code, registered by an extension, so extensions load) with no session written; TTFT is taken
from the `message_start` of the assistant to its first `text_delta`, which
leaves Pi's own start-up out. The local model runs in llama-server (already
installed) on a free port with the cached LFM2.5-1.2B GGUF.
"""

import json
import re
import statistics
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

WRITTEN = """J'ai trouvé la cause : le footer lit `settings.footer.segments`, mais depuis le commit `9af1b0f` la clé s'appelle `footerSegments`.

Changements :

- `modules/home/programs/pi/extensions/footer/layout.ts` : lecture de la nouvelle clé, avec repli sur l'ancienne ;
- `footer/tests/layout.test.ts` : un test pour chacun des deux cas.

```ts
const segments = settings.footerSegments ?? settings.footer?.segments ?? DEFAULT_SEGMENTS;
```

Les 14 tests passent (`node --test`). Je n'ai pas lancé `nix build` : il faut un `rebuild` pour voir le footer dans Pi. Tu veux que je fasse le commit ?"""

# Draft of the phase-2 prompt. Spoken like the Claude and ChatGPT voice modes: what matters, in speech,
# no markdown, no code read out, paths named by what they are, same language as the answer.
PROMPT = """Tu transformes la réponse écrite d'un assistant de code en ce qu'il dirait à voix haute à son utilisateur, comme le mode vocal de Claude ou ChatGPT.
Règles : garde la langue de la réponse. Phrases courtes et naturelles, à l'oral. Dis l'essentiel : ce qui a été trouvé ou fait, et la question posée s'il y en a une. Ne lis jamais de code, de chemin complet, de hash ni de liste à puces : résume-les (« j'ai modifié le fichier du footer et ses tests »). Pas de markdown, pas d'emoji. Au plus quatre phrases. Réponds seulement avec le texte à dire.

Réponse écrite :
"""


def first_sentence_end(text: str) -> bool:
    return re.search(r"[.!?…](\s|$)", text) is not None


def haiku() -> dict:
    t0 = time.perf_counter()
    proc = subprocess.Popen(
        ["pi", "--mode", "json", "-p", "--no-session", "--model", "claude-code/claude-haiku-5-5",
         "--thinking", "off", PROMPT + WRITTEN],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    start = first = sentence = None
    text = ""
    for raw in proc.stdout:  # type: ignore[union-attr]
        ev = json.loads(raw)
        now = time.perf_counter()
        if ev.get("type") == "message_start" and ev["message"].get("role") == "assistant":
            start = now
        if ev.get("type") == "message_update" and ev["assistantMessageEvent"].get("type") == "text_delta":
            first = first or now
            text += ev["assistantMessageEvent"]["delta"]
            if sentence is None and first_sentence_end(text):
                sentence = now
    proc.wait()
    end = time.perf_counter()
    return {"ttft_s": first - start, "first_sentence_s": (sentence or end) - start, "total_s": end - start,
            "process_s": end - t0, "text": text.strip()}


def local(port: int) -> dict:
    body = json.dumps({"messages": [{"role": "user", "content": PROMPT + WRITTEN}], "stream": True,
                       "temperature": 0.3, "max_tokens": 200,
                       "chat_template_kwargs": {"enable_thinking": False}}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/chat/completions", body, {"Content-Type": "application/json"})
    t0 = time.perf_counter()
    first = sentence = None
    text = ""
    with urllib.request.urlopen(req) as resp:
        for raw in resp:
            line = raw.decode().strip()
            if not line.startswith("data: ") or line == "data: [DONE]":
                continue
            delta = json.loads(line[6:])["choices"][0]["delta"].get("content") or ""
            if delta:
                now = time.perf_counter()
                first = first or now
                text += delta
                if sentence is None and first_sentence_end(text):
                    sentence = now
    end = time.perf_counter()
    return {"ttft_s": first - t0, "first_sentence_s": (sentence or end) - t0, "total_s": end - t0, "text": text.strip()}


LOCAL = {
    "lfm2.5-1.2b-q8 (local)": ("LiquidAI/LFM2.5-1.2B-Instruct-GGUF", "LFM2.5-1.2B-Instruct-Q8_0.gguf"),
    "lfm3-1.7b-q4km (local)": ("LiquidAI/LFM3-1.7B-GGUF", "LFM3-1.7B-Q4_K_M.gguf"),
}


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    results = Path(args[0] if args else "/tmp/k12-results")
    path = results / "voice-pass.json"
    out = {k: v["runs"] for k, v in json.loads(path.read_text()).items()} if path.exists() else {}
    if "--no-haiku" not in sys.argv:
        out["haiku-5.5"] = [haiku() for _ in range(3)]
    for name, (repo, file) in LOCAL.items():
        out[name] = run_local(repo, file)
    write(out, path)


def run_local(repo: str, file: str) -> list[dict]:
    from huggingface_hub import hf_hub_download
    gguf = hf_hub_download(repo, file)
    port = 18765
    server = subprocess.Popen(["llama-server", "-m", gguf, "--port", str(port), "-c", "4096", "-ngl", "99"],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(120):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{port}/health")
                break
            except Exception:
                time.sleep(0.5)
        local(port)  # warm-up
        runs = [local(port) for _ in range(3)]
        rss = subprocess.run(["ps", "-o", "rss=", "-p", str(server.pid)], capture_output=True, text=True).stdout.strip()
        runs[0]["server_rss_mb"] = int(rss) / 1024
        return runs
    finally:
        server.terminate()
        server.wait()


def write(out: dict, path: Path) -> None:
    summary = {k: {"ttft_ms_median": 1000 * statistics.median(r["ttft_s"] for r in v),
                   "first_sentence_ms_median": 1000 * statistics.median(r["first_sentence_s"] for r in v),
                   "total_ms_median": 1000 * statistics.median(r["total_s"] for r in v),
                   "runs": v} for k, v in out.items()}
    path.write_text(json.dumps(summary, ensure_ascii=False, indent=1))
    for k, v in summary.items():
        print(f"== {k}: TTFT {v['ttft_ms_median']:.0f} ms, first sentence {v['first_sentence_ms_median']:.0f} ms, total {v['total_ms_median']:.0f} ms")
        for r in v["runs"]:
            print("   ", r["text"].replace("\n", " ")[:400])


if __name__ == "__main__":
    main()
