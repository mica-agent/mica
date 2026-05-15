# Mica Quickstart

Two ways to run Mica on a GPU host without VS Code:

- **vLLM compose path** — two sibling containers (`mica` + upstream
  `vllm/vllm-openai`). Recommended for production: NVFP4 + MTP-1
  speculative decode + continuous batching shared between voice and
  chat. ~30 GB model download on first run.
- **Single-container lean path** — one image, llama.cpp inside it. The
  existing "Open WebUI-shaped" install. Smaller download (~22 GB Q4
  GGUF), no compose orchestration, no nested containers.

Both paths use the same image. Differs only in topology + env.

## Prerequisites

- Linux host with an NVIDIA GPU (Blackwell / Hopper / Ada / Ampere
  — anything with FP4 or FP8 support runs vLLM happily; older GPUs
  use llama-cpp instead).
- NVIDIA driver matching your GPU.
- Docker Engine 24+.
- NVIDIA Container Toolkit configured for Docker:
  ```
  sudo nvidia-ctk runtime configure --runtime=docker
  sudo systemctl restart docker
  ```
- ~50 GB free disk for the Qwen3.6 model on first run.

Optional but recommended: clone this repo, so you can edit
`docker-compose.yml`, capture digests, and adjust env knobs:

    git clone https://github.com/<org>/mica.git
    cd mica

## Path 1 — vLLM (recommended for production)

From the repo root:

    ./scripts/mica-compose.sh up

The wrapper runs pre-flight checks (Docker daemon, GPU passthrough,
ports free, disk space) then `exec`s `docker compose up`. Skip
checks with `MICA_SKIP_PREFLIGHT=1 ./scripts/mica-compose.sh up`.
Run checks alone (no launch) with `./scripts/mica-compose.sh doctor`.

Or call docker compose directly:

    docker compose up

First run takes 5–15 minutes — vLLM downloads ~30 GB of weights
into a named volume (`mica-models`). Subsequent boots are seconds.
Open http://localhost:5173.

### Reusing an existing HuggingFace cache

If you already have Qwen3.6 (or other models) downloaded under
`~/.cache/huggingface/`, point compose at it to skip re-download:

    HF_CACHE_DIR=$HOME/.cache/huggingface ./scripts/mica-compose.sh up

The container mounts your host cache at `/cache/huggingface` (an
image-agnostic path; both services set `HF_HOME` to match). Already
downloaded models are visible immediately; new downloads land in
your host cache as UID/GID 1000.

### Different host UID

The container defaults to UID 1000:1000 to match the common Linux
host user. If your UID differs:

    USER_UID=$(id -u) USER_GID=$(id -g) ./scripts/mica-compose.sh up

### Pinning the vLLM image

The `mica-vllm` service defaults to `vllm/vllm-openai:cu130-nightly`
— a floating tag that drifts. For production, capture a digest:

    docker pull vllm/vllm-openai:cu130-nightly
    docker inspect --format '{{index .RepoDigests 0}}' \
      vllm/vllm-openai:cu130-nightly

Paste the resulting `vllm/vllm-openai@sha256:...` into
`docker-compose.yml` as the `image:` value, or set it via env:

    MICA_VLLM_IMAGE=vllm/vllm-openai@sha256:abc... ./scripts/mica-compose.sh up

Update intentionally after smoke testing a newer nightly. vLLM
nightlies occasionally change CLI flag names or guided-decoding
behavior; an unpinned tag invites surprises.

### Lifecycle

    ./scripts/mica-compose.sh stop    # graceful, keeps volumes
    ./scripts/mica-compose.sh logs    # tail all service logs
    ./scripts/mica-compose.sh nuke    # also delete volumes (confirms first)

## Path 2 — Single-container (lean, llama.cpp inside)

For dev boxes, laptops, or hosts where you don't want a separate
vLLM container. One image, llama-server auto-spawned inside on
first chat:

    bash install.sh

(downloads + runs the image; ~22 GB Q4 GGUF on first chat dispatch.)

Subsequent lifecycle:

    bash scripts/mica.sh start
    bash scripts/mica.sh stop
    bash scripts/mica.sh restart
    bash scripts/mica.sh status
    bash scripts/mica.sh logs

