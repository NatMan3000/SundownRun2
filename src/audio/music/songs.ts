// ============================================================
//  SONGS - names, favourites, and which song plays next
// ------------------------------------------------------------
//  A song is a MOOD plus a SEED. The seed picks the key, the
//  chords, the patterns and the hook (music/index.ts), so the
//  same seed in the same mood always plays the same song.
//
//  This file:
//   - names a song from its seed: two or three synthwave words,
//     plus its key ("Midnight Overdrive", "A minor"). The name
//     comes from its own random numbers, so naming a song never
//     changes a single note of it;
//   - keeps the favourites (saved songs) and the "All songs /
//     Favourites" choice in this browser's localStorage, so they
//     survive a reload;
//   - picks the next song: a fresh seed in the track's mood, or
//     the next favourite on the list;
//   - plays one favourite straight from the list, or takes one out
//     (and can put the last one taken out back where it was).
//
//  The pause menu and the HUD reach it through the audio API in
//  src/core/api.ts (song, nextSong, toggleFavourite, songList,
//  favourites, playFavourite, removeFavourite, undoRemoveFavourite).
// ============================================================

import type { FavouriteSong, SongInfo, SongList } from '../../core/api'
import { mulberry32 } from '../synth'
import { keyName } from '../theory'
import { MOODS, rollKey } from './score'
import type { MoodId } from './score'

/** One song, exactly: replaying these three numbers replays the same music. */
export interface Song {
  seed: number
  mood: MoodId
  bpm: number
}

// ---------------------------------------------------------------- names

/** First words: colours, times, materials. Every one works with every second word. */
const FIRST = [
  'Midnight', 'Neon', 'Chrome', 'Electric', 'Velvet', 'Crimson', 'Sunset', 'Starlight',
  'Ultraviolet', 'Magenta', 'Cyber', 'Golden', 'Silver', 'Laser', 'Turbo', 'Lunar',
  'Solar', 'Infinite', 'Phantom', 'Crystal', 'Arcade', 'Digital', 'Hyper', 'Retro',
  'Cobalt', 'Violet', 'Mirror', 'Polar', 'Twilight', 'Satellite', 'Afterburn', 'Static',
] as const

/** Second words: places, feelings, machines. */
const SECOND = [
  'Overdrive', 'Highway', 'Horizon', 'Runner', 'Dreams', 'Skyline', 'Pulse', 'Memories',
  'Drive', 'Heart', 'Boulevard', 'Nights', 'City', 'Rider', 'Signal', 'Paradise',
  'Mirage', 'Echo', 'Voyage', 'Odyssey', 'Lights', 'Machine', 'Motion', 'Fever',
  'Getaway', 'Velocity', 'Circuit', 'Coast', 'Frontier', 'Avenue', 'Express', 'Daydream',
] as const

/** Words that can go in front for a three-word name ("Endless Neon Highway"). */
const PREFIX = ['Last', 'Lost', 'Endless', 'Eternal', 'Distant', 'Secret', 'Final', 'Wild'] as const

function pick<T>(list: readonly T[], r: () => number): T {
  return list[Math.floor(r() * list.length)]
}

/**
 * A song's name from its seed: two words most of the time, sometimes a
 * third in front, sometimes a year from the 1980s on the end. Its own
 * random stream (the seed mixed with a constant), so the music's notes
 * are untouched by it.
 */
export function songName(seed: number): string {
  const r = mulberry32((seed ^ 0x6e616d65) >>> 0) // 'name'
  const a = pick(FIRST, r)
  const b = pick(SECOND, r)
  const shape = r()
  if (shape < 0.62) return `${a} ${b}`
  if (shape < 0.82) return `${pick(PREFIX, r)} ${a} ${b}`
  if (shape < 0.93) return `${a} ${b} ${1981 + Math.floor(r() * 9)}`
  return `The ${a} ${b}`
}

