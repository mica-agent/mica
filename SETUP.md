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
  git clone https://github.com/<org>/mica.git
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

Get a free read-only key (1k searches/month) at
https://app.tavily.com, then save it to `.env` in the repo root:

    echo "TAVILY_API_KEY=tvly-xxxxxxxxxxxxxxxxxxxxxx" >> .env

The wrapper's preflight checks for it; missing-key fails preflight with
a remediation hint. Set `MICA_SKIP_TAVILY=1` to bypass with a warning
(agent web search will be disabled).

Validated on DGX Spark.

## Recommended: HuggingFace token

Both paths download model weights from HF Hub. Anonymous downloads
work but are rate-limited. Add a free read-only token from
https://huggingface.co/settings/tokens to your `.env`:

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

1. `git clone https://github.com/<org>/mica.git && code mica`
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

## Switching topologies

Stop, re-run with the other flag:

    ./scripts/mica-compose.sh stop
    ./scripts/mica-compose.sh up --llama   # was vLLM, now llama

Same image, same workspace, same `mica-models` volume. The vLLM
model and the llama Q4 GGUF are separate downloads, so the first
switch into a fresh topology re-downloads (then caches).

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
| `MICA_VLLM_IMAGE` | Pin a vLLM image digest | upstream nightly |
| `HF_CACHE_DIR` | Bind-mount a host HF cache instead of named volume | named volume |
| `HF_TOKEN` | HuggingFace auth | unset |
| `OPENROUTER_API_KEY` | Cloud-model fallback | unset |
| `MICA_AUTO_BUILD` | Auto-add `--build` when image is stale | unset |
| `MICA_SKIP_TAVILY` | Bypass the Tavily-key preflight (search disabled) | unset |
| `USER_UID` / `USER_GID` | Container user | `1000` / `1000` |

### Pinning the vLLM image

The `mica-vllm` service defaults to `vllm/vllm-openai:cu130-nightly`
— a floating tag that drifts. Capture a digest for stable
deployments:

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

## Workspace + history

- Default workspace lives at `$HOME/mica-workspace/` (outside the
  cloned repo, so `git pull` can't touch your projects).
- Override via `MICA_WORKSPACE=/path/of/your/choice`.
- Projects live at `$MICA_WORKSPACE/<project>/`.
- Chat history at `$MICA_WORKSPACE/<project>/.mica/chats/`.
- Delete `$MICA_WORKSPACE/<project>/.mica/` to reset all per-project
  state; the canvas files themselves remain.

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
