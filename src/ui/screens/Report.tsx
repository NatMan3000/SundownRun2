// ============================================================
//  REPORT A PROBLEM - tell Dad (and GitHub) what went wrong
// ------------------------------------------------------------
//  Opens from the title screen and the pause menu. Pick what kind
//  of report it is, give it a short title, say what happened, and
//  Send. The game's own server (server/issues.ts) posts it on the
//  game's public GitHub page as an issue, with game details added
//  (report/details.ts; "See what gets sent" shows every one).
//
//  Typing: press Enter on a box (or click it) to type in it. While
//  you type, every key belongs to the box - W, A, S, D, R, Space,
//  Esc, the arrows - so nothing drives the car or opens a menu.
//  Esc stops typing, Tab goes to the next box, Ctrl+Enter sends.
//  Clicking in the words puts the caret where you clicked (drag,
//  double-click and Shift+click select, like any text box); getting
//  in with Enter or Tab puts it at the end. While you type, moving
//  the mouse over other things leaves you in your box (nav.tsx).
//
//  The controller moves around the screen and presses Send and
//  Cancel like every other menu. Typing itself needs a keyboard.
//
//  Cancel keeps what you typed (until it is sent or the page
//  reloads), so closing by accident never loses a report.
// ============================================================

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { create } from 'zustand'
import { useGame } from '../../core/store'
import { audio } from '../../core/api'
import type { UiSound } from '../../core/api'
import { playerName } from '../../net/identity'
import { NavScreen, focusItem, focusedHandlers, useNavItem } from '../nav'
import { ChoiceRow, HelpLine, MenuButton } from '../widgets'
import { ActionGlyphs, Glyph } from '../hints'
import type { HintItem } from '../hints'
import { closeScreen, setFocus, showNotice, useUi } from '../uiStore'
import { REPORT_KINDS, REPORT_LIMITS, REPORT_REPO } from '../report/protocol'
import type { ReportDetails, ReportInfo, ReportKind, ReportResult, SavedReason } from '../report/protocol'
import { snapshotDetails } from '../report/details'
import { browserQueueLength, fetchReportInfo, flushBrowserQueue, sendReport } from '../report/send'

type FieldId = 'title' | 'text' | 'name'
/** The boxes, in Tab order. */
const FIELDS: readonly FieldId[] = ['title', 'text', 'name']
/** Shortest title and description worth sending. */
const MIN_TITLE = 3
const MIN_TEXT = 5

type Stage = 'form' | 'sending' | 'done'

// ---------------------------------------------------------------- the draft

interface Draft {
  kind: ReportKind
  title: string
  text: string
  name: string
  /** The name box has been filled in from the multiplayer name once already. */
  namePrefilled: boolean
}

/** What you typed, kept while the screen is closed (until it is sent or the page reloads). */
const useDraft = create<Draft>(() => ({ kind: 'bug', title: '', text: '', name: '', namePrefilled: false }))

/** Your multiplayer name tag, unless it is the made-up "RACER 123" one. */
function multiplayerName(): string {
  const n = playerName()
  return /^RACER \d+$/.test(n) ? '' : n.slice(0, REPORT_LIMITS.name)
}

/** Take the keyboard back from a box inside `root` (so W, A, S, D work for the game again). */
function stopTyping(root: HTMLElement | null): void {
  const el = document.activeElement
  if (el instanceof HTMLElement && root?.contains(el)) el.blur()
}

// ---------------------------------------------------------------- a text box

type TextEl = HTMLInputElement | HTMLTextAreaElement

