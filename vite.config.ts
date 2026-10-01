import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Port 5201 is reserved for Sundown Run Two (see ~/Dev/.claude/rules/reserved-ports.md).
// strictPort: if 5201 is busy we fail loudly instead of silently moving to another port,
// because the multiplayer join links and the Windows launchers all point at 5201.
export default defineConfig({
  plugins: [react()],
  server: { port: 5201, strictPort: true },
  preview: { port: 5201, strictPort: true },
  build: { chunkSizeWarningLimit: 4000 },
})
