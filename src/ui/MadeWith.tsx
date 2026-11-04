// ============================================================
//  MADE WITH - "Made with (the sun) by Josh & Kai"
// ------------------------------------------------------------
//  The sign-off in the corner of the title screen. There's nothing
//  to press on it.
//
//  The sun is the one on the game's app icon (public/icons/icon.svg):
//  the same circle, gradient and bands, cut off at the icon's horizon.
//  The numbers below are the icon's, so if you redraw that sun, change
//  it here too.
// ============================================================

import { useId } from 'react'

/** The dark bands across the sun, top to bottom: [y, height] in the icon's units. */
const SUN_BANDS: [number, number][] = [
  [372, 12],
  [432, 20],
  [498, 30],
  [572, 42],
]

function IconSun() {
  // ids must be unique per page, same as the logo's (Title.tsx)
  const id = useId().replace(/:/g, '')
  const glow = `${id}-sun`
  const bands = `${id}-bands`
  return (
    // The viewBox stops at the icon's horizon (640), which cuts the bottom of the sun off the same way.
    <svg className="made-with__sun" viewBox="222 110 580 530" role="img" aria-label="sunshine">
      <defs>
        <linearGradient id={glow} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: 'var(--sun-top)' }} />
          <stop offset="0.55" style={{ stopColor: 'var(--sun-mid)' }} />
          <stop offset="1" style={{ stopColor: 'var(--sun-bottom)' }} />
        </linearGradient>
        <mask id={bands} maskUnits="userSpaceOnUse" x="222" y="110" width="580" height="580">
          <rect x="222" y="110" width="580" height="580" fill="#fff" />
          {SUN_BANDS.map(([y, height]) => (
            <rect key={y} x="222" y={y} width="580" height={height} fill="#000" />
          ))}
        </mask>
      </defs>
      <circle cx="512" cy="400" r="290" fill={`url(#${glow})`} mask={`url(#${bands})`} />
    </svg>
  )
}

export function MadeWith() {
  return (
    <p className="made-with">
      Made with <IconSun /> by Josh &amp; Kai
    </p>
  )
}
