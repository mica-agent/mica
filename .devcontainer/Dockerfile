FROM nvcr.io/nvidia/vllm:26.04-py3

# Install sudo and create vscode user with sudo access
RUN apt-get update && apt-get install -y sudo lsof net-tools procps curl ca-certificates && rm -rf /var/lib/apt/lists/* && \
    if id -u 1000 >/dev/null 2>&1; then \
        existing_user=$(getent passwd 1000 | cut -d: -f1) && \
        usermod -l vscode -d /home/vscode -m "$existing_user" && \
        groupmod -n vscode "$(id -gn 1000)"; \
    else \
        useradd -m -s /bin/bash -u 1000 vscode; \
    fi && \
    usermod -aG sudo vscode && \
    echo "vscode ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

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

# Pre-create cache directory with correct ownership (bind mounts may create it as root)
RUN mkdir -p /home/vscode/.cache && chown vscode:vscode /home/vscode/.cache

# Build llama.cpp with CUDA support (lets us run llama-server alongside vLLM
# in dev). Aligned with the release Dockerfile so dev and release hit the
# same compile/link surface:
#   - CMAKE_CUDA_ARCHITECTURES=121 pins Blackwell DGX Spark (GB10, sm_121).
#     Without the pin, llama.cpp's CMake autodetects via `native`, which
#     fails inside docker build ("No CUDA devices found" — host driver
#     isn't passed through at build time) and silently falls back to
#     CMake defaults that may not include sm_121. Build artifacts then
#     can't target the GPU at runtime.
#   - Parallelism cap at min(nproc, 8). Grace has 72 cores; 72 parallel
#     `ld` processes each using 4-8 GB during link can exhaust host RAM
#     and trigger OOM-kill mid-build. 8 stays under ~64 GB linker
#     footprint while still benefitting from parallel compilation.
#     Override with --build-arg LLAMA_JOBS=N.
#   - Only build the llama-server target, with LLAMA_BUILD_TESTS=OFF and
#     LLAMA_BUILD_EXAMPLES=OFF — Mica never invokes llama-cli or the
#     example binaries (llama-simple, llama-llava-cli, etc.). Saves
#     ~5-10 min of compile time + reduces image bloat.
ARG LLAMA_JOBS=
RUN set -eux; \
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
    ln -sf /opt/llama.cpp/build/bin/llama-server /usr/local/bin/llama-server

# OpenCode CLI (for .opencode cards). The .opencode card class spawns
# `opencode serve` via @opencode-ai/sdk's createOpencodeServer, which
# calls cross-spawn("opencode") and so requires the BINARY on PATH at
# backend spawn time — the npm `@opencode-ai/sdk` package alone is just
# the TypeScript client; the standalone CLI is a separate install.
#
# Install as vscode (the user the backend runs as in this devcontainer)
# so it lands in /home/vscode/.opencode/bin/opencode rather than root's
# home (unreachable when the container later runs as vscode). ENV PATH
# update applies to all subsequent docker layers AND the running
# container, so the backend finds the binary without start.sh needing
# to know about it. Tolerate offline builds — opencode.ai unreachable
# during `docker build` shouldn't break the image; users can run the
# installer ad-hoc later via `bash scripts/install-opencode.sh` or the
# `curl | bash` line documented in QUICKSTART.
ENV PATH=/home/vscode/.opencode/bin:$PATH
RUN su -l vscode -c 'curl -fsSL https://opencode.ai/install | bash' || true

# Playwright system dependencies for headless Chromium. Used by the live-
# mount verifier (server/verifiers/cardLiveMount.ts) to actually run the
# card in a real browser at write time and catch runtime errors that
# defensive try/catch in card.js would otherwise swallow. The Chromium
# binary itself is downloaded by `npx playwright install chromium` after
# the npm install in postCreate; this RUN just gets the apt-level libs
# (libnss3, libatspi, etc.) so the binary can launch. Listed verbatim
# from `playwright install-deps` so future Playwright updates don't
# silently regress the set.
RUN apt-get update && apt-get install -y --no-install-recommends \
      libnspr4 libnss3 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 \
      libxkbcommon0 libatspi2.0-0t64 libxcomposite1 libxdamage1 libxfixes3 \
      libxrandr2 libgbm1 libcairo2 libpango-1.0-0 libasound2t64 fonts-liberation \
      fonts-noto-color-emoji fonts-wqy-zenhei xfonts-cyrillic xfonts-scalable \
 && rm -rf /var/lib/apt/lists/*

