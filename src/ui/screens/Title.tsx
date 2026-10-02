// ============================================================
//  TITLE SCREEN - the logotype and the main menu
// ------------------------------------------------------------
//  The 3D world keeps running behind this: the camera slowly
//  orbits your car on the grid at sundown (the vehicle worker's
//  showroom camera). So the menu lives in a column on the left
//  and leaves the car in view on the right.
//
//  The logotype "SUNDOWN RUN II" is an inline SVG: sun-coloured
//  gradient letters cut by horizontal bands (like the synthwave
//  sun), with a neon outline showing through the cuts. SVG, not
//  CSS background-clip text: some browsers drew those letters black.
// ============================================================

import { useId } from 'react'
import { useGame } from '../../core/store'
import { openEditor } from '../../core/session'
import { useNet } from '../../net'
import { NavScreen, useNavItem } from '../nav'
import { MenuButton, HelpLine } from '../widgets'
import { HintBar } from '../hints'
import { openScreen, showNotice, useUi } from '../uiStore'
import { SoundHint } from '../SoundHint'

/** The sun's horizontal cuts down the letters, top to bottom: [from, to] as fractions of the letter height. */
const LOGO_CUTS: [number, number][] = [
  [0.49, 0.525],
  [0.61, 0.655],
  [0.725, 0.785],
  [0.84, 0.915],
]

export function Logo(props: { compact?: boolean }) {
  // ids must be unique per page; useId gives colons, which SVG url() references accept
  const id = useId().replace(/:/g, '')
  const sun = `${id}-sun`
  const cuts = `${id}-cuts`
  const pink = `${id}-pink`
  // 100 viewBox units = 1em of the logo's font size, so the SVG scales with the layout
  return (
    <h1 className={`logo${props.compact ? ' logo--compact' : ''}`} aria-label="Sundown Run II">
      <svg className="logo__svg" viewBox="0 0 540 190" aria-hidden="true">
        <defs>
          <linearGradient id={sun} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0.08" style={{ stopColor: 'var(--sun-top)' }} />
            <stop offset="0.5" style={{ stopColor: 'var(--sun-mid)' }} />
            <stop offset="0.88" style={{ stopColor: 'var(--sun-bottom)' }} />
          </linearGradient>
          <mask id={cuts} maskContentUnits="objectBoundingBox">
            <rect x="0" y="0" width="1" height="1" fill="#fff" />
            {LOGO_CUTS.map(([a, b]) => (
              <rect key={a} x="0" y={a} width="1" height={b - a} fill="#000" />
            ))}
          </mask>
          <filter id={pink} x="-10%" y="-30%" width="120%" height="160%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="far" />
            <feGaussianBlur in="SourceGraphic" stdDeviation="1.6" result="near" />
            <feMerge>
              <feMergeNode in="far" />
              <feMergeNode in="near" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        {/* each word: the neon outline behind, then the banded sun gradient on top,
            so the outline shows through the cuts. textLength pins the widths whatever
            condensed font the computer has. */}
        <g className="logo__word">
          <text className="logo__outline" x="6" y="86" textLength="500" lengthAdjust="spacingAndGlyphs" filter={`url(#${pink})`}>SUNDOWN</text>
          <text x="6" y="86" textLength="500" lengthAdjust="spacingAndGlyphs" fill={`url(#${sun})`} mask={`url(#${cuts})`}>SUNDOWN</text>
        </g>
        <g className="logo__word">
          <text className="logo__outline" x="6" y="172" textLength="196" lengthAdjust="spacingAndGlyphs" filter={`url(#${pink})`}>RUN</text>
          <text x="6" y="172" textLength="196" lengthAdjust="spacingAndGlyphs" fill={`url(#${sun})`} mask={`url(#${cuts})`}>RUN</text>
        </g>
        <g className="logo__word">
          <text className="logo__outline" x="222" y="172" textLength="62" lengthAdjust="spacingAndGlyphs" filter={`url(#${pink})`}>II</text>
          <text x="222" y="172" textLength="62" lengthAdjust="spacingAndGlyphs" fill={`url(#${sun})`} mask={`url(#${cuts})`}>II</text>
        </g>
      </svg>
    </h1>
  )
}