Env knobs (see `install.sh` and `scripts/mica.sh` for the full list):

    MICA_WORKSPACE=/path/to/workspace   # default: $HOME/mica-workspace
    MICA_DISABLE_LLAMA=1                # OpenRouter-only mode (no local LLM)
    MICA_MOUNT_CLAUDE=1                 # bind-mount ~/.claude for Claude Code cards
    MICA_IMAGE=ghcr.io/<org>/mica:0.1.0 # pin a specific image tag

## Path 3 — OpenRouter-only (no local LLM)

If you don't have a GPU or don't want to download model weights:

    docker run --gpus all -p 5173:5173 -p 3002:3002 \
      -e MICA_DISABLE_LLAMA=1 -e MICA_DISABLE_CHAT_VLLM=1 \
      -e OPENROUTER_API_KEY=<key> \
      -v ./workspace:/project \
      mica:latest

Both `MICA_DISABLE_LLAMA=1` (no llama-server) and
`MICA_DISABLE_CHAT_VLLM=1` (no nested vLLM container) are required —
together they tell start.sh "no local LLM serving, OpenRouter
handles chat." Voice sidecars still run locally for STT/TTS, so
`--gpus all` is still useful (Parakeet + Kokoro use the GPU). If
you really have no GPU at all, voice cards will fall back to slower
CPU inference.

## Workspace + history

- Projects live under your workspace directory:
  - Compose path: `./workspace/<project>/` (bind, host-visible)
  - Lean path: `$MICA_WORKSPACE/<project>/` (default `$HOME/mica-workspace`)
- Chat history persists at `<workspace>/<project>/.mica/chats/`.
- Layout, settings, and project config live at `<workspace>/<project>/.mica/`.
- To reset a project's chat, delete the matching `.json` file or use
  the chat card's "fresh thread" affordance.

## Create your own template

Drop a curated project directory under `templates/`:

    cp -r workspace/my-curated-project templates/my-template

Strip runtime state so the template doesn't ship chat history,
layout, or PID dirs:

    rm -rf templates/my-template/.mica/chats
    rm -rf templates/my-template/.mica/layout.json
    rm -rf templates/my-template/.mica-pids

That's the whole registration step — no manifest required. The
template appears in the project picker on next page load.
`createProjectFromTemplate` does a verbatim `cp -r` of
`templates/<name>/` into the new project.

## Troubleshooting

- **`docker compose up` hangs on "mica-vllm starting"** → vLLM is
  downloading model weights (~30 GB first run). Watch progress:
  `docker compose logs -f mica-vllm`.
- **"no GPUs visible" / vLLM crashes on CUDA init** → install /
  reconfigure NVIDIA Container Toolkit:
  ```
  sudo nvidia-ctk runtime configure --runtime=docker
  sudo systemctl restart docker
  ```
  Test: `docker run --rm --gpus all nvcr.io/nvidia/cuda:13.1.0-base nvidia-smi`
- **Voice card silent** → voice sidecars (Parakeet STT, Kokoro TTS)
  download weights on first invocation. Check
  `docker compose logs mica` for `[voice-stt] ready` and
  `[voice-tts] ready`. Models persist in the shared HF cache.
- **Port 5173 or 3002 already in use** → set `MICA_FRONTEND_PORT` /
  `MICA_BACKEND_PORT` before `up`, or stop the conflicting process.
  `./scripts/mica-compose.sh doctor` lists which PIDs hold which ports.
- **HF_CACHE_DIR bind-mount permission errors** → ensure the path
  is owned by the user matching `USER_UID:USER_GID` in compose
  (default 1000:1000). `sudo chown -R 1000:1000 $HF_CACHE_DIR` if
  you're comfortable with that.
- **Compose path and lean path simultaneously** → don't mix. The
  compose path sets `MICA_DISABLE_LLAMA=1` so no llama-server
  spawns inside `mica`; the lean path uses llama-server. If you
  alternate, each path's named volume (`mica-models`) is preserved
  across switches, but you'll re-download whichever model the
  other path uses.
