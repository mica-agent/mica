# Mica production runtime image (for VS Code development, use
# .devcontainer/Dockerfile instead).
#
# This image runs Mica's frontend (Vite), backend (Node), and voice
# sidecars (Parakeet STT, Kokoro TTS) in a single container. It does
# NOT bundle vLLM — when serving via vLLM, run `docker compose up`
# (see docker-compose.yml) which adds the upstream
# vllm/vllm-openai container as a sibling. Co-locating vLLM and the
# voice sidecars in one image collides over cuDNN ABI versions
# (CUDNN_STATUS_SUBLIBRARY_VERSION_MISMATCH at Kokoro/Parakeet GPU
# init); separate containers, separate cuDNN, no conflict.
#
# In single-container mode (no vLLM sibling), this image's bundled
# llama-server is used for local LLM serving — the "lean path" in
# QUICKSTART.md. Install via `./install.sh`, lifecycle via
# `bash scripts/mica.sh {start|stop|restart}`.
#
# Base: NVIDIA CUDA 13.1 devel on Ubuntu 24.04. Matches the DGX Spark
# host driver (580.x exposing CUDA 13.1) and includes nvcc so we can
# build llama.cpp with CUDA during image build. Multi-arch; we only
# publish linux/arm64 for now (DGX Spark is arm64 Grace+Blackwell).
FROM nvcr.io/nvidia/cuda:13.1.0-devel-ubuntu24.04

# System deps.
#   curl/git/ca-certs/sudo/lsof/procps — basics + dev parity + script compat
#   cmake/build-essential              — to build llama.cpp with CUDA
#   python3/pip/venv                   — mica cards and the agent routinely
#                                        invoke python3; pip+venv lets users
#                                        `pip install` inside project scope
# nvidia-smi isn't listed: it ships inside the CUDA devel image AND is
# passed through from the host driver by the NVIDIA Container Toolkit
# whenever --gpus all is set. Available either way.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git ca-certificates sudo lsof procps \
    cmake build-essential \
    python3 python3-pip python3-venv \
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
# Explicit CMAKE_CUDA_ARCHITECTURES avoids any auto-detect surprise where
# a build silently falls back to CPU at runtime.
RUN git clone --depth 1 https://github.com/ggml-org/llama.cpp.git /opt/llama.cpp \
 && cd /opt/llama.cpp \
 && cmake -B build -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=121 \
 && cmake --build build --config Release -j$(nproc) \
 && ln -sf /opt/llama.cpp/build/bin/llama-server /usr/local/bin/llama-server

# Node 20 via NodeSource.
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
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

# Claude Code CLI (for .claude cards). Tolerate offline builds so the
# image still succeeds if claude.ai is unreachable during build.
RUN curl -fsSL https://claude.ai/install.sh | bash || true

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
# cuDNN MAJOR.MINOR alignment dance (see install.sh:68-97) happens once
# and the result is baked in. Adds ~3-4 GB to the image but removes the
# 5-10 min first-run latency every fresh deploy would otherwise pay. The
# script tolerates audio-sample-download failures during build (each
# clip is fetched in a try/except) so an unreliable network at build
# time doesn't fail the image build.
RUN bash scripts/benchmarks/voice/install.sh

# Default workspace mount point. Override via `-v /host/path:/project`.
ENV PROJECT_DIR=/project
ENV MICA_PORT=3002

# Documented ports: backend API, Vite dev server, llama-server.
EXPOSE 3002 5173 8012

# Universal entrypoint. start.sh handles both topologies via env flags:
#   - docker-compose path: MICA_DISABLE_LLAMA=1 + MICA_DISABLE_CHAT_VLLM=1
#     → no local LLM here; talk to the sibling mica-vllm container.
#   - single-container (install.sh / mica.sh) path: unset DISABLE flags →
#     start.sh auto-spawns llama-server on :8012 for local inference.
# Both paths go through the same script and same image; only env differs.
CMD ["bash", "scripts/start.sh"]
