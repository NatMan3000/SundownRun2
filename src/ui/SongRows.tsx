// ============================================================
//  SONG ROWS - the pause menu's music controls
// ------------------------------------------------------------
//    Next song   a new song (the same mood, or your next
//                favourite), starting on the next bar. The row
//                shows the song playing now: its name and key.
//                While driving: N, or B on the controller.
//    Save song   keep the song playing in your favourites (or
//                take it out again). A song is its seed, so a
//                saved song plays exactly the same every time.
//    Play        All (a new song every drive) or only your
//                Favourites, one after another.
//    Favourite songs   opens the list of saved songs, to play one
//                or remove one (FavouriteSongs.tsx).
//
//  Everything goes through the audio API (src/core/api.ts), which
//  the music installs (src/audio/music/songs.ts keeps the list).
//  It checks audio.song() four times a second, so a song that
//  changes while the menu is open (Next song lands on the next
//  bar) shows straight away.
// ============================================================

import { useEffect, useState } from 'react'
import { audio } from '../core/api'
import type { SongList } from '../core/api'
import { ChoiceRow, MenuButton, ToggleRow } from './widgets'

const POLL_MS = 250

/** Re-render when the song, its saved state or the list changes. */
function useSongState() {
  const read = () => {
    const s = audio.song()
    const l = audio.songList()
    return `${s?.id ?? -1}|${s?.favourite ?? false}|${l.list}|${l.favourites}`
  }
  const [, setKey] = useState(read)
  useEffect(() => {
    const t = setInterval(() => setKey(read()), POLL_MS)
    return () => clearInterval(t)
  }, [])
  const refresh = () => setKey(read())
  return { song: audio.song(), list: audio.songList(), refresh }
}

export function SongRows(props: { onOpenFavourites: () => void }) {
  const { song, list, refresh } = useSongState()
  const options: { value: SongList; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'favourites', label: 'Favourites' },
  ]
  return (
    <>
      <MenuButton
        id="next-song"
        label="Next song"
        sub={song ? `${song.name} · ${song.key}` : 'No music playing'}
        disabled={!song}
        help="Not feeling this one? A new song starts on the next bar, a second or two from now. While driving: N, or B on the controller."
        onAccept={() => {
          audio.nextSong()
          refresh()
        }}
      />
      {song && (
        <div className="pause-params pause-music">
          <ToggleRow
            id="save-song"
            label="Save song"
            value={song.favourite}
            onLabel="Saved"
            offLabel="Not saved"
            help="Keep this song in your favourites. A saved song plays exactly the same every time."
            onChange={() => {
              audio.toggleFavourite()
              refresh()
            }}
          />
          <ChoiceRow
            id="song-list"
            label="Play"
            value={list.list}
            options={options}
            help={
              list.favourites === 0
                ? 'Favourites plays only the songs you saved, and you have none yet: save one first with Save song.'
                : `All: a new song every drive. Favourites: only your ${list.favourites} saved ${list.favourites === 1 ? 'song' : 'songs'}, one after another.`
            }
            onChange={(v) => {
              audio.setSongList(v)
              refresh()
            }}
          />
        </div>
      )}
      <MenuButton
        id="fav-songs"
        label="Favourite songs"
        sub={list.favourites === 0 ? 'None saved yet' : `${list.favourites} saved`}
        help={
          list.favourites === 0
            ? 'Your saved songs. None yet: open it to see how to save one.'
            : 'See the songs you saved: play one now, or take one out.'
        }
        onAccept={props.onOpenFavourites}
      />
    </>
  )
}
