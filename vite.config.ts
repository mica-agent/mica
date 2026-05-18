import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import dotenv from 'dotenv'

// Load .env so MICA_FRONTEND_PORT / MICA_PORT can be set in one place for
// both the backend (server/index.ts) and this Vite dev server. Mirror the
// resolution order used by the backend: workspace .env first, then repo .env.
const workspaceEnv = join(process.env.PROJECT_DIR || '/project', '.env')
if (existsSync(workspaceEnv)) dotenv.config({ path: workspaceEnv })
dotenv.config()

const FRONTEND_PORT = parseInt(process.env.MICA_FRONTEND_PORT || '5173', 10)
const BACKEND_PORT = parseInt(process.env.MICA_PORT || '3002', 10)

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: FRONTEND_PORT,
    allowedHosts: true,
    // Stop chokidar from watching the voice-benchmark venv (thousands of
    // Python files trip the inotify limit) and other generated/cached
    // trees. Without these, `npm run dev` crashes with ENOSPC: "System
    // limit for number of file watchers reached" the moment the venv
    // grows past ~8K files. The patterns are matched against the absolute
    // file path; we use a permissive form that catches both the repo-root
    // copy and any nested install. Vite already ignores node_modules + .git.
    watch: {
      ignored: [
        '**/.venv/**',
        '**/__pycache__/**',
        '**/.cache/**',
        '**/.mica-pids/**',
      ],
    },
    proxy: {
      '/api': {
        target: `http://localhost:${BACKEND_PORT}`,
        changeOrigin: true,
        timeout: 120000,
        // Catch upstream errors (parse errors, dropped connections,
        // backend crashes mid-response) so an unhandled `error` event
        // on the proxy/response doesn't escalate to an uncaughtException
        // and kill the entire dev server. Without this, ANY malformed
        // response from /api crashes vite. See incident 2026-05-01:
        // backend's GET /api/files/:filename had a Content-Length /
        // stream-bytes race that produced "Data after `Connection: close`",
        // which crashed vite.
        configure: (proxy) => {
          proxy.on('error', (err, _req, res) => {
            console.error('[vite proxy] /api error:', err.message)
            if (res && !res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'proxy_error', message: err.message }))
            } else if (res && !res.writableEnded) {
              res.end()
            }
          })
        },
      },
      '/ws': {
        target: `ws://localhost:${BACKEND_PORT}`,
        ws: true,
      },
    },
  },
})
