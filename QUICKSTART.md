# Mica Quickstart

Two ways to run Mica on a GPU host without VS Code:

- **vLLM compose path** — two sibling containers (`mica` + upstream
  `vllm/vllm-openai`). Recommended for release deployments: NVFP4 +
  MTP-1 speculative decode + continuous batching shared between voice
  and chat. ~30 GB model download on first run.
- **Single-container lean path** — one image, llama.cpp inside it. The
  "Open WebUI-shaped" install. Smaller download (~22 GB Q4 GGUF), no
  compose orchestration, no nested containers.

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

## Recommended: HuggingFace token

The default model is public, so anonymous downloads work — but HF Hub
will scold you in the logs ("you are sending unauthenticated requests
to HF hub. Please set HF_TOKEN") and rate-limit large fetches.

**Both paths now pick up an `HF_TOKEN` automatically:**

- **Compose path** — add to `.env` at the repo root:
  ```
  echo "HF_TOKEN=hf_xxxxxxxxxxxxxxxxxxxxxx" >> .env
  ```
  Both `mica` and `mica-vllm` pick it up via `env_file`.
- **Lean path** — `install.sh` and `mica.sh start` look first at the
  ambient `HF_TOKEN`, then fall back to `~/.cache/huggingface/token`
  (written by `huggingface-cli login`). Whichever they find is passed
  through to the container with `-e HF_TOKEN=...`.

Get a free read-only token at
https://huggingface.co/settings/tokens. Skipping is safe — downloads
still work, just throttled.

Optional but recommended: clone the repo, so you can edit
`docker-compose.yml`, capture digests, and adjust env knobs:

    git clone https://github.com/<org>/mica.git
    cd mica

## Path 1 — vLLM (recommended for release)

From the repo root:

    ./scripts/mica-compose.sh up

The wrapper runs pre-flight checks (Docker daemon, GPU passthrough,
ports free, disk space, HF token, image freshness) then `exec`s
`docker compose up`. Skip checks with
`MICA_SKIP_PREFLIGHT=1 ./scripts/mica-compose.sh up`.

Subcommands:

    ./scripts/mica-compose.sh up         # preflight + bring stack up (default)
    ./scripts/mica-compose.sh doctor     # preflight checks only
    ./scripts/mica-compose.sh status     # show services + URLs
    ./scripts/mica-compose.sh stop       # graceful, keeps volumes
    ./scripts/mica-compose.sh logs       # tail all service logs
    ./scripts/mica-compose.sh nuke       # also delete volumes (confirms first)

First run takes 5–15 minutes — vLLM downloads ~30 GB of weights into
a named volume (`mica-models`). Subsequent boots are seconds. Open
http://localhost:5173.

### Auto-rebuild on stale image

The wrapper detects when `mica:latest` is older than tracked source
(Dockerfile / package.json / server/ / src/ / templates/ / scripts/
/ card-classes/). By default it **warns** and suggests `up --build`.
To make it automatic:

    MICA_AUTO_BUILD=1 ./scripts/mica-compose.sh up

`MICA_AUTO_BUILD=1` silently injects `--build` when staleness is
detected, no-ops when the image is current. Useful in CI or for
developers iterating on Mica itself.

### Custom workspace location

The default workspace is `$HOME/mica-workspace/` (outside the repo).
Override:

    MICA_WORKSPACE=/data/mica ./scripts/mica-compose.sh up

The wrapper pre-creates the directory and aligns ownership to the
container's UID/GID (default 1000:1000), so you don't hit a
permission-denied error on first project create.

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
— a floating tag that drifts. For release, capture a digest:

    docker pull vllm/vllm-openai:cu130-nightly
    docker inspect --format '{{index .RepoDigests 0}}' \
      vllm/vllm-openai:cu130-nightly

Paste the resulting `vllm/vllm-openai@sha256:...` into
`docker-compose.yml` as the `image:` value, or set it via env:

    MICA_VLLM_IMAGE=vllm/vllm-openai@sha256:abc... ./scripts/mica-compose.sh up

Update intentionally after smoke testing a newer nightly. vLLM
nightlies occasionally change CLI flag names or guided-decoding
behavior; an unpinned tag invites surprises.

## Path 2 — Single-container (lean, llama.cpp inside)

For dev boxes, laptops, or hosts where you don't want a separate
vLLM container. One image, llama-server auto-spawned inside on
first chat:

    bash install.sh

(Downloads + runs the image; ~22 GB Q4 GGUF on first chat dispatch.
Preflight checks Docker, NVIDIA Container Toolkit, arch, workspace
permissions, and HF_TOKEN before pulling.)

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
    HF_TOKEN=hf_xxx...                  # picked up automatically; also read
                                        # from ~/.cache/huggingface/token

## Path 3 — OpenRouter-only (no local LLM)

If you don't have a GPU or don't want to download model weights, run
without local inference:

    mkdir -p ~/mica-workspace
    docker run --gpus all -p 5173:5173 -p 3002:3002 \
      -e MICA_DISABLE_LLAMA=1 -e MICA_DISABLE_CHAT_VLLM=1 \
      -e OPENROUTER_API_KEY=<key> \
      -v ~/mica-workspace:/project \
      ghcr.io/<org>/mica:latest

Both `MICA_DISABLE_LLAMA=1` (no llama-server) and
`MICA_DISABLE_CHAT_VLLM=1` (no nested vLLM container) are required —
together they tell `start.sh` "no local LLM serving, OpenRouter
handles chat." Voice sidecars still run locally for STT/TTS, so
`--gpus all` is still useful (Parakeet + Kokoro use the GPU). If
you really have no GPU at all, voice cards fall back to slower CPU
inference.

## Environment variable reference

The release scripts standardize on the same env-var names the server
reads at runtime, so a single `.env` works across all three paths:

| Var | Purpose | Default |
|---|---|---|
| `MICA_PORT` | Backend host port | `3002` |
| `MICA_FRONTEND_PORT` | Frontend host port | `5173` |
| `MICA_LLAMA_PORT` | llama-server port (lean path only) | `8012` |
| `MICA_WORKSPACE` | Host workspace dir | `$HOME/mica-workspace` |
| `MICA_IMAGE` | Docker image tag (lean path) | `ghcr.io/robchang/mica:latest` |
| `MICA_DISABLE_LLAMA` | Skip llama-server | unset |
| `MICA_DISABLE_CHAT_VLLM` | Skip the chat vLLM sibling | unset |
| `MICA_AUTO_BUILD` | Auto-add `--build` when image is stale (compose) | unset |
| `MICA_VLLM_IMAGE` | Override vLLM image (compose) | upstream nightly |
| `HF_CACHE_DIR` | Bind-mount a host HF cache (compose) | named volume |
| `HF_TOKEN` | HuggingFace auth (lifts rate limits) | unset |
| `OPENROUTER_API_KEY` | Cloud-model fallback | unset |
| `USER_UID` / `USER_GID` | Container user (compose) | `1000` / `1000` |

Legacy names `MICA_BACKEND_PORT`, `MICA_PORT_BACKEND`,
`MICA_PORT_FRONTEND`, and `MICA_PORT_LLAMA` are still honored as
fallbacks so older `.env` files and CI configs keep working — but the
table above is what the docs and scripts now use.

See `.env.example` at the repo root for the full annotated list,
including voice-sidecar bindings, Claude / Anthropic model overrides,
OpenAI-compat endpoint config, and the verbose llama-server knobs.

## Workspace + history

- All three paths default the workspace to **`$HOME/mica-workspace/`**
  — deliberately outside the cloned repo so user data doesn't mix
  with code and `git pull` can't touch your projects.
- Override via `MICA_WORKSPACE=/path/of/your/choice`. Compose, install,
  and the raw `docker run` form all honor it.
- Projects live at `$MICA_WORKSPACE/<project>/`.
- Chat history persists at `$MICA_WORKSPACE/<project>/.mica/chats/`.
- Layout, settings, and project config live at
  `$MICA_WORKSPACE/<project>/.mica/`.
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

The first non-empty, non-`#` line of `.mica/canvas-back.md` becomes
the template's description in the project-creation menu (truncated to
200 characters). Keep that line user-facing.

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
  `MICA_PORT` before `up`, or stop the conflicting process.
  `./scripts/mica-compose.sh doctor` lists which PIDs hold which
  ports.
- **HF_CACHE_DIR bind-mount permission errors** → ensure the path
  is owned by the user matching `USER_UID:USER_GID` in compose
  (default 1000:1000). `sudo chown -R 1000:1000 $HF_CACHE_DIR` if
  you're comfortable with that.
- **"mica:latest is older than tracked source"** → preflight detected
  staleness. Run `./scripts/mica-compose.sh up --build`, or set
  `MICA_AUTO_BUILD=1` to make rebuilds automatic.
- **Compose path and lean path simultaneously** → don't mix. The
  compose path sets `MICA_DISABLE_LLAMA=1` so no llama-server
  spawns inside `mica`; the lean path uses llama-server. If you
  alternate, each path's named volume (`mica-models`) is preserved
  across switches, but you'll re-download whichever model the
  other path uses.
