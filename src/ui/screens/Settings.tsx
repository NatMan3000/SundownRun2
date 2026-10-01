// ============================================================
//  SETTINGS - every knob, in tabs
// ------------------------------------------------------------
//  Opens from the title screen and from the pause menu. LB / RB
//  (Q / E on the keyboard) switch tabs; up / down pick a row;
//  left / right change it (hold to go faster); A / Enter resets
//  a changed row to its default. Nothing needs a restart: the
//  game reads settings live.
//
//  The rows themselves are listed in settingsSchema.ts. Defaults
//  come from src/core/config.ts, so if Josh changes a default
//  there, "reset" goes back to his new value.
// ============================================================

import { useEffect, useRef, useState } from 'react'
import { SETTING_RANGES, getDefaults, useSettings } from '../../core/settings'
import type { CameraMode, QualityChoice } from '../../core/settings'
import { useGame } from '../../core/store'
import { vehicle, audio } from '../../core/api'
import { NavScreen, focusItem, useNavItem } from '../nav'
import { ChoiceRow, ColourRow, HelpLine, MenuButton, SliderRow, ToggleRow } from '../widgets'
import { HintBar } from '../hints'
import { SETTINGS_TABS, closeScreen, useUi } from '../uiStore'
import type { SettingsTab } from '../uiStore'
import { CAMERA_CHOICES, QUALITY_CHOICES, SETTINGS_ROWS, TAB_LABELS } from '../settingsSchema'
import type { RowSpec } from '../settingsSchema'
import { TrackParamRows } from '../TrackParamRows'
import { getCurrentTrackFile, trackParamsFor } from '../../track/current'

const QUALITY_WORD = { low: 'Low', medium: 'Medium', high: 'High' } as const

function rowId(tab: SettingsTab, spec: RowSpec, i: number): string {
  return 'key' in spec ? `set:${spec.key}` : `set:${tab}:${spec.kind}:${i}`
}

/** The first row's nav id on a tab (focus lands there after a tab switch). */
function firstRowId(tab: SettingsTab): string {
  const spec = SETTINGS_ROWS[tab][0]
  if (spec.kind === 'colour') return `set:${spec.key}:swatches`
  if (spec.kind === 'trackParams') {
    // The first live param of the current track, or the Track tab itself when it has none.
    const file = getCurrentTrackFile()
    const first = file ? trackParamsFor(file)[0] : undefined
    return first ? `settings-track:${first.id}` : 'tab:track'
  }
  return rowId(tab, spec, 0)
}

function SettingRow(props: { tab: SettingsTab; spec: RowSpec; index: number }) {
  const { spec, tab } = props
  const id = rowId(tab, spec, props.index)
  const value = useSettings((s) => ('key' in spec ? s[spec.key] : null))
  const set = useSettings((s) => s.set)
  const defaults = getDefaults()
  const qualityLevel = useGame((s) => s.qualityLevel)
  const qualityChoice = useSettings((s) => s.quality)

  switch (spec.kind) {
    case 'slider': {
      const r = SETTING_RANGES[spec.key]!
      return (
        <SliderRow
          id={id}
          label={spec.label}
          value={value as number}
          min={r.min}
          max={r.max}
          step={r.step}
          format={spec.format}
          onChange={(v) => set(spec.key, v)}
          defaultValue={defaults[spec.key]}
          help={spec.help}
        />
      )
    }
    case 'toggle':
      return <ToggleRow id={id} label={spec.label} value={value as boolean} onChange={(v) => set(spec.key, v)} defaultValue={defaults[spec.key]} help={spec.help} />
    case 'choice': {
      if (spec.key === 'camera') {
        return <ChoiceRow<CameraMode> id={id} label={spec.label} value={value as CameraMode} options={CAMERA_CHOICES} onChange={(v) => set('camera', v)} defaultValue={defaults.camera} help={spec.help} />
      }
      if (spec.key === 'quality') {
        return <ChoiceRow<QualityChoice> id={id} label={spec.label} value={value as QualityChoice} options={QUALITY_CHOICES} onChange={(v) => set('quality', v)} defaultValue={defaults.quality} help={spec.help} />
      }
      const bodies = vehicle.bodies()
      const current = value as string
      const options = bodies.length ? bodies.map((b) => ({ value: b.id, label: b.name })) : [{ value: current, label: current }]
      return <ChoiceRow<string> id={id} label={spec.label} value={current} options={options} onChange={(v) => set('carBody', v)} defaultValue={defaults.carBody} help={spec.help} />
    }
    case 'colour':
      return (
        <ColourRow
          id={`set:${spec.key}`}
          label={spec.label}
          value={value as string}
          swatches={spec.swatches}
          tone={spec.tone}
          onChange={(v) => set(spec.key, v)}
          defaultValue={defaults[spec.key]}
          help={spec.help}
        />
      )
    case 'trackParams':
      return <TrackParamRows idPrefix="settings-track" emptyText="{track} has no live settings. Tracks that do (like the Hyperdrome's bank angle) show them here." />
    case 'qualityInUse':
      return (
        <div className="row row--info">
          <span className="row__label">{spec.label}</span>
          <span className="toggle-wrap">
            <span className="row__info">{QUALITY_WORD[qualityLevel]}</span>
            <span className="row__value row__value--dim">{qualityChoice === 'auto' ? 'picked by Auto' : 'your choice'}</span>
          </span>
          <span />
          <span className="row__reset" aria-hidden="true" />
        </div>
      )
  }
}

