// ============================================================
//  FAVOURITE SONGS - the list of songs you saved
// ------------------------------------------------------------
//  Opened from the pause menu's music rows (SongRows.tsx, the
//  "Favourite songs" button). It takes the pause menu's place in
//  the same spot, and Back (B / Esc) goes back to the menu.
//
//  Each saved song gets a row: its number in the list (the order
//  Favourites plays them in), its name, its mood, key and speed,
//  and two buttons:
//    Play     that song now, starting on the next bar, like
//             Next song does. The song playing now is marked.
//    Remove   take it out of your favourites. The row stays
//             where it was with a "Put it back" button, so a
//             wrong press is one press to fix. (A song is only
//             its seed: once it's gone for good you'd never find
//             it again, so undo beats an "are you sure?" that
//             gets pressed twice without reading.)
//
//  Everything goes through the audio API (src/core/api.ts:
//  favourites, playFavourite, removeFavourite, undoRemoveFavourite);
//  the list itself lives in src/audio/music/songs.ts. It re-reads
//  the list four times a second, so the "playing" mark moves when
//  the music moves on to the next song.
// ============================================================

import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { audio } from '../core/api'
import type { FavouriteSong } from '../core/api'
import { focusItem, useNavScreen } from './nav'
import { HelpLine, MenuButton } from './widgets'
import './favouriteSongs.css'

const POLL_MS = 250

/** One string that changes whenever anything the list shows changes. */
function signature(songs: readonly FavouriteSong[], musicOn: boolean): string {
  let s = musicOn ? 'on' : 'off'
  for (const f of songs) s += `|${f.seed}:${f.mood}:${f.bpm}:${f.playing ? 1 : 0}`
  return s
}

interface ListState {
  songs: FavouriteSong[]
  /** Music is playing, so Play can work. */
  musicOn: boolean
  /** All songs or only the favourites. */
  list: 'all' | 'favourites'
  sig: string
}

function readList(): ListState {
  const songs = audio.favourites()
  const musicOn = audio.song() !== null
  const list = audio.songList().list
  return { songs, musicOn, list, sig: signature(songs, musicOn) + list }
}

/** The favourites, re-read four times a second; re-renders only when something changed. */
function useFavourites() {
  const [state, setState] = useState(readList)
  useEffect(() => {
    const t = setInterval(() => {
      const next = readList()
      setState((prev) => (prev.sig === next.sig ? prev : next))
    }, POLL_MS)
    return () => clearInterval(t)
  }, [])
  return { ...state, refresh: () => setState(readList()) }
}

/** A nav item id that follows the song, not its place in the list (places shift when one is removed). */
function itemId(song: FavouriteSong, what: 'play' | 'remove'): string {
  return `fav:${song.seed}:${song.mood}:${song.bpm}:${what}`
}

/** A small eighth note, drawn (no icon font): marks the song playing now. */
function NoteIcon() {
  return (
    <svg className="fav-row__note" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 2.2v8.1a2.6 2.6 0 1 0 1.6 2.4V5.6l5.2-1.4V2z" />
    </svg>
  )
}

/** "Race · A minor · 124 bpm": what tells two songs apart besides the name. */
function details(song: FavouriteSong): string {
  return `${song.moodName} · ${song.key} · ${song.bpm} bpm`
}

function SongRow(props: { song: FavouriteSong; number: number; musicOn: boolean; onPlay: () => void; onRemove: () => void }) {
  const { song } = props
  return (
    <li className={`fav-row${song.playing ? ' is-playing' : ''}`}>
      <span className="fav-row__mark" aria-hidden="true">
        {song.playing ? <NoteIcon /> : props.number}
      </span>
      <span className="fav-row__info">
        <span className="fav-row__name">{song.name}</span>
        <span className="fav-row__meta">
          {song.playing && <span className="fav-row__now">Playing now</span>}
          {details(song)}
        </span>
      </span>
      <MenuButton
        id={itemId(song, 'play')}
        label="Play"
        className="menu-btn--small fav-btn"
        disabled={!props.musicOn}
        acceptSound="start"
        acceptHint={song.playing ? 'Play from the top' : 'Play it'}
        help={
          song.playing
            ? `${song.name} is playing now. Play starts it again from the top, on the next bar.`
            : `Play ${song.name} now. It starts on the next bar, a second or two from now.`
        }
        onAccept={props.onPlay}
      />
      <MenuButton
        id={itemId(song, 'remove')}
        label="Remove"
        className="menu-btn--small fav-btn fav-btn--remove"
        acceptSound="back"
        acceptHint="Remove it"
        help={`Take ${song.name} out of your favourites. Changed your mind? You can put it back straight after.${song.playing ? ' It keeps playing until the next song.' : ''}`}
        onAccept={props.onRemove}
      />
    </li>
  )
}