/** A song's key in words ("A minor"), worked out from its seed without building any sound. */
export function songKey(song: Song): string {
  const k = rollKey(MOODS[song.mood], mulberry32(song.seed >>> 0))
  return keyName(k.root, k.scale)
}

/** Each mood's name for people, as the favourites list shows it. */
const MOOD_NAMES: Record<MoodId, string> = { cruise: 'Cruise', drive: 'Drive', race: 'Race', hyper: 'Hyper' }

// ---------------------------------------------------------------- saved choices

const STORAGE_KEY = 'sr2.music.v1'
/** Plenty for anyone; stops the list growing forever. */
const MAX_FAVOURITES = 60

interface Saved {
  list: SongList
  favourites: Song[]
}

function isMood(v: unknown): v is MoodId {
  return typeof v === 'string' && v in MOODS
}

/** Read the saved choices; anything broken or missing falls back to "All songs, no favourites". */
function load(): Saved {
  const empty: Saved = { list: 'all', favourites: [] }
  try {
    if (typeof localStorage === 'undefined') return empty
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return empty
    const v = JSON.parse(raw) as { list?: unknown; favourites?: unknown }
    const favourites: Song[] = []
    if (Array.isArray(v.favourites)) {
      for (const f of v.favourites as { seed?: unknown; mood?: unknown; bpm?: unknown }[]) {
        if (!f || typeof f.seed !== 'number' || !Number.isFinite(f.seed) || !isMood(f.mood)) continue
        const bpm = typeof f.bpm === 'number' && f.bpm >= 60 && f.bpm <= 180 ? f.bpm : MOODS[f.mood].bpm
        favourites.push({ seed: f.seed >>> 0, mood: f.mood, bpm })
      }
    }
    return { list: v.list === 'favourites' ? 'favourites' : 'all', favourites: favourites.slice(0, MAX_FAVOURITES) }
  } catch {
    return empty
  }
}

function sameSong(a: Song, b: Song): boolean {
  return a.seed === b.seed && a.mood === b.mood && a.bpm === b.bpm
}

// ---------------------------------------------------------------- the song book

/**
 * Remembers the song playing now, the favourites and the list choice, and
 * picks what plays next. One lives in the audio rig (system.ts).
 */
export class SongBook {
  private saved: Saved = load()
  private current: Song | null = null
  /** Goes up every time a song is picked (SongInfo.id). */
  private picks = 0
  /** Where we are in the favourites while playing them in order. */
  private favCursor = -1
  /** The last favourite taken out by removeFavourite, and where it was, so it can go back. */
  private removed: { song: Song; index: number } | null = null
  /** True if saving to localStorage failed (private browsing): favourites last until reload. */
  storageBroken = false

  /** The song playing now (or about to, from the next bar), or null before the first pick. */
  get song(): Song | null {
    return this.current
  }

  /**
   * Pick the next song. In "Favourites" (with at least one saved) that is
   * the next favourite in the list; otherwise a fresh seed in `mood`.
   * bpm is the track's tempo override (undefined = the mood's own).
   * fresh = true always takes the fresh seed (the dev mood switch).
   */
  pick(mood: MoodId, bpm: number | undefined, freshSeed: number, fresh = false): Song {
    const favs = this.saved.favourites
    let song: Song
    if (!fresh && this.playingFavourites) {
      this.favCursor = (this.favCursor + 1) % favs.length
      song = { ...favs[this.favCursor] }
    } else {
      const m = MOODS[mood] ?? MOODS.drive
      song = { seed: freshSeed >>> 0, mood: m.id, bpm: bpm && bpm >= 60 && bpm <= 180 ? bpm : m.bpm }
    }
    this.current = song
    this.picks++
    return song
  }

  /** True if the song is saved as a favourite. */
  isFavourite(song: Song | null): boolean {
    if (!song) return false
    return this.saved.favourites.some((f) => sameSong(f, song))
  }

