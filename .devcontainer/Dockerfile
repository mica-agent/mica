FROM nvcr.io/nvidia/tensorrt-llm/release:1.2.0rc6

# Install sudo and create vscode user with sudo access
RUN apt-get update && apt-get install -y sudo lsof net-tools procps && rm -rf /var/lib/apt/lists/* && \
    if id -u 1000 >/dev/null 2>&1; then \
        existing_user=$(getent passwd 1000 | cut -d: -f1) && \
        usermod -l vscode -d /home/vscode -m "$existing_user" && \
        groupmod -n vscode "$(id -gn 1000)"; \
    else \
        useradd -m -s /bin/bash -u 1000 vscode; \
    fi && \
    usermod -aG sudo vscode && \
    echo "vscode ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers

# Pre-create cache directory with correct ownership (bind mounts may create it as root)
RUN mkdir -p /home/vscode/.cache && chown vscode:vscode /home/vscode/.cache

# Set environment variables
ENV PYTHONPATH=/workspace
ENV PATH=/workspace/.venv/bin:$PATH

# Create virtual environment
RUN python3 -m venv /workspace/.venv
ENV VIRTUAL_ENV=/workspace/.venv
ENV PATH=/workspace/.venv/bin:$PATH

# Upgrade pip
RUN pip install --upgrade pip

# Build llama.cpp with CUDA support (pinned to b8400)
RUN git clone --branch b8400 --depth 1 https://github.com/ggerganov/llama.cpp.git /opt/llama.cpp && \
    cd /opt/llama.cpp && \
    cmake -B build -DGGML_CUDA=ON && \
    cmake --build build --config Release -j$(nproc) && \
    ln -s /opt/llama.cpp/build/bin/llama-cli /usr/local/bin/llama-cli && \
    ln -s /opt/llama.cpp/build/bin/llama-server /usr/local/bin/llama-server


