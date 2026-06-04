# Cloud hosting & the multi-tenant fork contract

Mica is, by design, a **single-tenant app**: one backend, one workspace of
projects, no authentication — the trust boundary is the host (LAN / tailnet /
single user). See [FEATURES.md](../FEATURES.md) § Security model.

Multi-tenant cloud hosting (each logged-in user gets their own container) is
built in a **fork**. The fork owns everything tenant-specific — auth, the
per-user container spawner, routing, idle-reaping, per-user secrets. Main Mica
deliberately does **not** absorb any of that.

This document is the **contract between main and the fork**: the seams and
enablers main commits to keeping stable, so the fork can run stock Mica with a
few env vars / build args instead of patching core. It's the page to diff after
`git merge main`. Everything here is **dormant by default** — a stock
`bash scripts/start.sh` or `docker compose up` behaves exactly as it always has.

---

## 1. The GPU-free / cloud-only run profile

Per-user GPUs don't scale, so the multi-tenant deployment runs **CPU-only
containers that route all inference to a cloud provider** (OpenRouter or any
OpenAI-compatible endpoint). The same profile is useful for a solo user with no
GPU.

Set these env vars (e.g. in the container's `.env` or `docker run -e`):

```sh
MICA_DISABLE_LLAMA=1          # don't spawn the in-container llama-server
MICA_DISABLE_CHAT_VLLM=1      # don't spawn / expect a vLLM sibling
MICA_DISABLE_VOICE=1          # no Parakeet/Kokoro sidecars (they need a GPU)
MICA_DEFAULT_PROVIDER=openrouter   # new agent cards default to the cloud provider
OPENROUTER_API_KEY=sk-or-v1-...
OPENROUTER_DEFAULT_MODEL=qwen/qwen3.6-35b-a3b
# — or, for an OpenAI-compatible endpoint instead of OpenRouter:
# MICA_DEFAULT_PROVIDER=openai-compat
# OPENAI_BASE_URL=https://your-endpoint/v1
# OPENAI_API_KEY=sk-...
# OPENAI_DEFAULT_MODEL=deepseek/deepseek-v4-flash
```

`start.sh` honors all three `MICA_DISABLE_*` flags: it skips the voice-first
wait and the vLLM launch and prints `Skipping voice-first wait: chat-vllm
disabled`. The backend + frontend come up with no GPU, no docker socket, no
errors.

**What this profile gives up** (all local/GPU-bound):

| Feature | Status without a GPU |
|---|---|
| Chat / opencode agents | ✅ Work — routed to the cloud provider |
| Missing/invalid provider key | ✅ Graceful — inline "set model settings" prompt + Retry (the `probeModelEndpoint` health-gate), not a crash |
| Voice (Parakeet STT / Kokoro TTS) | ❌ Disabled |
| `llm-agent` cards | ❌ Local-only; their first turn surfaces the health-gate error |
| `render_capture` vision | ❌ Degrades to a "vision unavailable — NOT visually verified" note (no hang; bounded by a 30s timeout) |
| Claude `.claude` cards | ⚠️ Need per-user Anthropic credentials — the fork's concern |

---

## 2. Frontend: drop the runtime Vite process (optional)

Vite is a **build-time** tool for the React host (`src/`). It is *not* involved
in card classes (those are plain files served by the backend and injected at
runtime) and gives end users nothing at runtime. In production you don't need
the Vite **dev server** — you need a built bundle.

Build the bundle with **`npx vite build`** (→ `dist/`). Use `vite build`
directly, *not* `npm run build` — the latter is `tsc -b && vite build` and main
currently has pre-existing frontend type errors that fail `tsc -b` and
short-circuit the bundle. `vite build` transpiles via esbuild without
type-checking, so it produces a working `dist/` regardless. (The release
[`Dockerfile`](../Dockerfile) runs `npm run build` best-effort, so a stock image
may NOT contain `dist/` until those type errors are fixed; a fork that wants the
backend to serve the SPA should add its own `RUN npx vite build` layer.)

The frontend is origin-agnostic and proxies `/api` + `/ws` to its own origin, so
the built SPA can be served from anywhere behind the reverse proxy.

Two ways for the fork to serve it without running Vite:

- **Backend single-process (enabler in main):** set `MICA_FRONTEND_DIST` to the
  built bundle and the Node backend serves the SPA itself — one process, no port
  5173:
  ```sh
  MICA_FRONTEND_DIST=/opt/mica/dist   # backend serves dist/ + SPA fallback
  ```
  Dormant when unset (Vite dev server serves the frontend as today). The static
  mount is registered after all `/api` + `/ws` routes and the SPA catch-all
  excludes them, so it can never shadow an API route.
- **Separate static server / nginx:** the fork serves `dist/` itself behind its
  reverse proxy. No main change needed at all.

`scripts/start.sh` always launches Vite; a cloud image simply doesn't call it
(run the backend directly with `MICA_FRONTEND_DIST` set).

---

## 3. Smaller image: build args

Both heavy GPU-only build steps are gated by build args (defaults `1`, so stock
builds are unchanged):

```sh
docker build --build-arg INSTALL_LLAMA=0 --build-arg INSTALL_VOICE=0 -t mica-cloud .
```

- `INSTALL_LLAMA=0` — skip the llama.cpp CUDA build.
- `INSTALL_VOICE=0` — skip the ~3-4 GB voice venv (`scripts/voice/install.sh`).

A fully separate thin/CPU base image is the fork's call; these args are the hooks
that make it cheap without a custom Dockerfile.

---

## 4. Stable seams the fork relies on (no main change needed)

The fork builds on these; main intends to keep them stable:

- **Per-user state** — `PROJECT_DIR` selects the workspace root
  ([server/files.ts](../server/files.ts) `WORKSPACE_DIR`). Give each user a
  volume mounted at `/project`; their projects + `.mica/` live there.
- **Per-user secrets** — provider keys resolve from per-project
  `.mica/config.json`, workspace `.mica/credentials.json`, then env
  (`readOpenRouterKey` / `readOpenAICompatConfig`). All live on the user's
  volume / container env — naturally isolated per container.
- **Origin-agnostic frontend** — adapts to whatever origin serves it and proxies
  `/api` + `/ws` to the same origin ([src/api/micaSocket.ts](../src/api/micaSocket.ts)),
  so a per-user reverse-proxy route works.
- **Per-request project scoping** — validated at the boundary
  (`getRequestProject`, `X-Mica-Project`); safe for one-user-per-container.
- **Graceful missing-credentials UX** — `probeModelEndpoint` health-gates the
  agent's first turn and surfaces an actionable inline prompt.

---

## 5. In-process multi-tenancy enablers (pool model)

The original contract assumed the fork isolates tenants with **one container per
user** (the container is the boundary). Main now ALSO ships dormant seams for an
**in-process / pool** model — one backend serving many tenants under
`WORKSPACE_DIR/<tenantId>/<project>` — which is the customary shape for a
self-serve/demo tier. Everything here is **inert unless a fork opts in**; a stock
single-tenant run never binds a tenant, so behavior is byte-identical.

**Tenant context + path seam.** `server/tenantContext.ts` carries an optional
tenant via `AsyncLocalStorage` (`runWithTenant` for callbacks, `enterTenant` for
event-handler entry points). `getEffectiveWorkspaceDir()` (server/files.ts)
returns `WORKSPACE_DIR/<tenantId>` when a tenant is bound, else bare
`WORKSPACE_DIR`. All workspace path/key builders route through it, so binding a
tenant scopes the whole backend with no per-callsite changes.

**Identity-key namespacing.** The in-memory `cardId`/session-UUID cache, the
file-watcher's project map, `broadcastToProject`, and WS subscriptions all carry
an optional tenant dimension (`wsTenants`). Empty tenant ⇒ keys are the bare
project, so single-tenant routing/sessions are unchanged; a fork's tenant
prevents two tenants' same-named projects from colliding or cross-broadcasting.

**Pluggable hooks** (`server/auth/hooks.ts`, all no-op until registered):
- `registerAuthVerifier(req → { tenantId })` — consulted by the `/api` auth
  middleware, which binds the tenant via `enterTenant`. Main fast-paths when none
  is registered.
- `registerKeyResolver({provider, project, tenant} → key?)` — consulted by
  `readOpenRouterKey` / `readOpenAICompatConfig` BEFORE the on-disk chain. The
  sponsor-token / per-tenant key injection point (the "free periods" feature).
- `registerUsageMeter(event)` — fired from `recordTurn` (the shared per-turn
  chokepoint) for token→$ accounting / budget enforcement.

**Credential read-guard (ALWAYS ON).** The file API + agent file tools refuse to
read/write `.mica/credentials.json` and `.mica/config.json`
(`isProtectedCredentialPath` in `validateFilename`). Internal key resolution uses
direct `fs` joins that bypass this, so it's unaffected. Hardens single-tenant BYO
keys too, and underpins the sponsored-token "use but not copy" guarantee.

**Encrypt-at-rest** (`server/auth/secrets.ts`). Set `MICA_SECRET_KEY` to store the
credential store AES-256-GCM-encrypted; unset (main) ⇒ plaintext as before.
Decryption is robust to plaintext, so toggling it on doesn't break existing files.

**Tier-1 / cloud env flags:**
```sh
MICA_TIER1_ONLY=1        # drop handlers that need server-side execution / host
                         # creds: voice, terminal, claude, process
MICA_DISABLE_SHELL_TOOLS=1  # drop the agent shell-exec tool (mica_shell)
MICA_SECRET_KEY=<secret> # encrypt the credential store at rest
```

**Frontend auth seam** (`src/api/authToken.ts`). `registerAuthTokenProvider(() →
jwt)` lets a fork attach a session token; `projFetch` sends it as a `Bearer`
header and the WS client includes it on `subscribe-project` / `channel_open`.
Null in main ⇒ nothing attached.

The fork still owns the IMPLEMENTATIONS (the Supabase verifier, the sponsor-token
resolver + campaign/budget store, the metering sink, tenant migration). Main ships
only the dormant seams above.

## Boundary — what stays in the fork

Main provides the enablers above and nothing more. The fork owns:

- Authentication / OAuth / identity / sessions.
- The per-user container spawner, lifecycle, idle-reaping.
- Routing / reverse-proxy config, subdomain-or-path per user.
- Per-user secret injection and per-user Claude credentials.
- The multi-tenant isolation IMPLEMENTATION. Main ships dormant in-process seams
  (§5) and still supports container-per-tenant; the fork picks a model and owns
  the impl — auth verifier, key/sponsor resolver, usage/budget sink, tenant
  derivation + migration. A container-per-tenant fork can ignore §5 entirely (the
  container stays the boundary); a pool fork wires §5's hooks.
- Thin/CPU image packaging beyond the `INSTALL_*` build args.
