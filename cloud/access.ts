// ============================================================
//  WHO IS THIS? - the player's Cloudflare Access login
// ------------------------------------------------------------
//  Cloudflare Access sits in front of the whole site (cloud/README.md)
//  and adds a signed token to every request it lets through, in the
//  Cf-Access-Jwt-Assertion header. The track library trusts nothing
//  else: a bare header could be typed by anyone, a signed token can't.
//
//  The check (Cloudflare's own recipe, "Validate JWTs"):
//    - signed with RS256 by one of the team's current keys, fetched
//      from <team>/cdn-cgi/access/certs and matched by `kid` (Access
//      rotates them every 6 weeks; the old one stays valid 7 days);
//    - `aud` holds this app's AUD tag (the ACCESS_AUD Worker var);
//    - `iss` is the team domain (ACCESS_TEAM_DOMAIN);
//    - not expired, not from the future; it carries an email.
//
//  ACCESS_AUD unset: the library is off and says so, EXCEPT for local
//  testing, where SR2_DEV_PLAYER (only ever in cloud/.dev.vars, which
//  is git-ignored) names a pretend player. That pretend player is
//  ignored whenever ACCESS_AUD is set, and on any address that isn't
//  this computer (127.0.0.1 / localhost), so it can't ship as a way
//  round the login.
// ============================================================

export interface AccessEnv {
  /** The Access application's AUD tag (Zero Trust > Access > Applications > the app > Overview). Empty = library off. */
  ACCESS_AUD?: string
  /** https://<team>.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN?: string
  /** Local testing only (cloud/.dev.vars): the pretend player's email, used only while ACCESS_AUD is empty and only on 127.0.0.1 / localhost. */
  SR2_DEV_PLAYER?: string
}

export type Who = { ok: true; email: string; dev: boolean } | { ok: false; code: 'off' | 'no-login'; message: string }

export const LIBRARY_OFF = "The online track library isn't switched on yet. Ask Dad to finish setting it up (ACCESS_AUD in cloud/README.md). Your tracks are still saved in this browser."
const NO_LOGIN = "The game couldn't tell who you are. Reload the page and log in again."

/** Clock slack allowed between Cloudflare's clock and this Worker's (seconds). */
const LEEWAY_S = 60
/** How long fetched keys are trusted before fetching again (ms). An unknown kid refetches sooner. */
const KEYS_TTL_MS = 60 * 60 * 1000
/** At most one refetch for an unknown kid this often (ms), so junk tokens can't hammer the certs URL. */
const REFETCH_GAP_MS = 30 * 1000

interface Jwk {
  kid?: string
  kty?: string
  alg?: string
  n?: string
  e?: string
}

interface KeySet {
  team: string
  at: number
  keys: Map<string, CryptoKey>
}

let keyCache: KeySet | null = null
let lastFetch = 0

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
}

function teamOf(raw: string | undefined): string | null {
  if (!raw) return null
  try {
    const u = new URL(raw.trim())
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback(u.hostname))) return null
    return u.origin
  } catch {
    return null
  }
}

function b64urlBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function b64urlJson(s: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(b64urlBytes(s)))
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

async function loadKeys(team: string, fetchImpl: typeof fetch): Promise<Map<string, CryptoKey>> {
  lastFetch = Date.now()
  const res = await fetchImpl(`${team}/cdn-cgi/access/certs`, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`the Access certs answered ${res.status}`)
  const body = (await res.json()) as { keys?: Jwk[] }
  const keys = new Map<string, CryptoKey>()
  for (const k of body.keys ?? []) {
    if (!k.kid || k.kty !== 'RSA' || !k.n || !k.e) continue
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: k.n, e: k.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    keys.set(k.kid, key)
  }
  if (keys.size === 0) throw new Error('the Access certs had no RSA keys')
  keyCache = { team, at: Date.now(), keys }
  return keys
}