function Tab(props: { tab: SettingsTab; active: boolean; onPick: () => void }) {
  const nav = useNavItem<HTMLButtonElement>(`tab:${props.tab}`, {
    onAccept: props.onPick,
    acceptSound: null,
    group: 'tabs',
    entry: props.active,
    help: `${TAB_LABELS[props.tab]} settings.`,
  })
  return (
    <button
      type="button"
      tabIndex={-1}
      role="tab"
      aria-selected={props.active}
      ref={nav.ref}
      {...nav.props}
      className={`tab${props.active ? ' is-active' : ''}${nav.focused ? ' is-focused' : ''}`}
    >
      {TAB_LABELS[props.tab]}
    </button>
  )
}

/** Reset every setting to config.ts. Asks once: the first press arms it, the second within 3 s does it. */
function ResetAll() {
  const [armed, setArmed] = useState(false)
  const t = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (t.current) clearTimeout(t.current)
  }, [])
  return (
    <MenuButton
      id="reset-all"
      label={armed ? 'Press again to reset everything' : 'Reset all'}
      className={`menu-btn--small${armed ? ' is-armed' : ''}`}
      help="Puts every setting back to the defaults in config.ts. Your records and tracks are kept."
      acceptSound={null}
      onAccept={() => {
        if (!armed) {
          audio.ui('toggle')
          setArmed(true)
          if (t.current) clearTimeout(t.current)
          t.current = setTimeout(() => setArmed(false), 3000)
          return
        }
        if (t.current) clearTimeout(t.current)
        setArmed(false)
        audio.ui('select')
        useSettings.getState().resetAll()
      }}
    />
  )
}

export function SettingsScreen() {
  const tab = useUi((s) => s.settingsTab)
  const fromPause = useUi((s) => s.stack[0] === 'pause')
  const mp = useGame((s) => s.multiplayer)

  const switchTab = (next: SettingsTab) => {
    if (next === useUi.getState().settingsTab) return
    useUi.setState({ settingsTab: next })
    // Keep focus on the tab row if that's where it was; otherwise go to the new tab's first row.
    const f = useUi.getState().focus.settings ?? ''
    requestAnimationFrame(() => focusItem('settings', f.startsWith('tab:') ? `tab:${next}` : firstRowId(next)))
  }

  const onTab = (dir: -1 | 1) => {
    const i = SETTINGS_TABS.indexOf(useUi.getState().settingsTab)
    const n = SETTINGS_TABS.length
    switchTab(SETTINGS_TABS[(i + dir + n) % n])
  }

  const rows = SETTINGS_ROWS[tab]
  return (
    <NavScreen id="settings" onBack={closeScreen} onTab={onTab} initial={firstRowId(tab)}>
      <div className={`screen screen--settings${fromPause ? ' screen--over-game' : ''}`}>
        <div className="scrim scrim--left" aria-hidden="true" />
        <section className="panel settings-panel" aria-label="Settings">
          <header className="settings-head">
            <div className="screen-head screen-head--row">
              <h2 className="screen-title">Settings</h2>
              {fromPause && <span className="eyebrow">{mp ? 'Game still running' : 'Game paused'}</span>}
            </div>
            <div className="tabs" role="tablist">
              <span className="tabs__glyph">
                <ActionGlyphsSingle side="prev" />
              </span>
              {SETTINGS_TABS.map((t) => (
                <Tab key={t} tab={t} active={t === tab} onPick={() => switchTab(t)} />
              ))}
              <span className="tabs__glyph">
                <ActionGlyphsSingle side="next" />
              </span>
            </div>
          </header>
          <div className="settings-rows nav-scroll" key={tab}>
            {rows.map((spec, i) => (
              <SettingRow key={`${tab}:${i}`} tab={tab} spec={spec} index={i} />
            ))}
          </div>
          <footer className="settings-foot">
            <HelpLine />
            <ResetAll />
          </footer>
        </section>
        <HintBar
          items={[
            { action: 'move', label: 'Move' },
            { action: 'tabs', label: 'Tabs' },
            { action: 'back', label: 'Back' },
          ]}
        />
      </div>
    </NavScreen>
  )
}

/** LB on the left end of the tab row, RB on the right (Q / E on the keyboard). */
function ActionGlyphsSingle(props: { side: 'prev' | 'next' }) {
  const pad = useGame((s) => s.inputDevice) === 'gamepad'
  if (!pad) return <span className="glyph glyph--key">{props.side === 'prev' ? 'Q' : 'E'}</span>
  return <span className="glyph glyph--bumper">{props.side === 'prev' ? 'LB' : 'RB'}</span>
}

