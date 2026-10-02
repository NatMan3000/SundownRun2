// ============================================================
//  REPORT PROTOCOL - what the game and its server say to each other
// ------------------------------------------------------------
//  The "Report a problem" screen (src/ui/screens/Report.tsx) sends a
//  report to the game's own local server (server/issues.ts), which
//  posts it on GitHub. Both sides import this file, so the shapes and
//  the size limits can never drift apart.
//
//  Plain data and one pure helper: no browser or server code in here.
// ============================================================

/** Where the game's server listens for reports. */
export const REPORT_ENDPOINT = '/api/report'

/** The public GitHub page the reports go to (named on the screen). */
export const REPORT_REPO = 'NatMan3000/SundownRun2'

export type ReportKind = 'bug' | 'idea' | 'other'

/** The three kinds, in the order the screen shows them. */
export const REPORT_KINDS: readonly { value: ReportKind; label: string }[] = [
  { value: 'bug', label: "Something's broken" },
  { value: 'idea', label: 'An idea' },
  { value: 'other', label: 'Something else' },
]

/** Size limits. The screen stops typing at these; the server refuses anything bigger. */
export const REPORT_LIMITS = {
  title: 80,
  text: 3000,
  name: 20,
  /** "What gets sent" rows, and the longest label and value in one. */
  lines: 30,
  lineLabel: 40,
  lineValue: 400,
  /** Recent game events and errors attached. */
  events: 20,
  event: 220,
  errors: 10,
  error: 300,
  /** The whole request, in bytes. */
  body: 48 * 1024,
} as const

/** The automatic details: "label: value" rows, recent game events, recent errors. */
export interface ReportDetails {
  lines: [string, string][]
  events: string[]
  errors: string[]
}

/** What the screen sends (POST REPORT_ENDPOINT, JSON). */
export interface ReportRequest {
  kind: ReportKind
  title: string
  text: string
  /** Optional first name or nickname; empty for none. */
  name: string
  details: ReportDetails
}

/** Why a report waits on this computer instead of going to GitHub now. */
export type SavedReason =
  | 'no-token' //  reporting is not switched on here (no github-token.txt)
  | 'offline' //   GitHub could not be reached (no internet, or GitHub is down)
  | 'refused' //   GitHub said no (the key expired, or lost its permission)
  | 'no-server' // the game's server could not be reached: kept in this browser instead

/** The server's answer to a report. */
export type ReportResult =
  | { status: 'sent'; number: number; url: string; /** Earlier waiting reports that went with it. */ alsoSent: number }
  | {
      status: 'saved'
      reason: SavedReason
      /** Reports now waiting on this computer, this one included. */
      waiting: number
      /** What went wrong, in the server's words (e.g. GitHub's 401 or 403), for Dad. Never holds the key. */
      detail?: string
    }
  | { status: 'rejected'; reason: 'too-many' | 'invalid' | 'full'; message: string }

/**
 * Hide the computer's user name inside any folder path ("C:\Users\Josh Smith\..."
 * or "/Users/josh/..."). Reports go on a public page, so both sides run
 * everything through this before it leaves.
 */
export function scrubPrivate(s: string): string {
  return s
    .replace(/([A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+)[^\\/\r\n"'<>|]+/gi, '$1(name)')
    .replace(/((?:^|[\s"'(=:])\/(?:Users|home)\/)[^/\s"'<>]+/g, '$1(name)')
}

/** GET REPORT_ENDPOINT: is reporting switched on, and what version is this? */
export interface ReportInfo {
  /** A GitHub key is set up on this computer. */
  ready: boolean
  /** package.json version. */
  version: string
  /** Short git commit, or 'unknown' when git is not available. */
  commit: string
  /** Game files changed on this computer since that commit (paths inside the game folder). */
  changed: string[]
  /** Reports saved here, waiting to send. */
  waiting: number
}
