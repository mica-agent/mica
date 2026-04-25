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
    proxy: {
      '/api': {
        target: `http://localhost:${BACKEND_PORT}`,
        changeOrigin: true,
        timeout: 120000,
      },
      '/ws': {
        target: `ws://localhost:${BACKEND_PORT}`,
        ws: true,
      },
    },
  },
})
