// ============================================================
//  RESULTS - how the run went
// ------------------------------------------------------------
//  The play system calls showResults() when a race finishes, a
//  stunt attack's clock runs out or the core hunt is complete;
//  this screen reads what it wrote into the store:
//    race   standings with times and best laps
//    stunt  your score against your best
//    hunt   your time against your best
//    tag    least time as "it" wins
//  Then: Again, Track select, or back to the title.
// ============================================================

import { useGame } from '../../core/store'
import { getCar } from '../../core/telemetry'
import { NavScreen } from '../nav'
import { MenuButton } from '../widgets'
import { HintBar } from '../hints'
import { openScreen, useUi } from '../uiStore'
import { quitToTitle, restartSession } from '../flow'
import { formatLap, formatScore } from '../format'

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

function RaceStandings() {
  const results = useGame((s) => s.raceResults)
  const position = useGame((s) => s.racePosition)
  const racers = useGame((s) => s.raceRacers)
  const sorted = [...results].sort((a, b) => a.position - b.position)
  const me = sorted.find((r) => r.isPlayer)
  const pos = me?.position ?? position
  return (
    <>
      <div className="result-hero">
        <span className={`result-hero__big${pos === 1 ? ' is-win' : ''}`}>{ordinal(pos)}</span>
        <span className="result-hero__sub">{pos === 1 ? 'You won the race' : `of ${Math.max(racers, sorted.length)}`}</span>
      </div>
      {sorted.length > 0 && (
        <table className="standings">
          <thead>
            <tr>
              <th>Pos</th>
              <th>Driver</th>
              <th>Time</th>
              <th>Best lap</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.carId} className={r.isPlayer ? 'is-me' : ''}>
                <td>{r.position}</td>
                <td>
                  <span className="standings__dot" style={{ background: getCar(r.carId)?.glow }} />
                  {r.isPlayer ? 'You' : r.name}
                </td>
                <td>{r.ms === null ? 'Did not finish' : formatLap(r.ms)}</td>
                <td>{formatLap(r.bestLapMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

function ScoreVsBest(props: { label: string; value: string; best: string; isBest: boolean; bestLabel: string }) {
  return (
    <div className="result-hero">
      <span className="eyebrow">{props.label}</span>
      <span className={`result-hero__big${props.isBest ? ' is-win' : ''}`}>{props.value}</span>
      <span className="result-hero__sub">{props.isBest ? 'New best!' : `${props.bestLabel} ${props.best}`}</span>
    </div>
  )
}

/**
 * Tag: net reuses raceResults with `ms` = SECONDS spent as "it" (least wins).
 * Falls back to the live tagSeconds if no results were written.
 */
function TagStandings() {
  const results = useGame((s) => s.raceResults)
  const secs = useGame((s) => s.tagSeconds)
  const rows: { id: string; name: string; s: number | null; me: boolean }[] = results.length
    ? results.map((r) => ({ id: r.carId, name: r.isPlayer ? 'You' : r.name, s: r.ms, me: r.isPlayer }))
    : Object.entries(secs).map(([id, v]) => ({ id, name: id === 'player' ? 'You' : getCar(id)?.name ?? id, s: v, me: id === 'player' }))
  rows.sort((a, b) => (a.s ?? Infinity) - (b.s ?? Infinity))
  const winner = rows[0]
  return (
    <>
      <div className="result-hero">
        <span className="eyebrow">Tag</span>
        <span className={`result-hero__big${winner?.me ? ' is-win' : ''}`}>{winner ? (winner.me ? 'You win' : `${winner.name} wins`) : 'Round over'}</span>
        <span className="result-hero__sub">Least time as "it" wins</span>
      </div>
      <table className="standings">
        <thead>
          <tr>
            <th>Pos</th>
            <th>Driver</th>
            <th>Time as it</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id} className={r.me ? 'is-me' : ''}>
              <td>{i + 1}</td>
              <td>
                <span className="standings__dot" style={{ background: getCar(r.id)?.glow }} />
                {r.name}
              </td>
              <td>{r.s === null ? '-' : `${r.s.toFixed(1)} s`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

/** Free roam and time trial: a summary of the run (only the numbers that happened). */
function RunSummary() {
  const laps = useGame((s) => s.lapCount)
  const lastLap = useGame((s) => s.lastLapMs)
  const bestLap = useGame((s) => s.bestLapMs)
  const tricks = useGame((s) => s.trickScore)
  const props = useGame((s) => s.propScore)
  const found = useGame((s) => s.coresFound)
  const total = useGame((s) => s.coresTotal)
  const trap = useGame((s) => s.trapBestKmh)
  const newBest = lastLap !== null && bestLap !== null && lastLap <= bestLap
  const rows: [string, string, boolean?][] = [[laps === 1 ? 'Lap' : 'Laps', String(laps)]]
  if (lastLap !== null) rows.push(['Last lap', formatLap(lastLap), newBest])
  if (bestLap !== null) rows.push(['Best lap', formatLap(bestLap)])
  if (tricks > 0) rows.push(['Trick points', formatScore(tricks)])
  if (props > 0) rows.push(['Prop points', formatScore(props)])
  if (total > 0) rows.push(['Energy cores', `${found} / ${total}`])
  if (trap !== null) rows.push(['Top speed', `${Math.round(trap)} km/h`])
  return (
    <>
      <div className="result-hero">
        <span className={`result-hero__big${newBest ? ' is-win' : ''}`}>{newBest ? 'New best lap' : 'Run over'}</span>
      </div>
      <dl className="stats stats--wide">
        {rows.map(([k, v, good]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className={good ? 'stats__good' : undefined}>{v}</dd>
          </div>
        ))}
      </dl>
    </>
  )
}

function ResultBody() {
  const mode = useGame((s) => s.mode)
  const stuntScore = useGame((s) => s.stuntScore)
  const stuntBest = useGame((s) => s.stuntBest)
  const huntLast = useGame((s) => s.huntLastMs)
  const huntBest = useGame((s) => s.huntBestMs)
  if (mode === 'race') return <RaceStandings />
  if (mode === 'tag') return <TagStandings />
  if (mode === 'stunt') {
    return <ScoreVsBest label="Stunt score" value={formatScore(stuntScore)} best={formatScore(stuntBest)} isBest={stuntBest !== null && stuntScore > 0 && stuntScore >= stuntBest} bestLabel="Your best" />
  }
  if (huntLast !== null) {
    return <ScoreVsBest label="Core hunt" value={formatLap(huntLast)} best={formatLap(huntBest)} isBest={huntBest !== null && huntLast <= huntBest} bestLabel="Your best" />
  }
  return <RunSummary />
}

export function ResultsScreen() {
  const trackName = useGame((s) => s.trackName)
  const mode = useGame((s) => s.mode)
  return (
    <NavScreen id="results" initial="again">
      <div className="screen screen--results screen--over-game">
        <div className="scrim scrim--full" aria-hidden="true" />
        <section className="panel results-panel" aria-label="Results">
          <div className="screen-head">
            <span className="eyebrow">{trackName}</span>
            <h2 className="screen-title">Results</h2>
          </div>
          <ResultBody />
          <nav className="results-actions" aria-label="What next">
            <MenuButton id="again" label="Again" help="Same track, same mode, from the start." onAccept={restartSession} acceptSound="start" />
            <MenuButton
              id="tracks"
              label="Track select"
              help="Pick another track for this mode."
              onAccept={() => {
                useUi.setState({ pendingMode: mode })
                openScreen('track')
              }}
            />
            <MenuButton id="title" label="Title" help="Back to the title screen." onAccept={quitToTitle} acceptSound="back" />
          </nav>
        </section>
        <HintBar
          items={[
            { action: 'move', label: 'Move' },
            { action: 'accept', label: 'Select' },
          ]}
        />
      </div>
    </NavScreen>
  )
}
