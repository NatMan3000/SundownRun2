// ============================================================
//  TRACK SELECT - pick where to drive, then go
// ------------------------------------------------------------
//  Every track the game knows (src/track/registry.ts): the
//  built-in files in tracks/, tracks drawn in the road editor,
//  and a multiplayer host's shared track. Each card leads with a
//  map drawn from the file itself, then the name, author, where it
//  came from, the description, length, features and your records
//  (for the track you last drove). The panel sizes itself to the
//  cards, so two tracks never sit in a sea of empty glass.
//
//  Multiplayer: only the host picks. Everyone else sees the
//  host's track and a Drive button.
// ============================================================

import { useMemo } from 'react'
import { useGame } from '../../core/store'
import type { GameMode } from '../../core/store'
import { getRecords } from '../../core/records'
import { listTracks } from '../../track/registry'
import type { TrackListing, TrackSource } from '../../track/registry'
import { getTrack } from '../../track/current'
import { useNet } from '../../net'
import { NavScreen, useNavItem } from '../nav'
import { MenuButton } from '../widgets'
import { HintBar } from '../hints'
import { closeScreen, useUi } from '../uiStore'
import { TrackThumb, approxTrackLength } from '../TrackThumb'
import { beginSession } from '../flow'
import { formatLap, formatScore } from '../format'

const SOURCE_LABEL: Record<TrackSource, string> = {
  builtin: 'Built-in',
  drawn: 'Drawn',
  shared: 'Shared',
}

const MODE_LABEL: Record<GameMode, string> = {
  free: 'Free Roam',
  timetrial: 'Time Trial',
  race: 'Race',
  stunt: 'Stunt Attack',
  tag: 'Tag',
}

function countPieces(t: TrackListing) {
  const c = { loop: 0, wallride: 0, boost: 0, ramp: 0, speedtrap: 0 }
  for (const p of t.file.pieces ?? []) {
    if (p.type in c) c[p.type as keyof typeof c]++
  }
  return c
}

function featuresOf(t: TrackListing): string[] {
  const pieces = countPieces(t)
  return [
    pieces.loop && `${pieces.loop} loop${pieces.loop > 1 ? 's' : ''}`,
    pieces.wallride && `${pieces.wallride} wall ride${pieces.wallride > 1 ? 's' : ''}`,
    pieces.boost && `${pieces.boost} boost pad${pieces.boost > 1 ? 's' : ''}`,
    pieces.ramp && `${pieces.ramp} ramp${pieces.ramp > 1 ? 's' : ''}`,
    pieces.speedtrap && 'speed trap',
    t.file.road?.banking?.adjustable && 'adjustable banking',
  ].filter(Boolean) as string[]
}

/**
 * One track: the map is the hero, then the name, where it came from, its
 * description, length and laps, your records (for the track you last drove)
 * and what's on it. Cards in a row share a height.
 */
