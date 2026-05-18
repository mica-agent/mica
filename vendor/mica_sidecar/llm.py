"""mica_sidecar.llm — LLM access for card-class sidecars.

Single function: chat(messages, ...) → ChatResponse. Mica owns the URL, the
model name, the auth token, and the vLLM `enable_thinking` default. The
sidecar code never sees any of those.

Returns a structured response object so callers can pattern-match on
`.text` / `.usage` / `.model` cleanly. Errors raise httpx exceptions OR
RuntimeError if the sidecar is somehow running outside a Mica-spawned
environment.
"""

import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

import httpx


@dataclass
class ChatResponse:
    text: str
    model: str
    usage: Optional[Dict[str, int]] = None


def chat(
    messages: List[Dict[str, Any]],
    *,
    max_tokens: int = 2048,
    temperature: float = 0.3,
    model: Optional[str] = None,
    thinking: bool = False,
    timeout: float = 120.0,
) -> ChatResponse:
    """Call Mica's local LLM with the given OpenAI-style chat messages.

    Required:
        messages: list of {"role": "system|user|assistant", "content": str}.

    Optional:
        max_tokens:  Default 2048. Raise for long generations (summarization,
                     RAG answers). vLLM's `enable_thinking=true` can eat this
                     budget — but that's off by default here, so 2048 is the
                     reply length, not reply+reasoning.
        temperature: Default 0.3 (factual). Raise to ~0.7 for creative tasks.
        model:       Default = first model from the local /v1/models list
                     (Mica probes once + caches). Set this only if you need
                     a specific served model name and the deployment has
                     multiple loaded.
        thinking:    Default False. If True, vLLM uses its chain-of-thought
                     template — burns part of max_tokens on the reasoning
                     trace before the answer. Bump max_tokens to ≥2x what
                     you'd budget without thinking.
        timeout:     Default 120s. Bump for very long generations.

    Returns:
        ChatResponse(text=..., model=..., usage=...)

    Raises:
        httpx.HTTPStatusError on non-2xx response (network error, auth
            failure, upstream LLM error).
        RuntimeError if running outside a Mica-spawned sidecar
            (MICA_BACKEND_URL / MICA_SIDECAR_TOKEN env vars not set).
    """
    backend_url = os.environ.get("MICA_BACKEND_URL")
    token = os.environ.get("MICA_SIDECAR_TOKEN")
    if not backend_url or not token:
        raise RuntimeError(
            "mica_sidecar.llm.chat called outside a Mica-spawned sidecar — "
            "MICA_BACKEND_URL or MICA_SIDECAR_TOKEN env var not set. This "
            "package only works inside a sidecar process Mica spawned."
        )

    body: Dict[str, Any] = {
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": temperature,
        "thinking": thinking,
    }
    if model:
        body["model"] = model

    resp = httpx.post(
        f"{backend_url}/api/llm/chat",
        json=body,
        headers={"x-mica-sidecar-auth": token},
        timeout=timeout,
    )
    resp.raise_for_status()
    data = resp.json()
    return ChatResponse(
        text=data.get("text", ""),
        model=data.get("model", ""),
        usage=data.get("usage"),
    )