  /** Save the current song, or take it out if it is already saved. Returns true if it is saved now. */
  toggleFavourite(): boolean {
    const song = this.current
    if (!song) return false
    const favs = this.saved.favourites
    const i = favs.findIndex((f) => sameSong(f, song))
    if (i >= 0) {
      favs.splice(i, 1)
      // keep the cursor on the same next song after removing one before it
      if (i <= this.favCursor) this.favCursor--
    } else {
      favs.push({ ...song })
      if (favs.length > MAX_FAVOURITES) favs.shift()
    }
    this.save()
    return i < 0
  }

  /**
   * Play favourite number `index` (0 = the first saved) next. The caller
   * starts it at the next bar. In "Favourites", the songs after it follow
   * on from there. Returns the song, or null if there is no such favourite.
   */
  pickFavourite(index: number): Song | null {
    const fav = this.saved.favourites[index]
    if (!fav) return null
    this.favCursor = index
    this.current = { ...fav }
    this.picks++
    return this.current
  }

  /**
   * Take favourite number `index` out of the list. Only the last one taken
   * out can be put back (undoRemove). Returns the song, or null if there is
   * no such favourite. The song playing carries on either way.
   */
  removeFavourite(index: number): Song | null {
    const favs = this.saved.favourites
    if (!Number.isInteger(index) || index < 0 || index >= favs.length) return null
    const [song] = favs.splice(index, 1)
    // keep the cursor on the same next song after removing one before it
    if (index <= this.favCursor) this.favCursor--
    this.removed = { song, index }
    this.save()
    return song
  }

  /**
   * Put the last song taken out back in the same place. False if nothing
   * was taken out, it is already back (saved again meanwhile), or the list
   * is full.
   */
  undoRemove(): boolean {
    const r = this.removed
    if (!r) return false
    this.removed = null
    const favs = this.saved.favourites
    if (favs.some((f) => sameSong(f, r.song)) || favs.length >= MAX_FAVOURITES) return false
    const at = Math.min(r.index, favs.length)
    favs.splice(at, 0, r.song)
    if (at <= this.favCursor) this.favCursor++
    this.save()
    return true
  }

  /** A saved song as the favourites list shows it. */
  describe(song: Song): FavouriteSong {
    const cur = this.current
    return {
      seed: song.seed,
      mood: song.mood,
      moodName: MOOD_NAMES[song.mood],
      bpm: song.bpm,
      name: songName(song.seed),
      key: songKey(song),
      playing: !!cur && sameSong(cur, song),
    }
  }

  /** Every favourite as the list shows it, oldest first. */
  describeFavourites(): FavouriteSong[] {
    return this.saved.favourites.map((f) => this.describe(f))
  }

  get list(): SongList {
    return this.saved.list
  }

  /** True when songs come from the favourites (the choice is Favourites and at least one is saved). */
  get playingFavourites(): boolean {
    return this.saved.list === 'favourites' && this.saved.favourites.length > 0
  }

  get favourites(): readonly Song[] {
    return this.saved.favourites
  }

  setList(list: SongList): void {
    if (list !== 'all' && list !== 'favourites') return
    if (list === this.saved.list) return
    this.saved.list = list
    // Start the favourites from the song playing now if it is one, else from the top.
    const cur = this.current
    this.favCursor = cur ? this.saved.favourites.findIndex((f) => sameSong(f, cur)) : -1
    this.save()
  }

  /** The song as the pause menu and the HUD see it. */
  info(): SongInfo | null {
    const song = this.current
    if (!song) return null
    return { id: this.picks, seed: song.seed, name: songName(song.seed), key: songKey(song), favourite: this.isFavourite(song) }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.saved))
      this.storageBroken = false
    } catch (err) {
      // Private browsing or a full disk: favourites still work until the page reloads.
      if (!this.storageBroken) console.warn('[audio] could not save favourite songs:', err)
      this.storageBroken = true
    }
  }
}
