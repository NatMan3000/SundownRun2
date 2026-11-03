// The online track library's rules (cloud/libraryStore.ts) on a real SQLite
// database, and the Access token check (cloud/access.ts) against a test key.
// bun test cloud/library.test.ts

import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TrackFile } from '../src/track/schema'
import { BUILTIN_TRACK_IDS, LIBRARY_LIMITS } from '../src/editor/library/protocol'
import { LibraryStore } from './libraryStore'
import { forgetAccessKeys, verifyAccessJwt } from './access'

const TRACKS = join(import.meta.dir, '..', 'tracks')
const base = JSON.parse(readFileSync(join(TRACKS, 'neon-pocket.json'), 'utf8')) as TrackFile

function store(suffixes = ['aaaa', 'bbbb', 'cccc', 'dddd']) {
  const db = new Database(':memory:')
  let n = 0
  return new LibraryStore({
        // Eager, like the Durable Object's sql.exec: the statement runs whether or not rows are read.
    sql: {
      exec: (q, ...b) => {
        const rows = db.prepare(q).all(...(b as never[])) as never[]
        return { toArray: () => rows }
      },
    },
    transaction: (fn) => db.transaction(fn)(),
    now: () => 1000 + n,
    randomSuffix: () => suffixes[n++ % suffixes.length],
  })
}

const track = (id: string, name = id): TrackFile => ({ ...base, id, name })

test('the reserved ids are exactly the built-in tracks in tracks/', () => {
  const ids = readdirSync(TRACKS)
    .filter((f) => f.endsWith('.json'))
    .map((f) => (JSON.parse(readFileSync(join(TRACKS, f), 'utf8')) as TrackFile).id)
    .sort()
  expect([...BUILTIN_TRACK_IDS].sort()).toEqual(ids)
})

test('ids are unique across players, and only the owner can change or delete', () => {
  const s = store()
  const a = s.create('alice', 'Ali', track('canyon-run'))
  expect(a).toMatchObject({ status: 'ok', id: 'canyon-run', rev: 1, movedFrom: null })
  // Bob draws a track with the same id: he gets his own id, never Alice's.
  const b = s.create('bob', 'Bob', track('canyon-run'))
  expect(b).toMatchObject({ status: 'ok', id: 'canyon-run-aaaa', movedFrom: 'canyon-run' })
  // A built-in id is never handed out.
  expect(s.create('bob', 'Bob', track('afterglow'))).toMatchObject({ status: 'ok', id: 'afterglow-bbbb' })
  expect(s.update('bob', 'Bob', 'canyon-run', track('canyon-run', 'Mine now'), 1)).toMatchObject({ status: 'refused', code: 'not-yours' })
  expect(s.remove('bob', 'canyon-run')).toMatchObject({ status: 'refused', code: 'not-yours' })
  // Alice can, and a stale version is refused rather than overwriting.
  expect(s.update('alice', 'Ali', 'canyon-run', track('canyon-run', 'Canyon Run 2'), 1)).toMatchObject({ status: 'ok', rev: 2 })
  expect(s.update('alice', 'Ali', 'canyon-run', track('canyon-run', 'Old'), 1)).toMatchObject({ status: 'refused', code: 'changed', rev: 2 })
  const list = s.list('bob')
  expect(list.tracks.map((t) => [t.id, t.ownerName, t.mine])).toContainEqual(['canyon-run', 'ALI', false])
  expect(list.me.name).toBe('BOB')
  // The file comes back byte for byte, with the id the library gave it.
  const got = s.get('alice', 'canyon-run-aaaa')
  expect(got.status === 'ok' && JSON.parse(got.track.file).id).toBe('canyon-run-aaaa')
  expect(got.status === 'ok' && got.track.file).toBe(JSON.stringify(track('canyon-run-aaaa', 'canyon-run')))
  expect(s.remove('alice', 'canyon-run')).toEqual({ status: 'ok', id: 'canyon-run' })
  expect(s.get('alice', 'canyon-run')).toMatchObject({ status: 'refused', code: 'not-found' })
})

