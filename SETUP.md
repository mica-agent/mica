# Mica Setup

Two ways to run Mica on a GPU host. Both use the same image and the
same wrapper (`./scripts/mica-compose.sh`); they differ only in
inference topology. VLLM is recommended for large VRAM setups (DGX Spark) as it
offers better concurrency support (multiple projects/agents running); Llama is recommended
for smaller VRAM setups where inference may be split across GPU and CPU.

|   | **vLLM** (default) | **llama** |
|---|---|---|
| Containers | 2 (mica + mica-vllm sibling) | 1 (llama-server inside mica) |
| Base images | `nvcr.io/nvidia/vllm:26.04-py3` (mica) + `vllm/vllm-openai:cu130-nightly` (mica-vllm) — both upstream-official, no custom forks | `nvcr.io/nvidia/vllm:26.04-py3` (mica) — same NVIDIA-published base; llama-server is built from source on top |
| Model | Qwen3.6-35B-A3B-NVFP4 (~30 GB) | Qwen3.6-35B-A3B Q4 GGUF (~22 GB) |
| Speed | Faster (NVFP4 + MTP-1 speculative decode + continuous batching) | Slower |
| Voice + chat share GPU | Yes (one served chat model; STT/TTS sidecars also on GPU) | Yes (one served chat model; STT/TTS sidecars also on GPU) |
| Best for | Multi-card / multi-agent sessions (continuous batching keeps them concurrent) | Trying it out, smaller GPUs |

Pick one path and run it. Switching later is just a re-run with the
other flag — same image, same workspace, same volumes.

## Prerequisites

- Linux host with an NVIDIA GPU.
- NVIDIA driver matching your GPU.
- Docker Engine 24+.
- NVIDIA Container Toolkit configured:
  ```
  sudo nvidia-ctk runtime configure --runtime=docker
  sudo systemctl restart docker
  ```
- ~50 GB free disk on first run (model + image).
- The repo cloned locally:
  ```
  git clone https://github.com/mica-agent/mica.git
  cd mica
  ```

**Where the disk space lives.** Mica uses Docker's standard data
root — `/var/lib/docker` on most Linux installs. Both the
container image AND the `mica-models` named volume (which caches
the ~30 GB of LLM weights after first run) live there; the
`mica-workspace` bind-mount on your home directory only stores
project files (typically a few MB each). If your root filesystem
is tight, either relocate Docker's data root via
`/etc/docker/daemon.json` (`"data-root": "/path/with/space"`,
then `sudo systemctl restart docker`), or set `HF_CACHE_DIR` in
`.env` to bind-mount a host directory and bypass the named
volume entirely (see Customization).

## Required: Tavily API key

Mica's agents use Tavily-MCP for web search. Without a `TAVILY_API_KEY`
the `discover-dependency` skill — which the builder workflow leans on —
has no search tool, and multi-step builds that need to find a library
or verify a URL stall out. **Treat this as a prerequisite, not an
option.**

Get a free read-only key (1k searches/month) at https://app.tavily.com.

**Easiest**: on first `./scripts/mica-compose.sh up` the wrapper
prompts for the key (silent input) and writes it to `.env` for you.
Subsequent runs detect the saved key and skip the prompt.

**Hand-edit**: if you'd rather skip the prompt, drop the key into
`.env` before running up:

    echo "TAVILY_API_KEY=tvly-xxxxxxxxxxxxxxxxxxxxxx" >> .env

Set `MICA_SKIP_TAVILY=1` to bypass the check entirely (agent web
search will be disabled). Set `MICA_SKIP_SETUP=1` to suppress the
first-run prompt without disabling the check.

Validated on DGX Spark.

## Recommended: HuggingFace token

Both paths download model weights from HF Hub. Anonymous downloads
work but are rate-limited. A free read-only token from
https://huggingface.co/settings/tokens lifts those limits.

