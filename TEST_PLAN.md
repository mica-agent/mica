# Test Plan: Project-First Architecture

## Prerequisites

- Docker daemon running
- Node.js + npm available
- Mica server built and runnable (`npm run dev` or equivalent)
- A scratch directory for test projects (e.g., `/tmp/mica-test/`)

---

## 1. Project Connection Lifecycle

### 1a. Connect a fresh directory
```bash
mkdir /tmp/mica-test/project-alpha
curl -X POST http://localhost:3001/api/projects/connect \
  -H 'Content-Type: application/json' \
  -d '{"path": "/tmp/mica-test/project-alpha"}'
```
**Verify:**
- [ ] Response contains `{ id: "project-alpha", ... }`
- [ ] `/tmp/mica-test/project-alpha/.mica/config.json` exists
- [ ] `/tmp/mica-test/project-alpha/.mica/workspace/` directory exists
- [ ] `/tmp/mica-test/project-alpha/.git/` exists (auto-initialized)
- [ ] `workspaces.json` contains the project entry

### 1b. Connect an existing git repo
```bash
cd /tmp/mica-test && git init project-beta && echo "hello" > project-beta/README.md
curl -X POST http://localhost:3001/api/projects/connect \
  -H 'Content-Type: application/json' \
  -d '{"path": "/tmp/mica-test/project-beta"}'
```
**Verify:**
- [ ] `.mica/` created inside existing repo
- [ ] Existing `.git/` untouched (not re-initialized)
- [ ] `README.md` untouched

### 1c. Disconnect
```bash
curl -X POST http://localhost:3001/api/projects/project-alpha/disconnect
```
**Verify:**
- [ ] Project removed from `workspaces.json`
- [ ] `.mica/` directory still exists in `/tmp/mica-test/project-alpha/`
- [ ] Project files untouched

### 1d. Reconnect
```bash
curl -X POST http://localhost:3001/api/projects/connect \
  -H 'Content-Type: application/json' \
  -d '{"path": "/tmp/mica-test/project-alpha"}'
```
**Verify:**
- [ ] Picks up existing `.mica/config.json` (no re-initialization)
- [ ] Any prior canvas metadata preserved

### 1e. Duplicate connection rejected
```bash
curl -X POST http://localhost:3001/api/projects/connect \
  -H 'Content-Type: application/json' \
  -d '{"path": "/tmp/mica-test/project-alpha"}'
```
**Verify:**
- [ ] Returns error: "Project already connected"

---

## 2. Canvas Metadata (via `.mica/`)

### 2a. List project files
```bash
curl http://localhost:3001/api/projects/project-alpha/canvases/workspace/files
```
**Verify:**
- [ ] Returns metadata files from `.mica/workspace/` (e.g., `_brief.md`, `_goal.md`)

### 2b. Write and read a brief
```bash
curl -X PUT http://localhost:3001/api/projects/project-alpha/canvases/workspace/files/_brief.md \
  -H 'Content-Type: application/json' \
  -d '{"content": "You are a test agent."}'

curl http://localhost:3001/api/projects/project-alpha/canvases/workspace/files/_brief.md
```
**Verify:**
- [ ] File written to `/tmp/mica-test/project-alpha/.mica/workspace/_brief.md`
- [ ] Content returned correctly on read

### 2c. Add a canvas
```bash
curl -X POST http://localhost:3001/api/projects/project-alpha/canvases \
  -H 'Content-Type: application/json' \
  -d '{"name": "architecture"}'
```
**Verify:**
- [ ] `.mica/architecture/` directory created
- [ ] `config.json` updated with new canvas
- [ ] `workspaces.json` updated

---

## 3. Per-Project Git Operations

### 3a. Status on clean repo
```bash
curl http://localhost:3001/api/projects/project-alpha/git/status
```
**Verify:**
- [ ] Returns `{ clean: true, staged: [], modified: [], untracked: [] }` (or untracked `.mica/` files)

### 3b. Commit changes
```bash
echo "# Alpha" > /tmp/mica-test/project-alpha/README.md
curl -X POST http://localhost:3001/api/projects/project-alpha/git/commit \
  -H 'Content-Type: application/json' \
  -d '{"message": "Initial commit"}'
```
**Verify:**
- [ ] Returns `{ hash, message, filesChanged }`
- [ ] `git log` in project directory shows the commit

### 3c. View log
```bash
curl http://localhost:3001/api/projects/project-alpha/git/log?limit=5
```
**Verify:**
- [ ] Returns array of `{ hash, shortHash, message, date }`

