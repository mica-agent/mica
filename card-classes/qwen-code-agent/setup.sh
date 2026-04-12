#!/bin/bash
# Install Qwen Code SDK and CLI
npm install -g @qwen-code/sdk @qwen-code/qwen-code@latest
# Fix tiktoken wasm dependency for CLI
cd /usr/local/lib/node_modules/@qwen-code/qwen-code && npm install tiktoken 2>/dev/null
cp node_modules/tiktoken/tiktoken_bg.wasm bundle/tiktoken_bg.wasm 2>/dev/null || true
# Symlink SDK into /opt/mica/node_modules so card class ESM imports can find it
ln -sf /usr/local/lib/node_modules/@qwen-code /opt/mica/node_modules/@qwen-code 2>/dev/null || true
# Install Qwen Code skills for card class creation
mkdir -p /project/.qwen/skills
cp -r /opt/mica/card-classes/qwen-code-agent/skills/create-card-class /project/.qwen/skills/ 2>/dev/null || true
rm -rf /project/.qwen/skills/design-card 2>/dev/null || true
# Fix ownership so host process can delete project directory
chown -R sandbox:sandbox /project/.qwen 2>/dev/null || true