**Easiest**: on first `./scripts/mica-compose.sh up` the wrapper
detects a token at `~/.cache/huggingface/token` (from
`huggingface-cli login`) and offers `[Y/n]` to use it; otherwise it
prompts for a paste. Either path writes to `.env`.

**Hand-edit**:

    echo "HF_TOKEN=hf_xxxxxxxxxxxxxxxxxxxxxx" >> .env

The compose stack picks it up automatically via `env_file`.

## Path 1 — vLLM (default, recommended)

    ./scripts/mica-compose.sh up

Two containers: `mica` (frontend + backend + voice sidecars) and
`mica-vllm` (Qwen3.6 NVFP4 served by upstream vLLM). The wrapper
runs preflight checks (Docker, GPU passthrough, ports free, disk
space, HF token, image freshness), then `docker compose --profile
vllm up`.

First run takes 5–15 minutes in two stages: vLLM downloads ~30 GB
of NVFP4 weights into the `mica-models` named volume (the bulk of
the wait), then takes ~30–90 s to load the model and warm up
before answering. The terminal will sit during both stages —
`docker compose logs -f mica-vllm` shows progress for either.

Subsequent boots are seconds. Open http://localhost:5173.

## Path 2 — llama (1-container)

    ./scripts/mica-compose.sh up --llama

One container: `mica` with llama-server spawned inside on first chat
request. No vLLM sibling. The wrapper skips the vllm profile,
exports `MICA_DISABLE_LLAMA=0` and `LLAMA_URL=http://127.0.0.1:8012`
so the backend auto-spawns llama-server in-container.

First chat dispatch: 5–10 minutes (~22 GB Q4 GGUF download).
Subsequent chats: instant. Open http://localhost:5173.

## Path 3 — Devcontainer (for development)

If you're developing Mica itself (not just running it), open the repo
in VS Code with the **Dev Containers** extension:

1. `git clone https://github.com/mica-agent/mica.git && code mica`
2. VS Code prompts "Reopen in Container" — accept.
3. Inside the devcontainer terminal:
   ```
   bash scripts/start.sh
   ```

This runs Mica's frontend and backend as host processes inside the
devcontainer (not as compose containers). Voice sidecars auto-spawn
on first request. The chat vLLM container starts as a sibling via
the host docker socket (docker-outside-of-docker, configured in
`.devcontainer/devcontainer.json`).

Lifecycle: `scripts/start.sh`, `scripts/stop.sh`, `scripts/restart.sh`,
`scripts/status.sh`. See `CLAUDE.md` for the development guide.

## Remote access + audio (Tailscale)

**Required if you want voice from a different device.** Browser
microphones (`getUserMedia` / `MediaRecorder`) only work over HTTPS
— with one exception: `localhost`. So the `.voice` card works
out of the box when you're on the DGX Spark itself
(`http://localhost:5173`), but **does not work** when you open
Mica from another machine over `http://<host-ip>:5173`. You need an
HTTPS URL.

The simplest setup is **Tailscale Serve**, which terminates HTTPS
for you without exposing Mica to the public internet (the URL is
reachable only from devices signed into your tailnet). From the
**host shell** (NOT the devcontainer):

    bash scripts/https-on.sh

The script confirms `tailscale` is installed and authenticated,
runs `tailscale serve --bg 5173`, and prints the tailnet URL —
something like `https://your-host.your-tailnet.ts.net/`. Open
that on any device signed into your tailnet (laptop, phone, iPad);
audio works.

Stop with:

    bash scripts/https-off.sh

Prereqs: install Tailscale (`curl -fsSL https://tailscale.com/install.sh | sh`),
`sudo tailscale up`, sign into your tailnet. The script will point
you at the installer if Tailscale isn't on the host.

If you're local on the DGX Spark, you don't need any of this — open
`http://localhost:5173` and audio works.

## Lifecycle (Paths 1 & 2)

    ./scripts/mica-compose.sh status   # services + URLs
    ./scripts/mica-compose.sh logs     # tail all service logs
    ./scripts/mica-compose.sh stop     # graceful stop, keeps volumes
    ./scripts/mica-compose.sh nuke     # also delete volumes (confirms)
    ./scripts/mica-compose.sh doctor   # run preflight only

