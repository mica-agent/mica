# Mica production runtime image (for VS Code development, use
# .devcontainer/Dockerfile — which shares this base, so the cuDNN /
# Python posture is identical across both).
#
# This image runs Mica's frontend (Vite), backend (Node), and voice
# sidecars (Parakeet STT, Kokoro TTS) in a single container.
#
# vLLM serving is NOT inside this image — `docker compose up` (see
# docker-compose.yml) adds the upstream vllm/vllm-openai container as
# a SIBLING. Keeping vLLM serving separate is an operational choice
# (independent upgrade cycle, distinct GPU-memory profile, cleaner
# logs) — not a technical necessity. The cuDNN ABI conflict between
# the vLLM base's bundled cuDNN and the voice sidecars' torch-bundled
# cuDNN is handled at build time by scripts/voice/install.sh,
# which detects the system cuDNN MAJOR.MINOR and force-reinstalls
# nvidia-cudnn-cu13 in the venv to match. Same dance the devcontainer
# uses — proven.
#
# In single-container mode (no vLLM sibling), this image's bundled
# llama-server is used for local LLM serving — the "lean path" in
# QUICKSTART.md. Install via `./install.sh`, lifecycle via
# `bash scripts/mica.sh {start|stop|restart}`.
#
# Base: NVIDIA's vLLM 26.04 image (same as .devcontainer/Dockerfile).
# Provides CUDA toolkit + cuDNN + libcuda runtime libs + Python +
# torch + vLLM Python deps. The runtime libs being present (vs. the
# stub-only CUDA devel image) means llama.cpp can LINK cleanly without
# the libcuda.so.1 symlink workaround that the devel base required.
# Multi-arch; we publish linux/arm64 for now (DGX Spark is arm64
# Grace+Blackwell).
FROM nvcr.io/nvidia/vllm:26.04-py3

