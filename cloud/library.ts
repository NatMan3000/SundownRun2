// ============================================================
//  THE TRACK LIBRARY - every online player's tracks, in one place
// ------------------------------------------------------------
//  A Durable Object with its own SQLite database (the free plan's
//  kind: the `v2` migration in wrangler.jsonc creates it). The Worker
//  always asks for the one named "library", so every save goes through
//  one place, one at a time, and two players can never get the same
//  track id.
//
//  The rules are cloud/libraryStore.ts; this file only hands it the
//  database. The Worker checks the login and the track file BEFORE it
//  calls in here (cloud/worker.ts), so everything arriving is a real
//  player and a track the game can load.
// ============================================================

import { DurableObject } from 'cloudflare:workers'
import type { TrackFile } from '../src/track/schema'
import type { LibraryDeleteResult, LibraryGetResult, LibraryListResult, LibrarySaveResult } from '../src/editor/library/protocol'
import { LibraryStore } from './libraryStore'
import type { Env } from './room'

export class Library extends DurableObject<Env> {
  private readonly store: LibraryStore

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.store = new LibraryStore({
      // The store asks for typed rows; SQLite hands back plain ones of that shape.
      sql: { exec: (query, ...bindings) => ctx.storage.sql.exec(query, ...bindings) as unknown as { toArray(): never[] } },
      transaction: (fn) => ctx.storage.transactionSync(fn),
    })
  }

  list(owner: string): LibraryListResult {
    return { status: 'ok', ...this.store.list(owner) }
  }

  get(owner: string, id: string): LibraryGetResult {
    return this.store.get(owner, id)
  }

  create(owner: string, playerName: string, file: TrackFile): LibrarySaveResult {
    return this.store.create(owner, playerName, file)
  }

  update(owner: string, playerName: string, id: string, file: TrackFile, baseRev: number): LibrarySaveResult {
    return this.store.update(owner, playerName, id, file, baseRev)
  }

  remove(owner: string, id: string): LibraryDeleteResult {
    return this.store.remove(owner, id)
  }
}