function Field(props: {
  id: FieldId
  label: string
  optional?: boolean
  multiline?: boolean
  value: string
  max: number
  placeholder: string
  help: string
  editing: boolean
  onChange: (v: string) => void
  register: (id: FieldId, el: TextEl | null) => void
  startTyping: (id: FieldId) => void
  clickBox: (id: FieldId) => void
  onKey: (id: FieldId, e: ReactKeyboardEvent<TextEl>) => void
  onFocusBox: (id: FieldId) => void
  onBlurBox: (id: FieldId) => void
}) {
  const pad = useGame((s) => s.inputDevice) === 'gamepad'
  const nav = useNavItem<HTMLDivElement>(props.id, {
    // (On the controller the hint bar leaves A out here and says typing needs a keyboard.)
    onAccept: () => {
      if (useGame.getState().inputDevice === 'gamepad') {
        audio.ui('error')
        showNotice('Typing needs a keyboard: press Enter on the keyboard, or click the box.')
        return
      }
      // After this key press is over, or the Enter / Space that got us here would land in the box.
      setTimeout(() => props.startTyping(props.id), 0)
    },
    onClick: () => props.clickBox(props.id),
    acceptSound: null,
    acceptHint: 'Type',
    help: props.help,
  })
  const domId = `report-${props.id}`
  const prompt = nav.focused && !props.editing ? (pad ? 'Typing needs a keyboard' : 'Press Enter to type, or click here') : props.placeholder
  const common = {
    id: domId,
    className: 'field__input',
    value: props.value,
    maxLength: props.max,
    placeholder: prompt,
    spellCheck: true,
    autoComplete: 'off',
    onChange: (e: { target: { value: string } }) => props.onChange(e.target.value),
    onKeyDown: (e: ReactKeyboardEvent<TextEl>) => props.onKey(props.id, e),
    onFocus: () => props.onFocusBox(props.id),
    onBlur: () => props.onBlurBox(props.id),
  }
  const full = props.value.length >= props.max
  return (
    <div
      ref={nav.ref}
      {...nav.props}
      className={`field${props.multiline ? ' field--multi' : ''}${nav.focused ? ' is-focused' : ''}${props.editing ? ' is-editing' : ''}${full ? ' is-full' : ''}`}
    >
      <div className="field__head">
        <label className="field__label" htmlFor={domId}>
          {props.label}
          {props.optional && <span className="field__opt">optional</span>}
        </label>
        <span className="field__count" aria-hidden={!props.editing}>
          {props.value.length}/{props.max}
        </span>
      </div>
      {props.multiline ? (
        <textarea {...common} ref={(el) => props.register(props.id, el)} rows={4} />
      ) : (
        <input {...common} ref={(el) => props.register(props.id, el)} type="text" />
      )}
    </div>
  )
}

// ---------------------------------------------------------------- the Send / Cancel row

/**
 * A button in the action row. The row is one nav group whose entry is the
 * main button, so moving down into the row from anywhere lands on Send (or
 * Done), not on whichever button happens to sit closest.
 */
function ActionButton(props: {
  id: string
  label: string
  main?: boolean
  disabled?: boolean
  help: string
  acceptSound?: UiSound | null
  acceptHint?: string
  onAccept: () => void
}) {
  const nav = useNavItem<HTMLButtonElement>(props.id, {
    onAccept: props.onAccept,
    disabled: props.disabled,
    help: props.help,
    acceptSound: props.acceptSound,
    acceptHint: props.acceptHint ?? 'Select',
    group: 'actions',
    entry: props.main,
  })
  return (
    <button
      type="button"
      tabIndex={-1}
      ref={nav.ref}
      {...nav.props}
      className={`menu-btn${props.main ? ' menu-btn--go' : ''}${nav.focused ? ' is-focused' : ''}${props.disabled ? ' is-disabled' : ''}`}
      aria-disabled={props.disabled || undefined}
    >
      <span className="menu-btn__label">{props.label}</span>
    </button>
  )
}

// ---------------------------------------------------------------- what gets sent