Pass `--llama` to `up` when you want the llama topology; omit for
vLLM. The other subcommands work the same regardless of topology
(they stop / inspect / log whatever's running).

**`stop` keeps the model cached.** Restarting after a `stop` skips the
download but still pays the ~30–90 s vLLM warm-boot. If you want to
force a clean cold boot (e.g. to test from-scratch behavior), use
`nuke` — it deletes the `mica-models` volume and the next `up`
re-downloads from HF Hub.

**Pass-through flags.** Any argument after the subcommand is forwarded
verbatim to `docker compose`. So `./scripts/mica-compose.sh up -d`
runs detached, `up --build` forces a rebuild, `up -d --force-recreate
mica` replaces only the mica container. See `docker compose up --help`
for the full list.

## Updating Mica

When a new release lands on the upstream repo:

    cd mica
    git pull
    ./scripts/mica-compose.sh up

The preflight detects that `mica:latest` is older than the updated
source and prompts:

    [WARN] mica:latest predates N commits on watched paths (built ...)
           Recent substantive changes:
             <commit list>
    Image is stale. Rebuild now? [Y/n]

Press Enter (default Yes) to rebuild. The image rebuild takes ~5–10
minutes; vLLM stays running so chat keeps working until the new mica
container swaps in. Model weights are cached — no re-download.

Scripted upgrades (CI, cron) can skip the prompt:

    MICA_AUTO_BUILD=1 ./scripts/mica-compose.sh up    # silent yes
    MICA_SKIP_REBUILD=1 ./scripts/mica-compose.sh up  # silent no (use last image)

Major upgrades (model swap, vLLM version bump) may also need a `nuke`
to clear the `mica-models` volume, but that's rare and the release
notes will say so explicitly when needed.

## Switching topologies

Stop, re-run with the other flag:

    ./scripts/mica-compose.sh stop
    ./scripts/mica-compose.sh up --llama   # was vLLM, now llama

Same image, same workspace, same `mica-models` volume. The vLLM
model and the llama Q4 GGUF are separate downloads, so the first
switch into a fresh topology re-downloads (then caches).

## Running multiple Mica instances

Two clones of Mica at different paths share docker state if they
share a directory basename. `~/dev/mica` and `~/dev/test/mica` both
resolve to compose project name `mica` and end up using the same
containers, networks, and volumes — confusing in the best case,
data-corrupting in the worst.

The wrapper's preflight detects this and warns:

    [WARN] compose project name 'mica' is already used by another clone:
           /home/rob/dev/mica/docker-compose.yml
           → Run this clone with its own project name (separate volumes, etc.):
           →   COMPOSE_PROJECT_NAME=mica-test ./scripts/mica-compose.sh up
           → Or rename the dir so the basename differs from the other clone.

To run two instances side-by-side cleanly, give each clone a unique
**project name**, **ports**, and **workspace**:

    # Production / primary
    git clone https://github.com/mica-agent/mica.git ~/dev/mica
    cd ~/dev/mica
    ./scripts/mica-compose.sh up

    # Test / side-by-side (different basename works without
    # COMPOSE_PROJECT_NAME, but ports + workspace still need overrides)
    git clone https://github.com/mica-agent/mica.git ~/dev/mica-test
    cd ~/dev/mica-test
    MICA_PORT=3003 \
    MICA_FRONTEND_PORT=5174 \
    MICA_WORKSPACE=$HOME/mica-test-workspace \
      ./scripts/mica-compose.sh up

The two instances are then fully isolated:

| What | Primary | Test |
|---|---|---|
| Compose project | `mica` | `mica-test` |
| Containers | `mica-mica-1`, `mica-mica-vllm-1` | `mica-test-mica-1`, `mica-test-mica-vllm-1` |
| Model cache volume | `mica_mica-models` | `mica-test_mica-models` (separate weights download) |
| Workspace | `$HOME/mica-workspace` | `$HOME/mica-test-workspace` |
| Backend port | 3002 | 3003 |
| Frontend port | 5173 | 5174 |

If you'd rather share the model weights between the two (avoid the
second ~30 GB download), point both at the same host HF cache:

    HF_CACHE_DIR=$HOME/.cache/huggingface ./scripts/mica-compose.sh up

