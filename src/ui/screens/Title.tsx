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
//  The II is drawn as a Roman numeral, its bars joining the two I's.
// ============================================================

import { useId, useLayoutEffect, useRef, useState } from 'react'
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

/** The sun gradient's colour stops, top to bottom (fractions of a word's line box). */
const SUN_STOPS: [number, string][] = [
  [0.08, 'var(--sun-top)'],
  [0.5, 'var(--sun-mid)'],
  [0.88, 'var(--sun-bottom)'],
]

/** Where "RUN" sits on a Mac (its line box in logo units); measured live in case the font differs. */
const RUN_LINE_BOX = { y: 71.9, h: 136.9 }

/**
 * The "II" drawn as a Roman numeral: two stems joined by a bar along the
 * top and the bottom, slanted like the italic letters next to it. In logo
 * units (100 = 1em); u runs right from x0, v runs up from the baseline.
 */
const NUMERAL_II = (() => {
  const x0 = 219
  const baseline = 172
  const slant = 0.167 // the italic letters lean 1 unit right for every 6 up
  const capHeight = 71
  const bar = 12
  const stem = 21
  const gap = 11
  const overhang = 7 // how far the bars reach past the stems
  const width = overhang * 2 + stem * 2 + gap
  const inL = overhang + stem // inner edge of the left stem
  const inR = inL + gap //       inner edge of the right stem
  const outR = width - overhang // outer edge of the right stem
  const top = capHeight - bar
  const at = ([u, v]: number[]) => `${(x0 + u + slant * v).toFixed(1)} ${(baseline - v).toFixed(1)}`
  const ring = (pts: number[][]) => `M${pts.map(at).join(' L')} Z`
  const outline = [
    [0, 0], [width, 0], [width, bar], [outR, bar], [outR, top], [width, top],
    [width, capHeight], [0, capHeight], [0, top], [overhang, top], [overhang, bar], [0, bar],
  ]
  const hole = [[inL, bar], [inL, top], [inR, top], [inR, bar]]
  return `${ring(outline)} ${ring(hole)}`
})()

export function Logo(props: { compact?: boolean }) {
  // ids must be unique per page; useId gives colons, which SVG url() references accept
  const id = useId().replace(/:/g, '')
  const sun = `${id}-sun`
  const cuts = `${id}-cuts`
  const pink = `${id}-pink`
  const sunII = `${id}-sun2`
  const cutsII = `${id}-cuts2`
  // The II is a drawn shape, not text, so its gradient and cuts are pinned to
  // RUN's line box: then its colours and bands line up with the letters beside it.
  const runRef = useRef<SVGTextElement>(null)
  const [runBox, setRunBox] = useState(RUN_LINE_BOX)
  useLayoutEffect(() => {
    try {
      const b = runRef.current?.getBBox()
      if (b && b.height > 0) setRunBox({ y: b.y, h: b.height })
    } catch {
      // not laid out (hidden): keep the Mac measurements
    }
  }, [])
  // 100 viewBox units = 1em of the logo's font size, so the SVG scales with the layout
  return (
    <h1 className={`logo${props.compact ? ' logo--compact' : ''}`} aria-label="Sundown Run II">
      <svg className="logo__svg" viewBox="0 0 540 190" aria-hidden="true">
        <defs>
          <linearGradient id={sun} x1="0" y1="0" x2="0" y2="1">
            {SUN_STOPS.map(([at, colour]) => (
              <stop key={at} offset={at} style={{ stopColor: colour }} />
            ))}
          </linearGradient>
          <mask id={cuts} maskContentUnits="objectBoundingBox">
            <rect x="0" y="0" width="1" height="1" fill="#fff" />
            {LOGO_CUTS.map(([a, b]) => (
              <rect key={a} x="0" y={a} width="1" height={b - a} fill="#000" />
            ))}
          </mask>
          <linearGradient id={sunII} gradientUnits="userSpaceOnUse" x1="0" y1={runBox.y} x2="0" y2={runBox.y + runBox.h}>
            {SUN_STOPS.map(([at, colour]) => (
              <stop key={at} offset={at} style={{ stopColor: colour }} />
            ))}
          </linearGradient>
          <mask id={cutsII} maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="0" y="0" width="540" height="190">
            <rect x="0" y="0" width="540" height="190" fill="#fff" />
            {LOGO_CUTS.map(([a, b]) => (
              <rect key={a} x="0" y={runBox.y + a * runBox.h} width="540" height={(b - a) * runBox.h} fill="#000" />
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
          <text ref={runRef} x="6" y="172" textLength="196" lengthAdjust="spacingAndGlyphs" fill={`url(#${sun})`} mask={`url(#${cuts})`}>RUN</text>
        </g>
        <g className="logo__word">
          <path className="logo__outline" d={NUMERAL_II} fillRule="evenodd" filter={`url(#${pink})`} />
          <path d={NUMERAL_II} fillRule="evenodd" fill={`url(#${sunII})`} mask={`url(#${cutsII})`} />
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

/** "Report a problem": a quiet link like Learn to code, so the main menu stays about playing. */
function ReportLink() {
  const nav = useNavItem<HTMLButtonElement>('report', {
    onAccept: () => openScreen('report'),
    acceptHint: 'Open',
    help: "Something broken, or got an idea? Send it to the game's GitHub page.",
  })
  return (
    <button type="button" tabIndex={-1} ref={nav.ref} {...nav.props} className={`learn-link${nav.focused ? ' is-focused' : ''}`}>
      Report a problem
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
          <div className="title-links">
            {import.meta.env.DEV && <LearnLink />}
            <ReportLink />
          </div>
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