const STATUS_WORDS = {
  off: 'Multiplayer off',
  connecting: 'Looking for the host...',
  online: 'Connected',
  'version-mismatch': 'Different game version',
} as const

/** "Connected - 3 players - you're hosting", plus any track problem in plain words. */
export function MpStatus() {
  const status = useNet((s) => s.status)
  const isHost = useNet((s) => s.isHost)
  const peers = useNet((s) => s.peers)
  const hostId = useNet((s) => s.hostId)
  const trackError = useNet((s) => s.trackError)
  const count = Object.keys(peers).length + 1
  const hostName = peers[hostId]?.name
  const role = status !== 'online' ? null : isHost ? 'You are the host' : hostName ? `${hostName} is hosting` : 'Joined'
  return (
    <div className={`mp-status mp-status--${status}`} role="status">
      <span className="mp-status__dot" aria-hidden="true" />
      <span className="mp-status__main">{STATUS_WORDS[status]}</span>
      {status === 'online' && (
        <span className="mp-status__meta">
          {count} {count === 1 ? 'player' : 'players'}
        </span>
      )}
      {role && <span className="mp-status__meta">{role}</span>}
      {status === 'version-mismatch' && (
        <span className="mp-status__error">Everyone needs the same version of the game. Update, then reload this page.</span>
      )}
      {trackError && <span className="mp-status__error">The host's track could not be built here: {trackError}</span>}
    </div>
  )
}

/** Josh's workshop (bun run learn writes it at the repo root, which only the dev server serves). */
const LEARN_URL = '/Learn%20To%20Code.html'

/**
 * "Learn to code": a quiet link under the menu that opens the workshop in a new
 * tab. Browsers only open tabs from a key press or click, not a controller
 * button, so from the pad it explains that instead of failing silently.
 */
function LearnLink() {
  const nav = useNavItem<HTMLButtonElement>('learn', {
    onAccept: () => {
      const tab = window.open(LEARN_URL, '_blank', 'noopener')
      if (!tab && useGame.getState().inputDevice === 'gamepad') {
        showNotice('The browser only opens a new tab from a key or a click: press Enter or click Learn to code.')
      }
    },
    acceptHint: 'Open',
    help: 'Learn to code with Sundown Run II: missions that change the real game. Opens in a new tab.',
  })
  return (
    <button type="button" tabIndex={-1} ref={nav.ref} {...nav.props} className={`learn-link${nav.focused ? ' is-focused' : ''}`}>
      Learn to code
    </button>
  )
}

export function TitleScreen() {
  const mp = useGame((s) => s.multiplayer)
  return (
    <NavScreen id="title" initial="play">
      <div className="screen screen--title">
        <div className="scrim scrim--left" aria-hidden="true" />
        <div className="title-col">
          <Logo />
          <p className="tagline">Chase the sun into the neon night.</p>
          <nav className="title-menu" aria-label="Main menu">
            <MenuButton
              id="play"
              label="Play"
              help={mp ? 'Race, roam or play tag with everyone here.' : 'Free roam, time trial, race the Ai, or a stunt attack.'}
              onAccept={() => {
                useUi.setState({ pendingMode: mp ? 'race' : 'free' })
                openScreen('mode')
              }}
            />
            <MenuButton id="garage" label="Garage" help="Pick your car and paint it: body, underglow and light trail." onAccept={() => openScreen('garage')} />
            <MenuButton id="editor" label="Road Editor" help="Draw your own track, drop in loops and boost pads, then test drive it." onAccept={openEditor} />
            <MenuButton id="settings" label="Settings" help="Handling, camera, sound, time of day, graphics and more." onAccept={() => openScreen('settings')} />
          </nav>
          {import.meta.env.DEV && <LearnLink />}
          <HelpLine />
          {mp && <MpStatus />}
        </div>
        <SoundHint variant="menu" />
        <HintBar
          items={[
            { action: 'move', label: 'Move' },
            { action: 'accept', label: 'Select' },
          ]}
          contextual={false}
        />
      </div>
    </NavScreen>
  )
}
