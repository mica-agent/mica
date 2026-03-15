FROM node:20-slim

# System basics
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip python3-venv \
    curl git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Create non-root sandbox user
RUN useradd -m -s /bin/bash sandbox
USER sandbox
WORKDIR /workspace

ENTRYPOINT ["claude"]
