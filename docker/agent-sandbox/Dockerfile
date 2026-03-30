FROM node:20-slim

# System basics — Python removed (card classes run in V8 isolates on the host)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN curl -fsSL https://claude.ai/install.sh | bash

# Create non-root sandbox user with UID 1000 (matches typical host user).
# The node:20-slim image already has a 'node' user at UID 1000, so remove it first.
RUN userdel -r node 2>/dev/null; useradd -m -s /bin/bash -u 1000 sandbox
USER sandbox
WORKDIR /workspace

ENTRYPOINT ["claude"]
