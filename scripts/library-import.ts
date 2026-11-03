// ============================================================
//  ONE-TIME IMPORT: the GitHub shared tracks into the online library
// ------------------------------------------------------------
//  Before the online library, tracks were shared as GitHub issues
//  labelled "track" (the Library's Share). This copies each one into
//  the online library, under the player who made it, through the
//  admin door (POST /api/library/admin/import), which only answers a
//  login listed in the LIBRARY_ADMINS Worker secret.
//
//  It reads the shared tracks through the game's own /api/tracks (the
//  same list and the same fingerprint check the Library uses), so a
//  track changed on GitHub after it was shared is skipped, never
//  imported. A track whose id is already in the library is skipped
//  too, so running it twice imports nothing twice.
//
//  bun scripts/library-import.ts --map "JJ=josh@example.com,DAD=nathan@example.com" \
//      --token "$(cloudflared access token -app=https://sundown.nathans-lab.fyi)" [--dry-run]
//
//    --site URL           the online game (default https://sundown.nathans-lab.fyi)
//    --token T            your Cloudflare Access token for the site (cloudflared access login
//                         <site> once, then cloudflared access token -app=<site>)
//    --map "A=a@x,B=b@y"  Made by name -> that player's login email (case doesn't matter)
//    --default-owner E    owner for a Made by name not in --map (else it is skipped)
//    --from-file F        read the shared list from a saved /api/tracks answer instead
//    --dry-run            say what would happen, change nothing
//    --jwt / --insecure   local testing only: send the token as Cf-Access-Jwt-Assertion
//                         (wrangler dev has no Access in front) and accept its certificate
// ============================================================

import { readFileSync } from 'node:fs'
import { type SharedListResult, cleanMadeBy, verifySharedTrack } from '../src/editor/share/protocol'
import type { LibraryListResult, LibrarySaveResult } from '../src/editor/library/protocol'
import { validateTrack } from '../src/track/validate'
import type { TrackFile } from '../src/track/schema'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

const SITE = (arg('site') ?? 'https://sundown.nathans-lab.fyi').replace(/\/+$/, '')
const TOKEN = arg('token')?.trim()
const DRY = flag('dry-run')
if (flag('insecure')) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
if (!TOKEN) {
  console.error('Need --token (cloudflared access token -app=<site>). See the top of this file.')
  process.exit(2)
}
const authHeader: Record<string, string> = flag('jwt') ? { 'Cf-Access-Jwt-Assertion': TOKEN } : { 'cf-access-token': TOKEN }

const owners = new Map<string, string>()
for (const pair of (arg('map') ?? '').split(',')) {
  const [name, email] = pair.split('=').map((s) => s?.trim())
  if (name && email?.includes('@')) owners.set(name.toUpperCase(), email.toLowerCase())
}
const fallbackOwner = arg('default-owner')?.trim().toLowerCase()

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${SITE}${path}`, { headers: authHeader, redirect: 'manual' })
  if (res.status >= 300 && res.status < 400) throw new Error(`${path}: redirected to a login page; the token is missing or expired`)
  const body = (await res.json()) as T
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(body)}`)
  return body
}

const list: SharedListResult = arg('from-file') ? JSON.parse(readFileSync(arg('from-file') as string, 'utf8')) : await getJson<SharedListResult>('/api/tracks?fresh=1')
if (list.status !== 'ok') {
  console.error(`The shared tracks list isn't available: ${list.message}`)
  process.exit(1)
}
const library = await getJson<LibraryListResult>('/api/library')
if (library.status !== 'ok') {
  console.error(`The online library said no: ${library.message}`)
  process.exit(1)
}
const have = new Set(library.tracks.map((t) => t.id))

let imported = 0
let skipped = 0
let failed = 0
for (const item of list.items) {
  const label = `#${item.number} "${item.title}"`
  const whole = verifySharedTrack(item)
  if (!whole.ok) {
    console.log(`skip  ${label}: ${whole.why}`)
    skipped++
    continue
  }
  const file = JSON.parse(whole.canonical) as TrackFile
  if (!validateTrack(file).ok) {
    console.log(`skip  ${label}: not a track the game can load`)
    skipped++
    continue
  }
  if (have.has(file.id)) {
    console.log(`skip  ${label}: a track with id ${file.id} is already in the library`)
    skipped++
    continue
  }
  const madeBy = cleanMadeBy(file.author ?? '')
  const owner = owners.get(madeBy.toUpperCase()) ?? fallbackOwner
  if (!owner) {
    console.log(`skip  ${label}: made by "${madeBy || '(nobody)'}", who isn't in --map (add them, or pass --default-owner)`)
    skipped++
    continue
  }
  if (DRY) {
    console.log(`would import  ${label} as ${file.id}, by ${madeBy || '(no name)'}`)
    imported++
    continue
  }
  const res = await fetch(`${SITE}/api/library/admin/import`, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ owner, ownerName: madeBy || 'RACER', file }),
    redirect: 'manual',
  })
  const body = (await res.json().catch(() => null)) as LibrarySaveResult | null
  if (body?.status === 'ok') {
    console.log(`import  ${label} -> ${body.id}${body.movedFrom ? ` (its id ${body.movedFrom} was taken)` : ''}, by ${madeBy || 'RACER'}`)
    have.add(body.id)
    imported++
  } else {
    console.log(`FAIL  ${label}: ${res.status} ${body && body.status === 'refused' ? body.message : 'no answer'}`)
    failed++
  }
}
console.log(`\n${DRY ? 'would import' : 'imported'} ${imported}, skipped ${skipped}, failed ${failed}`)
process.exit(failed ? 1 : 0)
