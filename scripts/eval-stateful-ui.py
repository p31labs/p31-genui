#!/usr/bin/env python3
"""Stateful multi-turn UI harness for the P31 GenUI benchmark.

This script only *collects* model output. Scoring happens in
`score-stateful-ui.mjs`, which runs every output through the real compile().

Two things the first version got wrong:

1. It scored raw text with string containment. Any JSON that mentioned the
   instruction's own words passed, even when the compiler would reject the
   tree. Scoring now happens against the compiled tree.
2. Its system prompt never showed the model the catalog or the spec shape.
   A model not trained on that exact format scores ~0% compile. Pass
   `--dataset` to lift the system prompt from line 1 of the training file:

       python3 eval-stateful-ui.py --model m.gguf \
           --dataset /kaggle/working/sft-dataset-v2.jsonl --out outputs.jsonl

The harness is stateful: each episode carries its full message history, so
turn 5 is generated with turns 1-4 in context.

Sample size: 5 scripted turns x N episodes. Episodes vary the values and
labels (see `variant()`), so N distinct episodes give N distinct samples per
turn, not one sample repeated N times. Quote "N episodes x 5 turns", never
"N*5 turns" as if they were independent.

Think tags: Qwen 3.5 defaults to thinking mode and will spend the whole token
budget on reasoning before emitting JSON, so the prompt forces an empty think
block. The tags are built from code points below rather than written
literally, so a display or editor that strips angle-bracket tags cannot
silently corrupt this file. Verify with:

    python3 -c "s=open('eval-stateful-ui.py').read(); \\
        print([ord(c) for c in s[s.index('THINK_OPEN = ')+13:][:6]])"

The first code point must be 60 (<), not 32 (space).
"""

import argparse
import json
import os
import re
import sys

LT = chr(60)
GT = chr(62)
THINK_OPEN = LT + "think" + GT
THINK_CLOSE = LT + "/think" + GT
THINK_BLOCK = re.compile(re.escape(THINK_OPEN) + r".*?" + re.escape(THINK_CLOSE), re.DOTALL)

DEFAULT_SYSTEM = "You are an A2UI v0.9 generator. Output valid JSON only."

HEADINGS = [
    "Revenue", "Bookings", "Pipeline", "Usage", "Churn",
    "Margin", "Latency", "Backlog", "Renewals", "Refunds",
]
LABELS = [
    "Acknowledge", "Confirm", "Dismiss", "Escalate", "Archive",
    "Approve", "Retry", "Pause", "Resolve", "Close",
]


def variant(i):
    """Deterministic per-episode variation so episodes are distinct samples."""
    base = 10000 + 1000 * i
    return {
        "value1": f"{base:,}",
        "value2": f"{base + 5000:,}",
        "label": LABELS[i % len(LABELS)],
        "heading1": HEADINGS[i % len(HEADINGS)],
        "heading2": HEADINGS[(i + 3) % len(HEADINGS)] + " Overview",
    }


def turns(v):
    return [
        f"Create a dashboard with a heading '{v['heading1']}' and a StatCard showing {v['value1']}",
        f"Change the first StatCard value to {v['value2']}",
        f"Add a Button labeled '{v['label']}'",
        f"Change the heading to '{v['heading2']}'",
        "Remove the StatCard",
    ]


def load_system(path):
    """Lift the system prompt from line 1 of the training JSONL."""
    with open(path, encoding="utf-8") as f:
        rec = json.loads(f.readline())
    print("dataset keys:", sorted(rec.keys()))
    if isinstance(rec.get("system"), str):
        return rec["system"]
    for key in ("messages", "conversations"):
        for m in rec.get(key) or []:
            role = m.get("role") or m.get("from")
            if role == "system":
                return m.get("content") or m.get("value")
    raise SystemExit(
        "could not find a system message in line 1; inspect the keys above and "
        "pass --system-file instead"
    )


def clean_json(text):
    """Strip think blocks and markdown fences, then parse the object."""
    text = THINK_BLOCK.sub("", text)
    text = re.sub(r"```(?:json)?\n(.*?)\n```", r"\1", text, flags=re.DOTALL).strip()
    try:
        return json.loads(text)
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True, help="path to a .gguf file")
    ap.add_argument("--episodes", type=int, default=30)
    ap.add_argument("--n-ctx", type=int, default=16384)
    ap.add_argument("--max-tokens", type=int, default=512)
    ap.add_argument("--out", default="outputs.jsonl")
    ap.add_argument("--dataset", help="training JSONL; system prompt taken from line 1")
    ap.add_argument("--system-file", help="file containing the exact system prompt")
    args = ap.parse_args()

    if not os.path.exists(args.model):
        sys.exit(f"model not found: {args.model}")

    if args.dataset:
        system = load_system(args.dataset)
        print("system prompt from dataset:", system[:80].replace("\n", " "), "...")
    elif args.system_file:
        system = open(args.system_file, encoding="utf-8").read().strip()
    else:
        system = DEFAULT_SYSTEM
        print("WARNING: using the built-in system prompt. If the training data used a")
        print("         different template, compile rate will be near zero for reasons")
        print("         that have nothing to do with the model. Pass --dataset.")

    try:
        from llama_cpp import Llama
    except ImportError:
        sys.exit("pip install llama-cpp-python")

    llm = Llama(
        model_path=args.model,
        n_gpu_layers=-1,
        n_ctx=args.n_ctx,
        n_batch=512,
        verbose=False,
    )

    records = []
    parseable = 0
    for ep in range(args.episodes):
        v = variant(ep)
        history = f"<|im_start|>system\n{system}<|im_end|>\n"
        for i, instruction in enumerate(turns(v)):
            history += f"<|im_start|>user\n{instruction}<|im_end|>\n"
            prompt = history + "<|im_start|>assistant\n" + THINK_OPEN + "\n\n" + THINK_CLOSE + "\n\n"
            out = llm(prompt, max_tokens=args.max_tokens, temperature=0.0)["choices"][0]["text"]
            history += f"{out}<|im_end|>\n"

            tree = clean_json(out)
            parseable += tree is not None
            records.append(
                {"episode": ep, "turn": i + 1, "raw": out, "tree": tree, "expect": v}
            )

        if (ep + 1) % 10 == 0:
            print(f"  episode {ep + 1}/{args.episodes}")

    with open(args.out, "w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    total = len(records)
    print(f"\nwrote {args.out}: {total} turns from {args.episodes} distinct episodes")
    print(f"parseable JSON: {parseable}/{total} ({100.0 * parseable / total:.1f}%)")
    print("now run: tsx score-stateful-ui.mjs --in " + args.out)


if __name__ == "__main__":
    main()