## What's running (and what's pinned)

Mica's release stack has several moving pieces. The defaults
balance "known-good on first run" against "easy to track upstream":

| Component | Source | Pin posture |
|---|---|---|
| **vLLM** (chat + voice serving) | `vllm/vllm-openai@sha256:...` (digest of a recent `cu130-nightly`) | **pinned by default**. Smoke-tested with the Mica release. Override via `MICA_VLLM_IMAGE` to track nightly fresh or pin a different digest. |
| **llama.cpp** (llama topology only) | `git clone --depth 1 https://github.com/ggml-org/llama.cpp.git` at image build time | not pinned; rebuilds against HEAD whenever the mica image is rebuilt |
| **Chat model** | `RedHatAI/Qwen3.6-35B-A3B-NVFP4` (vLLM) or Qwen Q4 GGUF (llama) | pinned by name; HF Hub resolves to latest under that repo |
| **Voice models** | Parakeet-TDT-0.6b-v2 (STT), Kokoro-82M (TTS), Silero VAD | pinned by name |

Why pin vLLM by default: `cu130-nightly` is, by definition, a moving
target. A fresh `docker pull` between Mica releases could roll in
an incompatible nightly under your feet (silent breakage, no source
changes on your side). Pinning means new users hit a configuration
the maintainers have actually run.

Why pin llama.cpp explicitly is not the default: the llama topology
is the lighter, "simpler ops, slower" alternative — its audience is
more tolerant of churn, and pinning the commit would mean rebuilding
the image to update (no `docker pull` shortcut).

To see the exact build versions inside your running stack:

    docker exec mica-mica-vllm-1 python -c "import vllm; print(vllm.__version__)"
    docker exec mica-mica-1 /opt/mica/scripts/voice/.venv/bin/python -c "import torch; print(torch.__version__)"
    docker exec mica-mica-1 git -C /opt/llama.cpp log -1 --format='%h %s'

## Customization

Most users won't need these. All overrides go in `.env` at the
repo root, or as shell exports before `up`. See `.env.example` for
the full annotated list.

| Var | Purpose | Default |
|---|---|---|
| `MICA_WORKSPACE` | Host workspace dir | `$HOME/mica-workspace` |
| `MICA_PORT` | Backend port | `3002` |
| `MICA_FRONTEND_PORT` | Frontend port | `5173` |
| `MICA_LLAMA_PORT` | llama-server port (llama topology) | `8012` |
| `MICA_VLLM_IMAGE` | Override the pinned vLLM digest (e.g. set to `vllm/vllm-openai:cu130-nightly` to track nightly fresh) | pinned digest |
| `HF_CACHE_DIR` | Bind-mount a host HF cache instead of named volume | named volume |
| `HF_TOKEN` | HuggingFace auth | unset |
| `OPENROUTER_API_KEY` | Cloud-model fallback | unset |
| `MICA_AUTO_BUILD` | Auto-add `--build` when image is stale (silent yes to rebuild prompt) | unset |
| `MICA_SKIP_REBUILD` | Suppress the rebuild prompt and proceed without `--build` (silent no) | unset |
| `MICA_SKIP_TAVILY` | Bypass the Tavily-key preflight (search disabled) | unset |
| `MICA_SKIP_SETUP` | Suppress first-run prompts for Tavily / HF keys, even in a TTY | unset |
| `USER_UID` / `USER_GID` | Container user | `1000` / `1000` |

### Overriding the vLLM pin

