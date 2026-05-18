"""mica_sidecar — Mica-owned primitives for card-class sidecars.

Sidecars run as separate Python processes spawned by Mica's backend. They wrap
a chosen library (sentence-transformers, FAISS, pymupdf, etc.) as a small HTTP
service that card.js consumes via mica.fetch('mica-internal://card-server/...').

This package exposes the few capabilities Mica itself owns — primarily LLM
access — so sidecars don't have to know URLs, model names, or auth tokens.

Typical usage:

    import mica_sidecar as mica  # template aliases mica_sidecar -> mica

    resp = mica.llm.chat(messages=[
        {"role": "system", "content": "You are concise."},
        {"role": "user",   "content": "Summarize: <text>"},
    ])
    mica.log("got reply:", resp.text)

    project = mica.project_dir         # absolute path to active project
    classdir = mica.cardclass_dir      # absolute path to this card class dir

The package surface is intentionally tiny — Mica-owned resources only. For
embeddings use sentence-transformers; for vector search use FAISS or Chroma;
for PDF parsing use pymupdf — those are standard libraries with stable APIs
the AI already knows. See card-class-handbook § sidecars for the catalog of
worked examples.

NOT the same as the client-side `mica` global (which is injected into card.js
by Mica's CARD_SHIM and provides fetch/openChannel/on). The surfaces don't
overlap. mica_sidecar.llm.chat is sidecar-only; the client uses
mica.openChannel('turn', { systemPrompt, model }) for streaming LLM UX.
"""

import os
import sys

from . import llm


def log(*args, **kwargs):
    """Print to stdout with the card-class prefix.

    Sidecar stdout is piped to the Mica backend log under
    `[card-sidecar:<name>] ...` lines. Using mica.log() ensures the label
    matches what the rest of the system expects.

    Any kwargs are forwarded to print() — e.g. `file=sys.stderr`. Flushing
    is automatic.
    """
    label = os.environ.get("MICA_CARD_CLASS", "sidecar")
    msg = " ".join(str(a) for a in args)
    print(f"[{label}] {msg}", flush=True, **kwargs)


def __getattr__(name):
    """Lazy-evaluate the Mica-injected context properties so a sidecar
    that imports mica_sidecar before reading its env (unlikely, but
    possible) still works."""
    if name == "project_dir":
        return os.environ.get("MICA_PROJECT_DIR", "")
    if name == "cardclass_dir":
        return os.environ.get("MICA_CARD_CLASS_DIR", "")
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


__all__ = ["llm", "log", "project_dir", "cardclass_dir"]