function SentPreview(props: { details: ReportDetails; info: ReportInfo | 'no-server' | null }) {
  const { details, info } = props
  const version =
    info && info !== 'no-server'
      ? `${info.version}, commit ${info.commit}${info.changed.length ? `, game files changed here: ${info.changed.join(', ')}` : ''}`
      : "added by the game's server when it sends"
  return (
    <aside className="panel report-sent" aria-label="What gets sent">
      <div className="screen-head">
        <span className="eyebrow">Goes with your report</span>
        <h3 className="report-sent__title">What gets sent</h3>
      </div>
      <p className="report-sent__note">
        Your kind, title, words and name, plus these game details so the problem can be found. Nothing else: no address, no computer name.
      </p>
      <dl className="report-facts">
        <div>
          <dt>Game version</dt>
          <dd>{version}</dd>
        </div>
        {details.lines.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <h4 className="report-sub">{details.events.length ? `Last ${details.events.length} game events` : 'Game events'}</h4>
      {details.events.length ? (
        <ol className="report-log">
          {details.events.map((e, i) => (
            <li key={i} title={e}>
              {e}
            </li>
          ))}
        </ol>
      ) : (
        <p className="report-sent__note">None yet.</p>
      )}
      <h4 className="report-sub">Recent errors</h4>
      {details.errors.length ? (
        <ol className="report-log">
          {details.errors.map((e, i) => (
            <li key={i} title={e}>
              {e}
            </li>
          ))}
        </ol>
      ) : (
        <p className="report-sent__note">None.</p>
      )}
    </aside>
  )
}

// ---------------------------------------------------------------- the lines under the form

function StatusLine(props: { info: ReportInfo | 'no-server' | null }) {
  const { info } = props
  const kept = browserQueueLength()
  if (info === null) return <p className="report-status">Checking whether reporting is switched on...</p>
  if (info === 'no-server') {
    return <p className="report-status is-warn">The game's server isn't answering, so this will be kept in this browser and sent next time.</p>
  }
  const n = info.waiting + kept
  const waiting = n ? ` ${n} older ${n === 1 ? 'report is' : 'reports are'} waiting to go with it.` : ''
  if (info.ready) return <p className="report-status is-good">Reporting is on: this goes straight to GitHub.{waiting}</p>
  return (
    <p className="report-status is-warn">
      Reporting isn't switched on on this computer yet, so this will be saved here and sent once Dad turns it on.{waiting}
    </p>
  )
}

const SAVED_WHY: Record<SavedReason, string> = {
  'no-token': "Reporting isn't switched on on this computer yet. Ask Dad to turn it on (the README says how).",
  offline: "The game couldn't reach GitHub. Is the internet on?",
  refused: "GitHub said no to the game's key. Ask Dad to check it.",
  'no-server': "The game's server wasn't answering, so it's kept in this browser for now.",
}

/** The hint bar: menu buttons normally, typing keys while a box has the keyboard. */
function ReportHints(props: { editing: boolean; back: string }) {
  useUi((s) => s.focus)
  useUi((s) => s.hintNonce)
  const pad = useGame((s) => s.inputDevice) === 'gamepad'
  if (props.editing) {
    return (
      <div className="hintbar">
        {[
          ['Esc', 'Done typing'],
          ['Tab', 'Next box'],
          ['Ctrl+Enter', 'Send'],
        ].map(([key, label]) => (
          <span className="hint" key={key}>
            <Glyph name={key} pad={false} />
            <span className="hint__label">{label}</span>
          </span>
        ))}
      </div>
    )
  }
  const h = focusedHandlers()
  // On the controller, A does nothing useful on a text box: leave its hint out (the note says why).
  const onBox = pad && (FIELDS as readonly string[]).includes(useUi.getState().focus.report ?? '')
  const items: HintItem[] = []
  if (h?.sideHint) items.push({ action: 'adjust', label: h.sideHint })
  items.push({ action: 'move', label: 'Move' })
  if (!onBox) items.push({ action: 'accept', label: h?.acceptHint ?? 'Select' })
  items.push({ action: 'back', label: props.back })
  return (
    <div className="hintbar">
      {items.map((i) => (
        <span className="hint" key={`${i.action}:${i.label}`}>
          <ActionGlyphs action={i.action} />
          <span className="hint__label">{i.label}</span>
        </span>
      ))}
      {pad && <span className="hint hint--note">Typing needs a keyboard</span>}
    </div>
  )
}

// ---------------------------------------------------------------- the screen

export function ReportScreen() {
  const fromPause = useUi((s) => s.stack[0] === 'pause')
  const draft = useDraft()
  // Taken the moment the screen opens, before any typing: where the car was when the problem happened.
  const [details] = useState(snapshotDetails)
  const [info, setInfo] = useState<ReportInfo | 'no-server' | null>(null)
  const [stage, setStage] = useState<Stage>('form')
  const [result, setResult] = useState<ReportResult | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [showSent, setShowSent] = useState(false)
  const [editing, setEditing] = useState<FieldId | null>(null)
  const root = useRef<HTMLDivElement | null>(null)
  const boxes = useRef<Partial<Record<FieldId, TextEl | null>>>({})
  const alive = useRef(true)
  const busy = useRef(false)

  // The first time the screen opens, the name box starts with your multiplayer name tag.
  useLayoutEffect(() => {
    if (!useDraft.getState().namePrefilled) useDraft.setState({ name: multiplayerName(), namePrefilled: true })
  }, [])

  useEffect(() => {
    alive.current = true
    void fetchReportInfo().then((i) => {
      if (!alive.current) return
      setInfo(i ?? 'no-server')
      // The server is back: hand over anything this browser was keeping for it.
      if (i) void flushBrowserQueue()
    })
    return () => {
      alive.current = false
    }
  }, [])

  useLayoutEffect(() => {
    const el = root.current
    return () => {
      // Leaving with a box still focused would leave the keyboard in 'text' (the car's keys dead).
      stopTyping(el)
      // Next time, open at the top rather than on the button this was closed with.
      useUi.setState((s) => {
        const focus = { ...s.focus }
        delete focus.report
        return { focus }
      })
    }
  }, [])

  useEffect(() => {
    if (stage === 'done') requestAnimationFrame(() => focusItem('report', 'done'))
  }, [stage])

  /** Getting into a box from the keyboard (Enter, Space, Tab): type in it, carrying on from the end. */
  const startTyping = (id: FieldId) => {
    const el = boxes.current[id]
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }

  /**
   * A mouse click on a box. A click on its words has already put the caret
   * where you clicked (or a drag, double-click or Shift+click has selected
   * some), so leave that alone. Only a click beside them (the label, the
   * box's edge) starts typing, and then at the end.
   */
  const clickBox = (id: FieldId) => {
    if (document.activeElement === boxes.current[id]) return
    startTyping(id)
  }

  const trySend = async () => {
    stopTyping(root.current)
    if (busy.current) return
    const d = useDraft.getState()
    if (d.title.trim().length < MIN_TITLE) {
      setProblem('Give it a short title first.')
      audio.ui('error')
      focusItem('report', 'title')
      return
    }
    if (d.text.trim().length < MIN_TEXT) {
      setProblem('Say what happened first.')
      audio.ui('error')
      focusItem('report', 'text')
      return
    }
    busy.current = true
    setProblem(null)
    setStage('sending')
    const r = await sendReport({ kind: d.kind, title: d.title.trim(), text: d.text.trim(), name: d.name.trim(), details })
    busy.current = false
    // Sent or saved: the report is safe either way, so the draft can go.
    if (r.status !== 'rejected') useDraft.setState({ title: '', text: '' })
    if (!alive.current) return
    if (r.status === 'rejected') {
      setStage('form')
      setProblem(r.message)
      audio.ui('error')
      return
    }
    audio.ui(r.status === 'sent' ? 'start' : 'select')
    setResult(r)
    setStage('done')
  }

  const onKey = (id: FieldId, e: ReactKeyboardEvent<TextEl>) => {
    // Every key typed in a box stays in the box: stopping it here means the
    // game's keyboard listener (core/input.ts, on the window) never hears it.
    e.stopPropagation()
    if (e.nativeEvent.isComposing) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.currentTarget.blur()
      return
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      void trySend()
      return
    }
    const step = e.key === 'Tab' ? (e.shiftKey ? -1 : 1) : e.key === 'Enter' && id !== 'text' ? 1 : 0
    if (step === 0) return
    e.preventDefault()
    const next = FIELDS[FIELDS.indexOf(id) + step]
    if (next) {
      startTyping(next)
      return
    }
    e.currentTarget.blur()
    focusItem('report', step > 0 ? 'send' : 'kind')
  }

  const fieldProps = {
    register: (id: FieldId, el: TextEl | null) => {
      boxes.current[id] = el
    },
    startTyping,
    clickBox,
    onKey,
    onFocusBox: (id: FieldId) => {
      setEditing(id)
      setFocus('report', id)
    },
    onBlurBox: (id: FieldId) => setEditing((cur) => (cur === id ? null : cur)),
  }

  const sending = stage === 'sending'
  const back = () => {
    stopTyping(root.current)
    closeScreen()
  }

  return (
    <NavScreen id="report" onBack={sending ? undefined : back} initial="kind">
      <div ref={root} className={`screen screen--report${fromPause ? ' screen--over-game' : ''}`}>
        <div className="scrim scrim--left" aria-hidden="true" />
        {stage === 'done' && result ? (
          <DoneView
            result={result}
            onAgain={() => {
              setResult(null)
              setStage('form')
              requestAnimationFrame(() => focusItem('report', 'kind'))
            }}
            onDone={back}
          />
        ) : (
          <section className="panel report-panel nav-scroll" aria-label="Report a problem" aria-busy={sending}>
            <div className="screen-head">
              <span className="eyebrow">Tell us what happened</span>
              <h2 className="screen-title">Report a problem</h2>
            </div>
            <p className="report-warn">
              <span className="report-warn__icon" aria-hidden="true">
                !
              </span>
              <span>
                This goes on the game's <b>public</b> GitHub page, where anyone can read it. No full names, addresses, school or anything private.
              </span>
            </p>
            <ChoiceRow<ReportKind>
              id="kind"
              label="What kind"
              value={draft.kind}
              options={REPORT_KINDS}
              onChange={(v) => useDraft.setState({ kind: v })}
              help="Something's broken: a bug. An idea: something you'd love in the game. Something else: anything else."
            />
            <Field
              {...fieldProps}
              id="title"
              label="Short title"
              value={draft.title}
              max={REPORT_LIMITS.title}
              placeholder="The car fell through the big loop"
              help="A few words that sum it up, like a headline."
              editing={editing === 'title'}
              onChange={(v) => useDraft.setState({ title: v })}
            />
            <Field
              {...fieldProps}
              id="text"
              label="What happened?"
              multiline
              value={draft.text}
              max={REPORT_LIMITS.text}
              placeholder="What were you doing? What went wrong? What did you expect to happen?"
              help="What you were doing, what went wrong, and what you expected. The more you say, the easier it is to fix."
              editing={editing === 'text'}
              onChange={(v) => useDraft.setState({ text: v })}
            />
            <Field
              {...fieldProps}
              id="name"
              label="Your name"
              optional
              value={draft.name}
              max={REPORT_LIMITS.name}
              placeholder="First name or nickname"
              help="A first name or a nickname only, never your full name."
              editing={editing === 'name'}
              onChange={(v) => useDraft.setState({ name: v })}
            />
            <MenuButton
              id="preview"
              label={showSent ? 'Hide what gets sent' : 'See what gets sent'}
              className="menu-btn--small report-preview-btn"
              acceptSound={null}
              acceptHint={showSent ? 'Hide' : 'Show'}
              help="Everything the game adds to your report, so you can check it first."
              onAccept={() => {
                audio.ui('toggle')
                setShowSent((v) => !v)
              }}
            />
            <StatusLine info={info} />
            {problem && (
              <p className="report-problem" role="alert">
                {problem}
              </p>
            )}
            <nav className="report-actions" aria-label="Send or cancel">
              <ActionButton
                id="send"
                label={sending ? 'Sending...' : 'Send'}
                main
                disabled={sending}
                acceptSound={null}
                acceptHint="Send"
                help={`Send it to the game's GitHub page (github.com/${REPORT_REPO}).`}
                onAccept={() => void trySend()}
              />
              <ActionButton
                id="cancel"
                label="Cancel"
                disabled={sending}
                acceptSound="back"
                help="Close without sending. What you typed stays here until you send it."
                onAccept={back}
              />
            </nav>
            <HelpLine />
          </section>
        )}
        {showSent && stage !== 'done' && <SentPreview details={details} info={info} />}
        <ReportHints editing={editing !== null} back={stage === 'done' ? 'Done' : 'Cancel'} />
      </div>
    </NavScreen>
  )
}

