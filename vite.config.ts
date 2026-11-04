import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { reportPlugin } from './server/issues'

// iOS's Add to Home Screen loads the touch icon through its own loader, which can't reach a
// file behind the Cloudflare Access login and shows a letter tile instead. Written into the
// page itself as a data: URI there is nothing to fetch. (public/icons, made by bun run icons)
function inlineTouchIcon(): Plugin {
  return {
    name: 'sr2-inline-touch-icon',
    transformIndexHtml(html) {
      const png = readFileSync(new URL('./public/icons/apple-touch-icon.png', import.meta.url)).toString('base64')
      return html.replace('<!--TOUCH-ICON-->', `<link rel="apple-touch-icon" sizes="180x180" href="data:image/png;base64,${png}" />`)
    },
  }
}

// Port 5201 is reserved for Sundown Run II (see ~/Dev/.claude/rules/reserved-ports.md).
// strictPort: if 5201 is busy we fail loudly instead of silently moving to another port,
// because the multiplayer join links and the Windows launchers all point at 5201.
// reportPlugin: the "Report a problem" screen posts to /api/report on this same server
// (dev and preview), which files it on GitHub (server/issues.ts). The road editor's
// Share and Shared tracks use /api/tracks on the same plugin (server/trackShare.ts).
export default defineConfig({
  plugins: [react(), reportPlugin(), inlineTouchIcon()],
  server: { port: 5201, strictPort: true },
  preview: { port: 5201, strictPort: true },
  build: { chunkSizeWarningLimit: 4000 },
})