/** Where a removed song was: its name, and one button to put it back. */
function GoneRow(props: { song: FavouriteSong; onUndo: () => void }) {
  const { song } = props
  return (
    <li className="fav-row fav-row--gone">
      <span className="fav-row__mark" aria-hidden="true" />
      <span className="fav-row__info">
        <span className="fav-row__name">{song.name}</span>
        <span className="fav-row__meta">Removed from your favourites</span>
      </span>
      <MenuButton
        id="fav-undo"
        label="Put it back"
        className="menu-btn--small fav-btn fav-btn--undo"
        acceptHint="Put it back"
        help={`Changed your mind? Put ${song.name} back in your favourites, in the same place.`}
        onAccept={props.onUndo}
      />
    </li>
  )
}

export function FavouriteSongs(props: { onClose: () => void }) {
  const screen = useNavScreen()
  const { songs, musicOn, list, refresh } = useFavourites()
  /** The last song removed while this list is open, and where it was. */
  const [gone, setGone] = useState<{ song: FavouriteSong; index: number } | null>(null)
  /** Move focus here after the next render (the item doesn't exist until then). */
  const focusNext = useRef<string | null>(null)

  // Opening: focus the song playing now, else the first song, else Back.
  useEffect(() => {
    const now = songs.find((s) => s.playing) ?? songs[0]
    focusItem(screen, now ? itemId(now, musicOn ? 'play' : 'remove') : 'fav-back')
  }, []) // only when the list opens
  useEffect(() => {
    if (focusNext.current === null) return
    focusItem(screen, focusNext.current)
    focusNext.current = null
  })

  const play = (index: number) => {
    audio.playFavourite(index)
    refresh()
  }
  const remove = (index: number) => {
    const out = audio.removeFavourite(index)
    if (out) {
      setGone({ song: out, index })
      focusNext.current = 'fav-undo'
    }
    refresh()
  }
  const undo = () => {
    const g = gone
    setGone(null)
    if (g && audio.undoRemoveFavourite()) {
      // Back where it was, with focus on its Remove button: the same spot as Put it back.
      focusNext.current = itemId(g.song, 'remove')
    } else {
      // It couldn't go back (the list filled up meanwhile): focus a neighbour, or Back.
      const near = songs[Math.min(g?.index ?? 0, songs.length - 1)]
      focusNext.current = near ? itemId(near, 'remove') : 'fav-back'
    }
    refresh()
  }

  // The rows, with the removed song's row back in its old place.
  const rows: JSX.Element[] = songs.map((s, i) => (
    <SongRow key={itemId(s, 'play')} song={s} number={i + 1} musicOn={musicOn} onPlay={() => play(i)} onRemove={() => remove(i)} />
  ))
  if (gone) rows.splice(Math.min(gone.index, rows.length), 0, <GoneRow key="gone" song={gone.song} onUndo={undo} />)

  const count = songs.length
  return (
    <section className="panel pause-panel fav-panel" aria-label="Favourite songs">
      <div className="screen-head">
        <span className="eyebrow">Music · {count === 0 ? 'none saved' : `${count} saved`}</span>
        <h2 className="screen-title">Favourite songs</h2>
      </div>
      {count > 0 && (
        <p className="fav-note">
          {!musicOn
            ? 'The music is off, so Play is greyed out. You can still remove songs.'
            : list === 'favourites'
              ? 'Play is set to Favourites, so these play one after another.'
              : 'Play is set to All: a new song every drive. Set it to Favourites to hear only these.'}
        </p>
      )}
      {rows.length > 0 && <ol className="fav-list nav-scroll">{rows}</ol>}
      {count === 0 && (
        <p className="empty-note fav-empty">
          No favourite songs saved. When a song you like is playing, turn on <b>Save song</b> in the pause menu and it shows up here.
          To hunt for one, press <b>Next song</b> (or N while driving, B on the controller).
        </p>
      )}
      <div className="fav-foot">
        <MenuButton id="fav-back" label="Back" acceptSound="back" help="Back to the pause menu." onAccept={props.onClose} />
      </div>
      <HelpLine />
    </section>
  )
}