function DoneView(props: { result: ReportResult; onAgain: () => void; onDone: () => void }) {
  const r = props.result
  const sent = r.status === 'sent'
  return (
    <section className="panel report-panel report-panel--done" aria-label="Report sent" role="status">
      <div className="screen-head">
        <span className="eyebrow">Report a problem</span>
      </div>
      <div className="report-done">
        <span className={`report-done__big ${sent ? 'is-sent' : 'is-saved'}`}>{sent ? 'Sent! Thanks.' : 'Saved'}</span>
        {r.status === 'sent' && (
          <>
            <p className="report-done__line">
              It's report <b>#{r.number}</b> on the game's GitHub page.
            </p>
            {r.alsoSent > 0 && (
              <p className="report-done__why">
                {r.alsoSent} older {r.alsoSent === 1 ? 'report' : 'reports'} that were waiting went with it.
              </p>
            )}
          </>
        )}
        {r.status === 'saved' && (
          <>
            <p className="report-done__line">Saved on this computer, it will send next time.</p>
            <p className="report-done__why">{SAVED_WHY[r.reason]}</p>
            {r.reason === 'refused' && r.detail && <p className="report-done__why">For Dad: {r.detail}.</p>}
          </>
        )}
      </div>
      <nav className="report-actions" aria-label="Done">
        <ActionButton id="done" label="Done" main acceptSound="back" help="Back to the menu." onAccept={props.onDone} />
        <ActionButton id="again" label="Report something else" help="Start a new report." onAccept={props.onAgain} />
      </nav>
      <HelpLine />
    </section>
  )
}
