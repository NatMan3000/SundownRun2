import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { reportPlugin } from './server/issues'

// Port 5201 is reserved for Sundown Run II (see ~/Dev/.claude/rules/reserved-ports.md).
// strictPort: if 5201 is busy we fail loudly instead of silently moving to another port,
// because the multiplayer join links and the Windows launchers all point at 5201.
// reportPlugin: the "Report a problem" screen posts to /api/report on this same server
// (dev and preview), which files it on GitHub (server/issues.ts).
export default defineConfig({
  plugins: [react(), reportPlugin()],
  server: { port: 5201, strictPort: true },
  preview: { port: 5201, strictPort: true },
  build: { chunkSizeWarningLimit: 4000 },
})
