# Voice sidecar runtime

Python venv + dependencies for Mica's two voice sidecars:

- **voice-stt** (Parakeet-TDT-0.6b-v2) — `127.0.0.1:8013/transcribe`
- **voice-tts** (Kokoro-82M) — `127.0.0.1:8014/synthesize`

This directory is the **Python runtime** for those sidecars. The sidecar
scripts themselves live at `scripts/sidecars/voice-{stt,tts}-server.py`.

## What this directory holds

| Path | Purpose |
|---|---|
| `install.sh` | One-time setup. Creates `.venv/` and installs Parakeet/Kokoro/fastapi/uvicorn/librosa/silero-vad. Idempotent. |
| `.venv/` | The Python virtualenv the sidecars run in. ~6 GB. Not committed. Recreated from `install.sh` on demand. |

## When to run install.sh

- **Devcontainer first boot** — run once per fresh workspace.
- **Dockerfile build** — the release image runs it automatically at build time so the venv is baked into the container; `Dockerfile` references `bash scripts/voice/install.sh`.

```bash
bash scripts/voice/install.sh
```

Subsequent runs only verify state (~30s no-op when nothing changed). To force a fresh install, delete `.venv/` first.

## How the sidecars get spawned

Mica spawns the two sidecars **lazily** on first voice request via
`ensureVoiceServers()` in [`server/voiceServers.ts`](../../server/voiceServers.ts). They:

1. Bind 127.0.0.1 only (no external exposure).
2. Inherit the backend's env (`HF_HOME` for the model cache, etc.).
3. Stay alive across requests until the backend exits.

To skip voice entirely, set `MICA_DISABLE_VOICE=1` — voice cards then show a "voice disabled" placeholder.

## Where the venv path is referenced

- [`server/voiceServers.ts`](../../server/voiceServers.ts) — `VENV_PYTHON` constant
- [`server/cardSidecar.ts`](../../server/cardSidecar.ts) — `VOICE_VENV_PYTHON` (cards with `metadata.sidecar.python = "voice-venv"` use this same venv)
- [`vite.config.ts`](../../vite.config.ts) — `.venv` excluded from file-watcher
- [`Dockerfile`](../../Dockerfile) — `RUN bash scripts/voice/install.sh` at image build time

Moving this directory requires updating those four references.

## Why this is a separate venv from the agent's Python

The voice sidecars need torch + transformers + a specific cuDNN minor
version pinned to the system's (`install.sh` handles the cuDNN
alignment to avoid `CUDNN_STATUS_SUBLIBRARY_VERSION_MISMATCH`). The
agent backend (Node/TS) and the chat vLLM container live in entirely
separate stacks. Keeping voice in its own venv prevents:

- Polluting `/usr/local/lib/python3.12/dist-packages/` with ~6 GB of
  GPU deps the rest of the system doesn't need.
- ABI conflicts between vLLM's bundled cuDNN and the voice sidecars'
  torch-bundled cuDNN (a real failure mode — see `install.sh` notes).
- Heavyweight wheels (nemo-toolkit) re-downloaded on every container build.