### 3d. View diff
```bash
echo "change" >> /tmp/mica-test/project-alpha/README.md
curl http://localhost:3001/api/projects/project-alpha/git/diff
```
**Verify:**
- [ ] Returns diff showing the added line

### 3e. Branch operations
```bash
curl http://localhost:3001/api/projects/project-alpha/git/branches

curl -X POST http://localhost:3001/api/projects/project-alpha/git/checkout \
  -H 'Content-Type: application/json' \
  -d '{"branch": "feature-x", "create": true}'

curl http://localhost:3001/api/projects/project-alpha/git/branches
```
**Verify:**
- [ ] First call shows `main` as current
- [ ] Checkout creates `feature-x` branch
- [ ] Second call shows `feature-x` as current

### 3f. Concurrent safety
Run two commits simultaneously against the same project:
```bash
curl -X POST .../git/commit -d '{"message":"A"}' &
curl -X POST .../git/commit -d '{"message":"B"}' &
wait
```
**Verify:**
- [ ] Both complete without error (mutex serializes them)
- [ ] Log shows both commits in sequence

---

## 4. Per-Project Container Isolation

### 4a. Start a container
```bash
# Create a simple app
echo 'import http.server; http.server.HTTPServer(("",8080), http.server.SimpleHTTPRequestHandler).serve_forever()' \
  > /tmp/mica-test/project-alpha/app.py

curl -X POST http://localhost:3001/api/projects/project-alpha/container/start
```
**Verify:**
- [ ] Returns `{ containerId, containerName: "mica-app-project-alpha", ports: [{container:8080, host:9000-9099}] }`
- [ ] `docker ps` shows the container running
- [ ] Accessing `http://localhost:{hostPort}` returns a directory listing

### 4b. Container status
```bash
curl http://localhost:3001/api/projects/project-alpha/container/status
```
**Verify:**
- [ ] Returns `{ running: true, status: "running", ports: [...] }`

### 4c. Container logs
```bash
curl http://localhost:3001/api/projects/project-alpha/container/logs?tail=10
```
**Verify:**
- [ ] Returns recent output from the container

### 4d. Stop container
```bash
curl -X POST http://localhost:3001/api/projects/project-alpha/container/stop
```
**Verify:**
- [ ] Container removed from `docker ps`
- [ ] Port released (can be reused)

### 4e. Cross-project isolation
```bash
# Start containers for two projects
curl -X POST .../project-alpha/container/start
curl -X POST .../project-beta/container/start
```
**Verify:**
- [ ] Two separate containers running (`mica-app-project-alpha`, `mica-app-project-beta`)
- [ ] Different host port assignments
- [ ] Stop one → the other keeps running
- [ ] Files in one container don't appear in the other

---

## 5. Migration from Legacy `canvases/`

### 5a. Migrate existing projects
```bash
# Ensure canvases/_projects.json exists with at least one project
curl -X POST http://localhost:3001/api/migrate
```
**Verify:**
- [ ] New project directories created at target location
- [ ] `.mica/config.json` written with correct canvas list
- [ ] Canvas metadata files (`_brief.md`, `_goal.md`, etc.) copied to `.mica/{canvas}/`
- [ ] `_card-classes/` copied if present
- [ ] Each migrated project registered in `workspaces.json`
- [ ] Each migrated project has `.git/` initialized
- [ ] Original `canvases/` directory preserved

---

## 6. End-to-End Workflow

### Full cycle test
1. Connect a fresh directory as a project
2. Write a `_brief.md` with agent instructions
3. Create `app.py` in the project root
4. Start the project container → verify app is accessible
5. Chat with the agent → agent modifies `app.py`
6. Verify auto-commit appears in git log
7. View diff of the agent's changes
8. Stop container
9. Disconnect project
10. Reconnect → verify all metadata preserved
11. Start container again → same app runs

**This validates the full loop: connect → configure → run → iterate → disconnect → reconnect.**

---

## Automation

These tests can be scripted as a bash test suite:

```bash
#!/bin/bash
set -e
API="http://localhost:3001"
TEST_DIR="/tmp/mica-test-$(date +%s)"
mkdir -p "$TEST_DIR"

# ... each test as a function with assertions ...
# cleanup: docker stop all mica-app-* containers, rm -rf $TEST_DIR
```

Priority for automation: Tests 1a–1e and 3a–3e (no Docker dependency). Container tests (4a–4e) require Docker-in-Docker or a host Docker socket.