function TrackCard(props: { t: TrackListing; current: boolean; disabled: boolean; onGo: () => void }) {
  const { t } = props
  const nav = useNavItem<HTMLButtonElement>(`track:${t.id}`, {
    onAccept: props.onGo,
    acceptSound: null,
    acceptHint: 'Drive',
    disabled: props.disabled,
    help: t.description,
  })
  const live = getTrack()
  const rec = props.current && live?.id === t.id ? getRecords(live.key) : null
  const len = approxTrackLength(t.file)
  const features = featuresOf(t)
  return (
    <button
      type="button"
      tabIndex={-1}
      ref={nav.ref}
      {...nav.props}
      className={`track-card${nav.focused ? ' is-focused' : ''}${props.disabled ? ' is-disabled' : ''}`}
    >
      <TrackThumb file={t.file} width={320} height={190} className="track-card__thumb" />
      <span className="track-card__head">
        <span className="track-card__name">{t.name}</span>
        <span className={`badge badge--${t.source}`}>{SOURCE_LABEL[t.source]}</span>
      </span>
      <span className="track-card__meta">
        {t.author && <span>by {t.author}</span>}
        {props.current && <span className="track-card__here">Last driven</span>}
      </span>
      {t.description && <span className="track-card__desc">{t.description}</span>}
      <dl className="stats track-card__stats">
        <div>
          <dt>Length</dt>
          <dd>{len >= 1000 ? `${(len / 1000).toFixed(1)} km` : `${Math.round(len)} m`}</dd>
        </div>
        {t.file.laps ? (
          <div>
            <dt>Race laps</dt>
            <dd>{t.file.laps}</dd>
          </div>
        ) : null}
        {rec && (
          <div>
            <dt>Best lap</dt>
            <dd className={rec.bestLapMs !== undefined ? 'stats__good' : 'stats__none'}>{rec.bestLapMs !== undefined ? formatLap(rec.bestLapMs) : 'None yet'}</dd>
          </div>
        )}
        {rec?.stuntBest !== undefined && (
          <div>
            <dt>Stunt best</dt>
            <dd>{formatScore(rec.stuntBest)}</dd>
          </div>
        )}
        {rec?.huntBestMs !== undefined && (
          <div>
            <dt>Core hunt best</dt>
            <dd>{formatLap(rec.huntBestMs)}</dd>
          </div>
        )}
        {rec?.trapBestKmh !== undefined && (
          <div>
            <dt>Top speed</dt>
            <dd>{Math.round(rec.trapBestKmh)} km/h</dd>
          </div>
        )}
      </dl>
      {features.length > 0 && (
        <span className="chips track-card__chips">
          {features.map((f) => (
            <span className="chip" key={f}>
              {f}
            </span>
          ))}
        </span>
      )}
    </button>
  )
}

export function TrackSelectScreen() {
  const mode = useUi((s) => s.pendingMode)
  const mp = useGame((s) => s.multiplayer)
  const trackId = useGame((s) => s.trackId)
  const isHost = useNet((s) => s.isHost)
  const hostTrack = useNet((s) => s.hostTrack)
  const online = useNet((s) => s.status) === 'online'
  // Only a connected non-host follows the host. Still connecting: pick freely.
  const joiner = mp && online && !isHost
  // Re-list when the screen opens (a drawn track may have been saved since).
  const tracks = useMemo(() => listTracks(), [])
  const joinId = hostTrack?.id ?? trackId
  const joinName = hostTrack?.name ?? tracks.find((t) => t.id === joinId)?.name ?? joinId

  return (
    <NavScreen id="track" onBack={closeScreen} initial={joiner ? 'go' : `track:${tracks.some((t) => t.id === trackId) ? trackId : tracks[0]?.id}`}>
      <div className="screen screen--track">
        <div className="scrim scrim--full" aria-hidden="true" />
        <section className="panel track-pick" aria-label="Choose a track">
          <div className="screen-head">
            <span className="eyebrow">{MODE_LABEL[mode]}</span>
            <h2 className="screen-title">Choose a track</h2>
          </div>
          {joiner && (
            <div className="host-banner">
              <span className="host-banner__label">Track from the host</span>
              <span className="host-banner__name">{joinName}</span>
              <MenuButton id="go" label="Drive" help="Only the host can change the track." className="menu-btn--go" acceptSound={null} onAccept={() => beginSession(mode, joinId)} />
            </div>
          )}
          {tracks.length === 0 ? (
            <p className="empty-note">No tracks found. Put a track file in the tracks folder, or draw one in the Road Editor.</p>
          ) : (
            <div className={`track-grid nav-scroll${joiner ? ' is-locked' : ''}`}>
              {tracks.map((t) => (
                <TrackCard key={`${t.source}:${t.id}`} t={t} current={t.id === trackId} disabled={joiner} onGo={() => beginSession(mode, t.id)} />
              ))}
            </div>
          )}
        </section>
        <HintBar
          items={[
            { action: 'move', label: 'Move' },
            { action: 'accept', label: 'Drive' },
            { action: 'back', label: 'Back' },
          ]}
        />
      </div>
    </NavScreen>
  )
}
