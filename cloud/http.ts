// ============================================================
//  HTTP BITS the Worker's answers share (cloud/worker.ts, cloud/libraryApi.ts)
// ============================================================

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } })
}

/** Only the game's own page may call (Access already gates who can reach the Worker). */
export function callerProblem(request: Request): string | null {
  const origin = request.headers.get('origin')
  if (origin) {
    try {
      if (new URL(origin).host !== new URL(request.url).host) return `page from ${origin}`
    } catch {
      return 'unreadable origin'
    }
  }
  const site = request.headers.get('sec-fetch-site')
  if (site && site !== 'same-origin' && site !== 'none') return `${site} request`
  return null
}

/** Read the body as text, or null if it is bigger than `max` bytes. */
export async function readBody(request: Request, max: number): Promise<string | null> {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) return null
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const all = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    all.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder().decode(all)
}
