#FROM nvcr.io/nvidia/tensorrt-llm/release:1.2.0rc6
#FROM nvcr.io/nvidia/tensorrt-llm/release:1.3.0rc10
#FROM lmsysorg/sglang:spark
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
# in dev). Aligned with the production Dockerfile so dev and prod hit the
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

# NOTE: keep transformers at vLLM 0.15's pinned 4.57.5. Newer transformers
# breaks Qwen2VL/Qwen3VL image processor (max_pixels removed). Gemma 4 needs
# transformers 5.x AND has additional vLLM 0.15 bugs (top_k assertion for
# 26B-A4B MoE, layer_scalar mismatch for 31B FP8) — wait for vLLM 0.16+ NGC
# image (likely 26.03) which should ship proper Gemma 4 multimodal support.


