# Mica runtime image for DGX Spark.
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

# Default workspace mount point. Override via `-v /host/path:/project`.
ENV PROJECT_DIR=/project
ENV MICA_PORT=3002

# Documented ports: backend API, Vite dev server, llama-server.
EXPOSE 3002 5173 8012

# Foreground process — concurrently manages vite + tsx, forwards signals,
# pipes stdout/stderr. Plays nicely with `docker logs` and `docker stop`.
CMD ["npm", "run", "dev:all"]