The `mica-vllm` service is digest-pinned by default to a recent
`cu130-nightly` build that the Mica release has been smoke-tested
against. To track upstream nightly fresh (gets you new perf wins
as they ship; risks regressions):

    MICA_VLLM_IMAGE=vllm/vllm-openai:cu130-nightly ./scripts/mica-compose.sh up

To pin to a different digest (e.g. a newer one you've tested):

    docker pull vllm/vllm-openai:cu130-nightly
    docker inspect --format '{{index .RepoDigests 0}}' vllm/vllm-openai:cu130-nightly

Put the result in your `.env`:

    MICA_VLLM_IMAGE=vllm/vllm-openai@sha256:abc...

## Create your own template

Drop a curated project directory under `templates/`:

    cp -r workspace/my-project templates/my-template
    rm -rf templates/my-template/.mica/chats
    rm -rf templates/my-template/.mica/layout.json
    rm -rf templates/my-template/.mica-pids

The template appears in the project picker on next page load. The
first non-empty, non-`#` line of `.mica/canvas-back.md` becomes the
template's description (truncated to 200 characters), so keep that
line user-facing.

## Where Mica stores things

Three persistent stores, three different homes:

| What | Default location | Override | Notes |
|---|---|---|---|
| **User projects + canvas + chat history** | `$HOME/mica-workspace/<project>/` | `MICA_WORKSPACE=/path` | Host directory (bind-mounted into the container). `git pull` in the repo can't touch it. |
| **Model weights** (Qwen 3.6, Parakeet, Kokoro) | docker-managed volume `mica_mica-models` (typically `/var/lib/docker/volumes/mica_mica-models/_data/`) | `HF_CACHE_DIR=/path` | Bind-mount a host dir instead of the named volume. Setting `HF_CACHE_DIR=$HOME/.cache/huggingface` reuses anything `huggingface-cli` has already downloaded. |
| **Claude Code credentials** (for `.claude` cards) | docker-managed volume `mica_mica-claude` | (none) | Survives container restarts so `claude login` state persists. |

The wrapper's preflight reports which storage state you're in on every
`up`:

    [INFO] named volume 'mica_mica-models' already exists — model downloads will reuse it
    [INFO] HF_CACHE_DIR=/path — bind-mounting host dir for the model cache
    [INFO] first run — will download model weights to docker-managed volume 'mica_mica-models'

If `$HOME/.cache/huggingface` contains any of Mica's models on a fresh
install, the preflight surfaces a one-line hint with the override
command — saving the ~30 GB download.

### Per-project state

- Project files: `$MICA_WORKSPACE/<project>/` (visible on canvas).
- Chat history: `$MICA_WORKSPACE/<project>/.mica/chats/`.
- Card classes: `$MICA_WORKSPACE/<project>/.mica/card-classes/`.
- Delete `$MICA_WORKSPACE/<project>/.mica/` to reset all per-project
  state; the canvas files themselves remain.

### Resetting

- **Stop, keep everything**: `./scripts/mica-compose.sh stop`
- **Delete only models (force re-download)**: `docker volume rm mica_mica-models`
- **Delete everything Mica-side**: `./scripts/mica-compose.sh nuke` (containers + both volumes; `$HOME/mica-workspace/` survives).
- **Delete user projects too**: `rm -rf $HOME/mica-workspace`

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
  download weights on first invocation. Check `docker compose logs
  mica` for `[voice-stt] ready` and `[voice-tts] ready`.
- **Port 5173 / 3002 already in use** → set `MICA_FRONTEND_PORT` /
  `MICA_PORT` before `up`, or stop the conflicting process.
  `./scripts/mica-compose.sh doctor` lists which PIDs hold which
  ports.
- **"mica:latest is older than tracked source"** → preflight detected
  staleness. Run `./scripts/mica-compose.sh up --build`, or set
  `MICA_AUTO_BUILD=1` to make rebuilds automatic.
- **Switching topologies in-place** → run `stop`, then `up` with
  the other flag. Both topologies share the same `mica-models`
  volume; the first run into a fresh topology re-downloads its
  model (then caches).