# System deps.
#   curl/git/ca-certs/sudo/lsof/procps — basics + dev parity + script compat
#   cmake/build-essential              — to build llama.cpp with CUDA (lean path)
# The vLLM base already ships python3 + pip + venv + nvcc + cuDNN +
# libcuda runtime libs; we only top up the few CLI utilities Mica's
# start/stop/status scripts assume on PATH.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git ca-certificates sudo lsof procps \
    cmake build-essential \
 && rm -rf /var/lib/apt/lists/*

# UID 1000 user — matches most Linux hosts so bind-mounted workspaces
# don't end up with permission mismatches.
RUN if id -u 1000 >/dev/null 2>&1; then \
      existing=$(getent passwd 1000 | cut -d: -f1) && \
      usermod -l vscode -d /home/vscode -m "$existing" && \
      groupmod -n vscode "$(id -gn 1000)"; \
    else useradd -m -s /bin/bash -u 1000 vscode; fi \
 && usermod -aG sudo vscode \
 && echo "vscode ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers \
 && mkdir -p /home/vscode/.cache \
 && chown -R vscode:vscode /home/vscode

# llama.cpp with CUDA, pinned to DGX Spark's Blackwell target (sm_121).
#
# CONDITIONAL: only built when INSTALL_LLAMA=1 (the default for the
# lean install.sh/mica.sh single-container topology). docker-compose.yml
# passes INSTALL_LLAMA=0 because the compose path uses vLLM in a
# sibling container — llama-server isn't reachable or wanted there.
# Skipping saves ~5-10 min of build time on the compose path.
#
# Build details when we DO build:
#   - Only the llama-server target. llama.cpp's example binaries
#     (llama-simple, llama-llava-cli, etc.) are out of scope; building
#     them adds time and surface area we don't use.
#   - LLAMA_BUILD_TESTS=OFF, LLAMA_BUILD_EXAMPLES=OFF for the same reason.
#   - Parallelism cap at min(nproc, 8). Grace has 72 cores; 72 parallel
#     ld processes each using 4-8 GB during link exhaust host RAM and
#     get OOM-killed mid-link. 8 stays under ~64 GB linker footprint.
#     Override via --build-arg LLAMA_JOBS=N.
#   - The vLLM base ships libcuda.so.1, so no stub-symlink workaround is
#     needed (the prior CUDA-devel base didn't ship it, which broke link).
ARG INSTALL_LLAMA=1
ARG LLAMA_JOBS=
RUN if [ "$INSTALL_LLAMA" = "1" ]; then \
      set -eux; \
      git clone --depth 1 https://github.com/ggml-org/llama.cpp.git /opt/llama.cpp; \
      cd /opt/llama.cpp; \
      jobs="${LLAMA_JOBS:-$(nproc)}"; \
      [ "$jobs" -le 8 ] || jobs=8; \
      echo "Building llama.cpp llama-server target with -j$jobs"; \
      cmake -B build \
        -DGGML_CUDA=ON \
        -DCMAKE_CUDA_ARCHITECTURES=121 \
        -DLLAMA_BUILD_TESTS=OFF \
        -DLLAMA_BUILD_EXAMPLES=OFF; \
      cmake --build build --config Release --target llama-server -j"$jobs"; \
      ln -sf /opt/llama.cpp/build/bin/llama-server /usr/local/bin/llama-server; \
    else \
      echo "INSTALL_LLAMA=$INSTALL_LLAMA — skipping llama.cpp build (compose path uses vLLM sibling)"; \
    fi

# Node 22 (current LTS) via NodeSource. We were on 20 historically;
# the devcontainer's node:1 feature resolves "lts" to 22, so dev and
# prod had drifted. isolated-vm@6.1.2 (transitive dep) requires Node
# >=22 — its native module uses v8::SourceLocation, added in V8 12.x
# (Node 22+). Building against Node 20 fails with:
#   error: 'SourceLocation' in namespace 'v8' does not name a type
# Bumping to 22 aligns with devcontainer and unblocks the build.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
 && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*

# GitHub CLI (gh) from the official upstream apt repo. Lets users
# `gh auth login` from a .terminal card and unlocks gh-based tooling
# (PR creation, issue browsing) from inside Mica.
RUN mkdir -p -m 755 /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

USER vscode
WORKDIR /opt/mica

# Claude Code CLI (for .claude cards). Installs to ~/.local/bin/claude.
# We prepend that to PATH so spawn-by-name from the .claude card class
# (which does `claude` not `~/.local/bin/claude`) resolves. Tolerate
# offline builds so the image still succeeds if claude.ai is
# unreachable during build.
ENV PATH=/home/vscode/.local/bin:$PATH
RUN curl -fsSL https://claude.ai/install.sh | bash || true

# OpenCode CLI (for .opencode cards). Same spawn-by-name pattern as
# Claude: @opencode-ai/sdk's createOpencodeServer calls cross-spawn
# ("opencode") so the standalone binary MUST be on PATH at backend
# spawn time. The npm package only ships the TypeScript client; the
# CLI is a separate install. Lands at ~/.opencode/bin/opencode under
# the active USER (vscode at this point), so the PATH update finds it.
# Tolerate offline builds the same way Claude does.
ENV PATH=/home/vscode/.opencode/bin:$PATH
RUN curl -fsSL https://opencode.ai/install | bash || true

# Mica deps first (layer cache): just package*.json → npm ci.
COPY --chown=vscode:vscode package.json package-lock.json ./
RUN npm ci

# The Qwen Code CLI ships bundled with @qwen-code/sdk (0.1.1+) at
# node_modules/.bin/qwen. Its SDK's auto-detect scans /usr/local/bin/qwen
# et al., but NOT /opt/mica/node_modules/.bin; symlink there so the
# subprocess the SDK spawns is findable regardless of CWD or PATH.
# Mirrors the llama-server symlink pattern above.
RUN sudo ln -sf /opt/mica/node_modules/.bin/qwen /usr/local/bin/qwen

# Mica source.
COPY --chown=vscode:vscode . .

# Build is best-effort — dev:all uses tsx which doesn't need dist/.
# A tsc failure during image build shouldn't block a working runtime.
RUN npm run build 2>/dev/null || true

# Voice sidecar Python venv (Parakeet STT via nemo_toolkit, Kokoro TTS).
# We run install.sh at BUILD time rather than first-run so the
# cuDNN MAJOR.MINOR alignment dance (see install.sh) happens once
# and the result is baked in. Adds ~3-4 GB to the image but removes the
# 5-10 min first-run latency every fresh deploy would otherwise pay.
RUN bash scripts/voice/install.sh

# Default workspace mount point. Override via `-v /host/path:/project`.
ENV PROJECT_DIR=/project
ENV MICA_PORT=3002

# Documented ports: backend API, Vite dev server, llama-server.
EXPOSE 3002 5173 8012

# Universal entrypoint. start.sh handles both topologies via env flags:
#   - docker-compose path: MICA_DISABLE_LLAMA=1 + MICA_DISABLE_CHAT_VLLM=1
#     → no local LLM here; talk to the sibling mica-vllm container.
#   - single-container (install.sh / mica.sh) path: MICA_DISABLE_CHAT_VLLM=1
#     (set by install.sh/mica.sh; skips nested vLLM container spawn),
#     MICA_DISABLE_LLAMA unset → backend auto-spawns the bundled
#     llama-server on :8012 for local inference.
# Both paths go through the same script and same image; only env differs.
CMD ["bash", "scripts/start.sh"]