test('caps: tracks per player, bytes per track', () => {
  const s = store(Array.from({ length: 200 }, (_, i) => `x${String(i).padStart(3, '0')}`))
  for (let i = 0; i < LIBRARY_LIMITS.tracksPerPlayer; i++) expect(s.create('carl', 'C', track(`t-${i}`)).status).toBe('ok')
  expect(s.create('carl', 'C', track('one-more'))).toMatchObject({ status: 'refused', code: 'too-many' })
  const big = { ...track('huge'), description: 'x'.repeat(LIBRARY_LIMITS.trackBytes) }
  expect(s.create('dana', 'D', big)).toMatchObject({ status: 'refused', code: 'too-big' })
  // All of one player's tracks together: 4 MB.
  const chunky = (i: number) => ({ ...track(`e-${i}`), description: 'y'.repeat(126 * 1024) })
  let saved = 0
  while (s.create('erin', 'E', chunky(saved)).status === 'ok') saved++
  expect(saved).toBe(32)
  expect(s.create('erin', 'E', chunky(99))).toMatchObject({ status: 'refused', code: 'full' })
})

// ---------------------------------------------------------------- Access tokens

const TEAM = 'https://test-team.cloudflareaccess.com'
const AUD = 'test-aud-tag'

function b64url(bytes: ArrayBuffer | Uint8Array | string): string {
  const b = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes)
  return Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function keyPair() {
  const pair = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
  return { pair, jwk: { ...jwk, kid: 'k1' } }
}

async function sign(pair: CryptoKeyPair, claims: Record<string, unknown>, kid = 'k1'): Promise<string> {
  const head = b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }))
  const body = b64url(JSON.stringify(claims))
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${head}.${body}`))
  return `${head}.${body}.${b64url(sig)}`
}

test('Access tokens: only a token signed by the team key, for this app, from this team, in date, counts', async () => {
  forgetAccessKeys()
  const { pair, jwk } = await keyPair()
  const other = await keyPair()
  const certs = (async () => new Response(JSON.stringify({ keys: [jwk] }))) as unknown as typeof fetch
  const now = Math.floor(Date.now() / 1000)
  const good = { aud: [AUD], iss: TEAM, email: 'Josh@Example.com', exp: now + 600, iat: now }
  expect(await verifyAccessJwt(await sign(pair, good), AUD, TEAM, certs)).toEqual({ ok: true, email: 'josh@example.com' })
  expect(await verifyAccessJwt(await sign(other.pair, good), AUD, TEAM, certs)).toMatchObject({ ok: false, why: 'bad signature' })
  expect(await verifyAccessJwt(await sign(pair, { ...good, aud: ['another-app'] }), AUD, TEAM, certs)).toMatchObject({ ok: false, why: 'wrong aud' })
  expect(await verifyAccessJwt(await sign(pair, { ...good, iss: 'https://evil.cloudflareaccess.com' }), AUD, TEAM, certs)).toMatchObject({ ok: false })
  expect(await verifyAccessJwt(await sign(pair, { ...good, exp: now - 3600 }), AUD, TEAM, certs)).toMatchObject({ ok: false, why: 'expired' })
  expect(await verifyAccessJwt(await sign(pair, { ...good, email: undefined, common_name: 'svc' }), AUD, TEAM, certs)).toMatchObject({ ok: false })
  // A token that only claims "none" or a forged body with the real header fails too.
  const real = await sign(pair, good)
  const [h, , s] = real.split('.')
  const forged = `${h}.${b64url(JSON.stringify({ ...good, email: 'dad@example.com' }))}.${s}`
  expect(await verifyAccessJwt(forged, AUD, TEAM, certs)).toMatchObject({ ok: false, why: 'bad signature' })
  const none = `${b64url(JSON.stringify({ alg: 'none', kid: 'k1' }))}.${b64url(JSON.stringify(good))}.`
  expect(await verifyAccessJwt(none, AUD, TEAM, certs)).toMatchObject({ ok: false })
})
