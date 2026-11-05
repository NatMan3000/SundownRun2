// ============================================================
//  CRASH GUARD - the page is never left blank
// ------------------------------------------------------------
//  With no boundary, one error while React draws takes the whole
//  page down and leaves it empty for good. This catches it and
//  shows a plain screen with one Reload button instead. It needs no
//  WebGL and no game state. It never reloads by itself, so a crash
//  on every start can't turn into a loop.
//
//  It sizes itself in px and dvh, never vh (a Safari tab on its
//  side is 874x292 while 100vh says 402), and it stays clear of the
//  notch and the home bar. Its Reload is at least 44 px tall
//  (spec/phone-landscape-standard.md).
// ============================================================

import { Component } from 'react'
import type { CSSProperties, ErrorInfo, ReactNode } from 'react'
import { FONTS, PALETTE } from './core/palette'

/** Thrown by App.tsx when the context stayed gone (core/glLife.ts): the screen says so in its own words. */
export class PictureGone extends Error {}

const PAGE: CSSProperties = {
  position: 'fixed',
  inset: 0,
  overflow: 'auto',
  display: 'flex',
  background: PALETTE.uiPanelSolid,
  color: PALETTE.uiText,
  fontFamily: FONTS.body,
  fontSize: 'clamp(15px, 2.2dvh, 22px)',
  lineHeight: 1.4,
  paddingTop: 'max(12px, env(safe-area-inset-top, 0px))',
  paddingRight: 'max(20px, env(safe-area-inset-right, 0px))',
  paddingBottom: 'max(12px, env(safe-area-inset-bottom, 0px))',
  paddingLeft: 'max(20px, env(safe-area-inset-left, 0px))',
  boxSizing: 'border-box',
}

const BOX: CSSProperties = {
  margin: 'auto',
  width: 'min(100%, 38em)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '0.7em',
  textAlign: 'center',
}

const HEADING: CSSProperties = {
  margin: 0,
  fontFamily: FONTS.display,
  fontSize: '2em',
  fontWeight: 700,
  lineHeight: 1.1,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: PALETTE.uiText,
}

const WORDS: CSSProperties = { margin: 0, color: PALETTE.uiDim }

// (No focus ring: it is the only thing on the page, and it always has the focus.)
const RELOAD: CSSProperties = {
  minWidth: 180,
  minHeight: 52,
  padding: '0 1.6em',
  background: PALETTE.uiAccent,
  border: 'none',
  outline: 'none',
  borderRadius: 999,
  color: PALETTE.uiPanelSolid,
  fontFamily: FONTS.display,
  fontSize: '1.25em',
  fontWeight: 700,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  cursor: 'pointer',
  touchAction: 'manipulation',
}

/** The game's sun, the same one as the browser tab's icon: this is still the game, it just stopped. */
function Sun() {
  return (
    <svg viewBox="0 0 100 80" style={{ height: '2.4em', flex: 'none' }} aria-hidden="true">
      <defs>
        <linearGradient id="crash-sun" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={PALETTE.sunTop} />
          <stop offset="0.5" stopColor={PALETTE.sunMid} />
          <stop offset="1" stopColor={PALETTE.sunBottom} />
        </linearGradient>
      </defs>
      <circle cx="50" cy="40" r="40" fill="url(#crash-sun)" />
      <rect y="46" width="100" height="5" fill={PALETTE.uiPanelSolid} />
      <rect y="58" width="100" height="7" fill={PALETTE.uiPanelSolid} />
      <rect y="70" width="100" height="10" fill={PALETTE.uiPanelSolid} />
    </svg>
  )
}

function CrashScreen({ pictureGone }: { pictureGone: boolean }) {
  return (
    <div style={PAGE} role="alert" data-testid="crash-screen">
      <div style={BOX}>
        <Sun />
        <h1 style={HEADING}>The game stopped</h1>
        <p style={WORDS}>{pictureGone ? "Your phone or computer stopped drawing the game's picture and it didn't come back." : 'Something broke inside the game.'} It isn't your fault.</p>
        <p style={WORDS}>Reload starts the game again. A road you're drawing in the Road Editor is kept, but a race you were in starts over.</p>
        <button type="button" style={RELOAD} autoFocus onClick={() => location.reload()}>
          Reload
        </button>
      </div>
    </div>
  )
}

export class CrashGuard extends Component<{ children: ReactNode }, { crashed: boolean; pictureGone: boolean }> {
  state = { crashed: false, pictureGone: false }

  static getDerivedStateFromError(error: unknown) {
    return { crashed: true, pictureGone: error instanceof PictureGone }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('[crash]', error, info.componentStack)
  }

  render() {
    return this.state.crashed ? <CrashScreen pictureGone={this.state.pictureGone} /> : this.props.children
  }
}