async function keyFor(team: string, kid: string, fetchImpl: typeof fetch): Promise<CryptoKey | null> {
  const fresh = keyCache && keyCache.team === team && Date.now() - keyCache.at < KEYS_TTL_MS
  if (fresh && keyCache?.keys.has(kid)) return keyCache.keys.get(kid) ?? null
  if (fresh && Date.now() - lastFetch < REFETCH_GAP_MS) return null
  const keys = await loadKeys(team, fetchImpl)
  return keys.get(kid) ?? null
}

/** Check an Access token. Returns the login email, or why not (for the log; players get one plain message). */
export async function verifyAccessJwt(token: string, aud: string, team: string, fetchImpl: typeof fetch = fetch, nowS = Date.now() / 1000): Promise<{ ok: true; email: string } | { ok: false; why: string }> {
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, why: 'not a JWT' }
  const header = b64urlJson(parts[0])
  const claims = b64urlJson(parts[1])
  if (!header || !claims) return { ok: false, why: 'unreadable JWT' }
  if (header.alg !== 'RS256') return { ok: false, why: `alg ${String(header.alg)}` }
  if (typeof header.kid !== 'string') return { ok: false, why: 'no kid' }
  let key: CryptoKey | null
  try {
    key = await keyFor(team, header.kid, fetchImpl)
  } catch (err) {
    return { ok: false, why: `could not fetch the Access keys: ${(err as Error).message}` }
  }
  if (!key) return { ok: false, why: `unknown kid ${header.kid}` }
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  let good = false
  try {
    good = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]), signed)
  } catch {
    good = false
  }
  if (!good) return { ok: false, why: 'bad signature' }
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!auds.includes(aud)) return { ok: false, why: 'wrong aud' }
  if (claims.iss !== team) return { ok: false, why: `wrong iss ${String(claims.iss)}` }
  if (typeof claims.exp !== 'number' || claims.exp < nowS - LEEWAY_S) return { ok: false, why: 'expired' }
  if (typeof claims.nbf === 'number' && claims.nbf > nowS + LEEWAY_S) return { ok: false, why: 'not valid yet' }
  if (typeof claims.email !== 'string' || !claims.email.includes('@')) return { ok: false, why: 'no email (a service token?)' }
  return { ok: true, email: claims.email.trim().toLowerCase() }
}

/** Who sent this request: the Access login, the local pretend player, or why nobody. */
export async function whoIs(request: Request, env: AccessEnv, fetchImpl: typeof fetch = fetch): Promise<Who> {
  const aud = (env.ACCESS_AUD ?? '').trim()
  if (!aud) {
    const dev = (env.SR2_DEV_PLAYER ?? '').trim().toLowerCase()
    if (dev.includes('@') && isLoopback(new URL(request.url).hostname)) return { ok: true, email: dev, dev: true }
    return { ok: false, code: 'off', message: LIBRARY_OFF }
  }
  const team = teamOf(env.ACCESS_TEAM_DOMAIN)
  if (!team) {
    console.error('[library] ACCESS_TEAM_DOMAIN is missing or not an https address: nobody can be checked')
    return { ok: false, code: 'off', message: LIBRARY_OFF }
  }
  const token = request.headers.get('cf-access-jwt-assertion')
  if (!token) return { ok: false, code: 'no-login', message: NO_LOGIN }
  const checked = await verifyAccessJwt(token, aud, team, fetchImpl)
  if (!checked.ok) {
    console.warn(`[library] refused an Access token: ${checked.why}`)
    return { ok: false, code: 'no-login', message: NO_LOGIN }
  }
  return { ok: true, email: checked.email, dev: false }
}

/** The owner key stored for a login: a hash of the email, so the library holds no addresses. */
export async function ownerKey(email: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`sr2-library:${email.trim().toLowerCase()}`))
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Test only: forget the fetched keys. */
export function forgetAccessKeys(): void {
  keyCache = null
  lastFetch = 0
}
