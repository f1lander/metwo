import { type CheckState, type Effort, ENGINE_SETUP, type EngineSetupStatus, type Health, type PlanFirst, type PrinciplesUpdate, type NightShiftConfig, type RollCall, type SettingsView } from '@ticketflow/shared'
import { AnimatePresence, motion } from 'motion/react'
import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { controls, loadSettings } from '../lib/api.js'
import { href, type SettingsTab } from '../lib/route.js'
import { type DaemonProcess, desktop, isDesktop } from '../lib/tauri.js'
import { modelName } from './status.js'
import { Button, ConfirmButton, Count, Dot, Mono, rise, Section, stagger, timeAgo } from './ui.js'
import { failed, notice } from '../lib/notice.js'
import { Mascot } from '@mevo/mascot/react'

const TABS: readonly { id: SettingsTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'budget', label: 'Budget' },
  { id: 'engines', label: 'Engines' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'status', label: 'Status' },
]

type Patch = Parameters<typeof controls.saveSettings>[0]
type Run = (key: string, fn: () => Promise<unknown>) => () => Promise<void>

// Everything you can change while mevo runs. Changes are saved in data/state.json and win over
// ticketflow.config.json; "reset" goes back to the file's value.
export function SettingsPage({ health, refresh, tab }: { health: Health | null; refresh: () => Promise<void>; tab: SettingsTab }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [view, setView] = useState<SettingsView | null>(null)
  const reload = useCallback(async () => setView(await loadSettings().catch(() => null)), [])
  useEffect(() => {
    void reload()
  }, [reload])

  const run: Run = (key, fn) => async () => {
    setBusy(key)
    try {
      await fn()
      await Promise.all([refresh(), reload()])
    } catch (err) {
      failed(err)
    } finally {
      setBusy(null)
    }
  }
  const save = (patch: Patch) => void run('save', () => controls.saveSettings(patch))()
  const reset = (key: string) => void run('save', () => controls.resetSetting(key))()

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <motion.div variants={stagger} initial="hidden" animate="show" className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-6 py-6 max-md:px-4 max-md:pb-28">
        <motion.div variants={rise} className="flex items-end justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold">Settings</h1>
            <p className="text-xs text-muted">{health ? `daemon pid ${health.pid} · up ${timeAgo(health.startedAt)} · changes apply right away` : 'daemon is not answering'}</p>
          </div>
          <Button className="shrink-0 whitespace-nowrap" disabled={busy !== null} onClick={run('probe', () => controls.probe())}>
            <motion.span animate={busy === 'probe' ? { rotate: 360 } : { rotate: 0 }} transition={busy === 'probe' ? { duration: 0.8, repeat: Infinity, ease: 'linear' } : { duration: 0 }} aria-hidden="true">
              ↻
            </motion.span>
            Check now
          </Button>
        </motion.div>

        <motion.nav variants={rise} className="flex gap-1 overflow-x-auto border-b border-line text-xs" aria-label="settings sections">
          {TABS.map((t) => (
            <a key={t.id} href={href.settings(t.id)} className={`relative -mb-px px-3 py-2 whitespace-nowrap ${tab === t.id ? 'text-fg' : 'text-muted hover:text-fg'}`}>
              {t.label}
              {tab === t.id && <motion.span layoutId="settings-tab" className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-accent-fg" />}
            </a>
          ))}
        </motion.nav>

        {!health || !view ? (
          <p className="text-xs text-muted">Loading…</p>
        ) : tab === 'general' ? (
          <General health={health} view={view} busy={busy} run={run} save={save} reset={reset} />
        ) : tab === 'budget' ? (
          <Budget health={health} view={view} save={save} reset={reset} />
        ) : tab === 'engines' ? (
          <EnginesTab health={health} view={view} save={save} reset={reset} />
        ) : tab === 'integrations' ? (
          <Integrations health={health} busy={busy} run={run} view={view} save={save} reset={reset} />
        ) : (
          <StatusTab health={health} busy={busy} setBusy={setBusy} run={run} refresh={refresh} />
        )}
      </motion.div>
    </div>
  )
}

// --- building blocks ----------------------------------------------------------------------

function Panel({ title, hint, children, className = '' }: { title: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <motion.section variants={rise} className={`flex flex-col rounded-lg border border-line bg-panel ${className}`}>
      <div className="flex flex-col gap-0.5 border-b border-line px-4 py-3">
        <h2 className="text-sm font-medium">{title}</h2>
        {hint && <p className="text-xs leading-relaxed text-muted">{hint}</p>}
      </div>
      <div className="flex flex-col divide-y divide-line">{children}</div>
    </motion.section>
  )
}

function Row({ label, hint, changed, onReset, children }: { label: string; hint?: ReactNode; changed?: boolean; onReset?: () => void; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1 basis-64">
        <div className="flex items-center gap-2 text-xs font-medium text-fg">
          {label}
          {changed && onReset && (
            <button type="button" onClick={onReset} className="rounded bg-raised px-1.5 py-px text-[10px] font-normal text-muted hover:text-fg" title="back to the value in ticketflow.config.json">
              changed · reset
            </button>
          )}
        </div>
        {hint && <p className="mt-0.5 text-[11px] leading-relaxed text-dim">{hint}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} className={`relative h-5 w-9 rounded-full transition-colors ${on ? 'bg-accent' : 'bg-line-2'}`}>
      <motion.span layout transition={{ type: 'spring', stiffness: 600, damping: 34 }} className={`absolute top-0.5 size-4 rounded-full bg-white shadow ${on ? 'right-0.5' : 'left-0.5'}`} />
    </button>
  )
}

// Saves on Enter or when it loses focus; empty = no value.
function NumberField({ value, onSave, prefix, placeholder, min = 0, label }: { value: number | null; onSave: (v: number | null) => void; prefix?: string; placeholder?: string; min?: number; label: string }) {
  const [text, setText] = useState(value === null ? '' : String(value))
  useEffect(() => setText(value === null ? '' : String(value)), [value])
  const commit = () => {
    const n = text.trim() === '' ? null : Number(text)
    if (n !== null && (!Number.isFinite(n) || n < min)) return setText(value === null ? '' : String(value))
    if (n !== value) onSave(n)
  }
  return (
    <label className="flex items-center gap-1 rounded-md border border-line-2 bg-bg px-2 py-1 text-xs focus-within:border-accent">
      {prefix && <span className="text-dim">{prefix}</span>}
      <input aria-label={label} inputMode="decimal" value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} className="w-20 bg-transparent text-fg outline-none tabular-nums" />
    </label>
  )
}

function TextField({ value, onSave, placeholder, label, width = 'w-56' }: { value: string; onSave: (v: string) => void; placeholder?: string; label: string; width?: string }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <input
      aria-label={label}
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text.trim() !== value && onSave(text.trim())}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      className={`${width} rounded-md border border-line-2 bg-bg px-2 py-1 font-mono text-[11px] text-fg outline-none focus:border-accent`}
    />
  )
}

function Select({ value, options, onChange, label }: { value: string; options: readonly { value: string; label: string }[]; onChange: (v: string) => void; label: string }) {
  const known = options.some((o) => o.value === value)
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="rounded-md border border-line-2 bg-bg px-2 py-1 text-xs text-fg outline-none focus:border-accent">
      {!known && <option value={value}>{value}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: readonly T[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="flex overflow-hidden rounded-md border border-line-2 text-xs" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o} type="button" role="radio" aria-checked={value === o} onClick={() => onChange(o)} className={`relative px-3 py-1 capitalize ${value === o ? 'text-fg' : 'text-muted hover:text-fg'}`}>
          {value === o && <motion.span layoutId={`seg-${label}`} className="absolute inset-0 bg-raised" transition={{ type: 'spring', stiffness: 500, damping: 36 }} />}
          <span className="relative">{o}</span>
        </button>
      ))}
    </div>
  )
}

const has = (obj: object | undefined, key: string) => Boolean(obj && key in obj)

// --- tabs ---------------------------------------------------------------------------------

function General({ health, view, busy, run, save, reset }: { health: Health; view: SettingsView; busy: string | null; run: Run; save: (p: Patch) => void; reset: (k: string) => void }) {
  const ap = view.effective.autopilot
  const o = view.overrides
  const q = view.effective.quality
  return (
    <>
      <Panel
        title="Autopilot"
        hint="Small tickets (quick UI fixes, low-risk labels, estimate 2 or less) start by themselves and move to In Progress in Linear. Anything bigger, urgent, or labelled Security / High / Protocol still asks you."
      >
        <Row label="Autopilot" hint={ap.enabled ? `${health.lanes.autopilot?.today ?? 0} of ${ap.maxPerDay} taken today` : 'off: every ticket asks you first'} changed={has(o.autopilot, 'enabled')} onReset={() => reset('autopilot.enabled')}>
          <Toggle label="autopilot" on={ap.enabled} onChange={(v) => save({ autopilot: { enabled: v } })} />
        </Row>
        <Row label="Open the draft PR by itself" hint="Only when the gates pass, the supervisor says pass and the visual check is verified. Otherwise it waits for your push and tells you why. It never marks a PR ready for review." changed={has(o.autopilot, 'autoPush')} onReset={() => reset('autopilot.autoPush')}>
          <Toggle label="auto draft PR" on={ap.autoPush} onChange={(v) => save({ autopilot: { autoPush: v } })} />
        </Row>
        <Row label="Tickets per day" hint="After this many, new small tickets wait for you." changed={has(o.autopilot, 'maxPerDay')} onReset={() => reset('autopilot.maxPerDay')}>
          <NumberField label="tickets per day" value={ap.maxPerDay} min={1} onSave={(v) => v && save({ autopilot: { maxPerDay: Math.round(v) } })} />
        </Row>
        <Row label="Check readiness before starting" hint={`A cheap model reads each new ticket and its Linear discussion: ready, needs clarification or hold. Autopilot only starts it when it is ready and at least ${view.effective.readiness.minConfidence}% sure. Your own starts just get a warning.`} changed={has(o.readiness, 'auto')} onReset={() => reset('readiness.auto')}>
          <Toggle label="readiness check" on={view.effective.readiness.auto} onChange={(v) => save({ readiness: { auto: v } })} />
        </Row>
        <Row label="Readiness engine" hint="Auto: OpenCode with its model when it is enabled (free models work), otherwise Claude Haiku. It gets no tools, only the ticket text." changed={has(o.readiness, 'engine')} onReset={() => reset('readiness.engine')}>
          <Select label="readiness engine" value={view.effective.readiness.engine} options={[{ value: 'auto', label: 'Auto' }, { value: 'opencode', label: 'OpenCode' }, { value: 'claude:haiku', label: 'Claude Haiku' }, { value: 'claude:sonnet', label: 'Claude Sonnet' }, { value: 'off', label: 'Off' }]} onChange={(v) => save({ readiness: { engine: v } })} />
        </Row>
        <Row label="Questions in the ticket chat" hint="Ask mode answers from the ticket's history (commits, review threads, checks) and read-only git. No lane runs and nothing changes." changed={has(o.chat, 'ask')} onReset={() => reset('chat.ask')}>
          <Select label="chat engine" value={view.effective.chat.ask} options={[{ value: 'claude:sonnet', label: 'Claude Sonnet' }, { value: 'claude:haiku', label: 'Claude Haiku' }, { value: 'claude:opus', label: 'Claude Opus' }, { value: 'codex', label: 'Codex (read-only)' }]} onChange={(v) => save({ chat: { ask: v } })} />
        </Row>
        <Row label="Autopilot needs" hint="Confidence the readiness check must reach before autopilot starts a ticket." changed={has(o.readiness, 'minConfidence')} onReset={() => reset('readiness.minConfidence')}>
          <NumberField label="minimum confidence" value={view.effective.readiness.minConfidence} min={0} onSave={(v) => v !== null && save({ readiness: { minConfidence: Math.max(0, Math.min(100, Math.round(v))) } })} />
        </Row>
        <Row label="Triage the cycle by itself" hint="AI sizes new and edited cycle issues a few times a day. Off: only when you press Triage. Each run counts in the budget." changed={has(view.overrides, 'triage')} onReset={() => reset('triage')}>
          <Toggle label="auto triage" on={view.effective.triage?.auto ?? false} onChange={(v) => save({ triage: { auto: v } })} />
        </Row>
      </Panel>

      <Panel title="After you address review comments" hint="What happens on GitHub when a push answers a reviewer who requested changes. The Reviewers card on the ticket also has a button for it.">
        <Row label="Reply in the threads" hint={'"Addressed in <commit>" in each thread you dealt with, unless you already answered it.'} changed={has(o.afterFix, 'reply')} onReset={() => reset('afterFix.reply')}>
          <Toggle label="reply in threads" on={view.effective.afterFix.reply} onChange={(v) => save({ afterFix: { reply: v } })} />
        </Row>
        <Row label="Resolve the threads" hint="Off by default: many reviewers like to resolve their own threads after checking." changed={has(o.afterFix, 'resolve')} onReset={() => reset('afterFix.resolve')}>
          <Toggle label="resolve threads" on={view.effective.afterFix.resolve} onChange={(v) => save({ afterFix: { resolve: v } })} />
        </Row>
        <Row label="Ask for a re-review" hint="Once every thread from a reviewer who requested changes is answered, re-request their review so GitHub shows it on their list." changed={has(o.afterFix, 'rerequest')} onReset={() => reset('afterFix.rerequest')}>
          <Toggle label="re-request review" on={view.effective.afterFix.rerequest} onChange={(v) => save({ afterFix: { rerequest: v } })} />
        </Row>
      </Panel>

      <Panel title="Before the PR" hint="What CI runs, run here first: a red result keeps the PR closed until the lane fixes it or you push anyway.">
        <Row label="Local checks" hint="Typecheck, lint and tests (reused when the supervisor just ran them green), then e2e. Runs when a lane finishes and before any push." changed={has(o.localChecks, 'enabled')} onReset={() => reset('localChecks.enabled')}>
          <Toggle label="local checks" on={view.effective.localChecks.enabled} onChange={(v) => save({ localChecks: { enabled: v } })} />
        </Row>
        <Row label="e2e specs" hint="Related: only the specs for the feature the change touches (registration changes run registration*.spec). All: every spec CI would run for that app, about an hour. One e2e run at a time; they share the local chain." changed={has(o.localChecks, 'e2e')} onReset={() => reset('localChecks.e2e')}>
          <Segmented label="e2e specs" value={view.effective.localChecks.e2e} options={['related', 'all', 'off'] as const} onChange={(v) => save({ localChecks: { e2e: v } })} />
        </Row>
      </Panel>

      <Panel title="Reviewable PRs" hint="Small PRs a person can review in one sitting: about 200 changed lines is the sweet spot, 400 the most. Lockfiles and snapshots are not counted. Empty means no limit.">
        <Row label="Aim for" hint="Lines the lane aims for. Bigger work: it does the first slice that stands on its own and lists the rest as follow-ups." changed={has(o.quality, 'targetLines')} onReset={() => reset('quality.targetLines')}>
          <NumberField label="target lines" placeholder="no limit" min={20} value={q.targetLines} onSave={(n) => save({ quality: { targetLines: n === null ? null : Math.round(n) } })} />
        </Row>
        <Row label="Most" hint="Over it the PR is not marked ready for review (you can still do it anyway) and autopilot stops before the PR." changed={has(o.quality, 'maxLines')} onReset={() => reset('quality.maxLines')}>
          <NumberField label="max lines" placeholder="no limit" min={20} value={q.maxLines} onSave={(n) => save({ quality: { maxLines: n === null ? null : Math.round(n) } })} />
        </Row>
        <Row label="Greptile at least" hint="Score out of 5 a PR needs before it is marked ready for review." changed={has(o.quality, 'minGreptile')} onReset={() => reset('quality.minGreptile')}>
          <NumberField label="minimum Greptile score" placeholder="none" min={1} value={q.minGreptile} onSave={(n) => save({ quality: { minGreptile: n === null ? null : Math.min(5, Math.round(n)) } })} />
        </Row>
        <Row label="Security lens" hint="When the diff adds signing, transactions, approvals, auth, storage or raw HTML, the review pass also reads it like a bug bounty researcher." changed={has(o.quality, 'securityLens')} onReset={() => reset('quality.securityLens')}>
          <Toggle label="security lens" on={q.securityLens} onChange={(v) => save({ quality: { securityLens: v } })} />
        </Row>
      </Panel>

      <Panel title="Lanes" hint={`${health.lanes.active.length} of ${health.lanes.max} running${health.lanes.active.length ? `: ${health.lanes.active.join(', ')}` : ''}${health.lanes.paused ? ' · paused' : ''}`}>
        <Row label="Queue" hint={health.lanes.paused ? 'paused: running lanes finish, nothing new starts' : 'accepting work'}>
          {health.lanes.paused ? (
            <Button variant="primary" disabled={busy !== null} onClick={run('resume', () => controls.resume())}>
              Resume
            </Button>
          ) : (
            <Button disabled={busy !== null} onClick={run('pause', () => controls.pause())}>
              Pause
            </Button>
          )}
        </Row>
        <Row label="Lanes at once" hint="Each one can run a dev server, Storybook and a browser." changed={has(o, 'maxParallel')} onReset={() => reset('maxParallel')}>
          <div className="flex items-center overflow-hidden rounded-md border border-line-2">
            <button type="button" aria-label="fewer lanes" className="px-2.5 py-1 text-muted hover:bg-raised hover:text-fg disabled:opacity-40" disabled={busy !== null || health.lanes.max <= 1} onClick={run('parallel', () => controls.parallel(health.lanes.max - 1))}>
              −
            </button>
            <span className="w-7 text-center text-xs font-medium tabular-nums">
              <Count value={health.lanes.max} />
            </span>
            <button type="button" aria-label="more lanes" className="px-2.5 py-1 text-muted hover:bg-raised hover:text-fg disabled:opacity-40" disabled={busy !== null || health.lanes.max >= 8} onClick={run('parallel', () => controls.parallel(health.lanes.max + 1))}>
              +
            </button>
          </div>
        </Row>
        <Row label="Effort" hint="How hard every lane and review thinks. Max stays a per-ticket choice (Start max). The budget can lower it." changed={has(o, 'effort')} onReset={() => reset('effort')}>
          <Segmented<Effort> label="effort" value={view.effective.pipeline.effort} options={['low', 'medium', 'high']} onChange={(e) => void run('effort', () => controls.effort(e))()} />
        </Row>
        {health.lanes.models && (
          <Row label="Claude models" hint="Set per lane in the config file (models).">
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted">
              {(['lite', 'full', 'review'] as const).map((k) => (
                <Fragment key={k}>
                  <span className="text-fg-2">{k}</span>
                  <span className="whitespace-nowrap">{modelName(health.lanes.models?.[k].model)}</span>
                </Fragment>
              ))}
            </div>
          </Row>
        )}
        <Row label="Restart for new code" hint="When mevo's code changes on disk (a pull, a fix), it restarts by itself as soon as no lane, check or hand test is running, so nothing runs on old code. Only when the desktop app runs mevo; from a terminal the app just tells you." changed={has(o.daemon, 'autoRestart')} onReset={() => reset('daemon.autoRestart')}>
          <Toggle label="restart for new code" on={view.effective.daemon.autoRestart} onChange={(v) => save({ daemon: { autoRestart: v } })} />
        </Row>
      </Panel>
      <Panel title="Mo" hint="The o of the logo, out in the app: he is the Tell the agent button, reacts to merges, failures and questions, and sleeps during Night Shift. Drag him to any corner; ✕ puts him back in the logo and a click on the logo brings him out.">
        <Row label="Show Mo" hint="Off: the classic Tell the agent button." changed={has(o.mascot, 'enabled')} onReset={() => reset('mascot.enabled')}>
          <Mascot state="idle" width={34} />
          <Toggle label="show mo" on={view.effective.mascot.enabled} onChange={(v) => save({ mascot: { enabled: v } })} />
        </Row>
        <Row label="Coffee game" hint="Closing an issue costs 18% of his coffee and every lane turn 3%. Click him a few times in a row to refill. At 0% no new lane starts (from here, Telegram or autopilot) until he gets coffee; lanes already running finish." changed={has(o.mascot, 'coffee')} onReset={() => reset('mascot.coffee')}>
          <Toggle label="coffee game" on={view.effective.mascot.coffee} onChange={(v) => save({ mascot: { coffee: v } })} />
        </Row>
      </Panel>

      <Principles health={health} view={view} save={save} reset={reset} />
    </>
  )
}

const PHASE_LABEL = { implement: 'Every lane', bug: 'Bug playbook', feature: 'Feature playbook', refactor: 'Refactor playbook', perf: 'Perf playbook', visual: 'Visual playbook', review: 'Review lenses', prose: 'Prose' } as const

// pstack, pinned to one commit. A newer commit only comes in after you read its diff and accept it.
function Principles({ health, view, save, reset }: { health: Health; view: SettingsView; save: (p: Patch) => void; reset: (k: string) => void }) {
  const p = health.lanes.principles
  const on = view.effective.principles?.enabled ?? false
  const [update, setUpdate] = useState<PrinciplesUpdate | null>(null)
  const [checking, setChecking] = useState(false)
  if (!p) return null
  const web = p.repo.startsWith('https://github.com/') ? p.repo.replace(/\.git$/, '') : null
  const check = async () => {
    setChecking(true)
    try {
      const u = await controls.principlesUpdate()
      setUpdate(u)
      if (u.latest === u.current) notice({ title: 'pstack is up to date', tone: 'ok' })
    } catch (err) {
      failed(err)
    } finally {
      setChecking(false)
    }
  }
  const state = !on ? 'off' : p.error ? p.error : p.head === p.ref ? `on disk${p.syncedAt ? `, checked ${timeAgo(p.syncedAt)}` : ''}` : 'fetching…'
  return (
    <Panel
      title="Engineering principles"
      hint={
        <>
          {web ? (
            <a href={web} target="_blank" rel="noreferrer" className="text-fg-2 underline decoration-line-2 underline-offset-2 hover:text-fg">
              pstack
            </a>
          ) : (
            'pstack'
          )}{' '}
          (MIT). Lanes read these files before they code and follow a playbook picked from the ticket (bug, feature, refactor, perf or visual match), the review pass and PR reviews apply them as lenses, and the supervisor checks the diff against them. Only the markdown is used; their steps that spawn agents, push or open PRs are ignored.
        </>
      }
    >
      <Row label="Use them on every ticket" hint="Each ticket can still turn them off or on for itself, from its Overview." changed={has(view.overrides.principles, 'enabled')} onReset={() => reset('principles.enabled')}>
        <Toggle label="engineering principles" on={on} onChange={(v) => save({ principles: { enabled: v } })} />
      </Row>
      <Row label="Pinned commit" hint={<span className={on && p.error ? 'text-bad' : ''}>{state}. Nothing changes until you accept a newer commit.</span>} changed={has(view.overrides.principles, 'ref')} onReset={() => reset('principles.ref')}>
        {web ? (
          <a href={`${web}/commit/${p.ref}`} target="_blank" rel="noreferrer" className="hover:text-fg">
            <Mono className="text-fg-2">{p.ref.slice(0, 7)}</Mono>
          </a>
        ) : (
          <Mono className="text-fg-2">{p.ref.slice(0, 7)}</Mono>
        )}
        <Button disabled={!on || checking} onClick={() => void check()}>
          {checking ? 'Checking…' : 'Check for updates'}
        </Button>
      </Row>
      <AnimatePresence initial={false}>
        {update && update.latest !== update.current && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div className="flex flex-col gap-2 px-4 py-3">
              <p className="text-xs text-fg-2">
                Newer commit <Mono>{update.latest.slice(0, 7)}</Mono>. Read what changed in the files mevo uses before you accept it: it becomes part of every lane's prompt.
              </p>
              {update.stat && <pre className="max-h-40 overflow-auto rounded-md border border-line bg-sunk px-3 py-2 font-mono text-[11px] leading-relaxed text-muted">{update.stat}</pre>}
              <details className="text-xs" open={update.diff.length < 4000}>
                <summary className="cursor-pointer text-muted">{update.diff ? 'Diff of the files mevo uses' : 'The files mevo uses did not change'}</summary>
                {update.diff && <pre className="mt-2 max-h-96 overflow-auto rounded-md border border-line bg-sunk px-3 py-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg-2">{update.diff}</pre>}
              </details>
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  onClick={() => {
                    save({ principles: { ref: update.latest } })
                    setUpdate(null)
                  }}
                >
                  Accept {update.latest.slice(0, 7)}
                </Button>
                <Button onClick={() => setUpdate(null)}>Keep {update.current.slice(0, 7)}</Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <Row label="What each step reads">
        <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[11px]">
          {(Object.keys(PHASE_LABEL) as (keyof typeof PHASE_LABEL)[]).map((k) => (
            <Fragment key={k}>
              <span className="text-fg-2">{PHASE_LABEL[k]}</span>
              <span className="flex max-w-md flex-wrap gap-1">
                {(p.files[k] ?? []).map((f) => (
                  <span key={f.path} title={f.present ? f.path : `${f.path}: not in this commit`} className={`rounded bg-raised px-1.5 py-px font-mono ${f.present || !p.head ? 'text-muted' : 'text-dim line-through'}`}>
                    {f.path.replace(/^principle-/, '').replace(/\/SKILL\.md$|\.md$/, '')}
                  </span>
                ))}
              </span>
            </Fragment>
          ))}
        </div>
      </Row>
    </Panel>
  )
}

const LEVEL: Record<string, { label: string; tone: string; what: string }> = {
  normal: { label: 'Normal', tone: 'text-ok', what: 'Lanes run as configured.' },
  saver: { label: 'Saving', tone: 'text-warn', what: 'Effort capped at medium, lite tickets skip the extra review pass.' },
  tight: { label: 'Tight', tone: 'text-warn', what: 'Lite runs on low effort, full on medium.' },
  over: { label: 'Over budget', tone: 'text-bad', what: 'New lanes run on the fallback engine; Claude only for tickets you pin to it. Autopilot stops when there is no fallback.' },
}

function Meter({ label, spent, limit }: { label: string; spent: number; limit: number | null }) {
  const share = limit ? Math.min(spent / limit, 1) : 0
  const color = !limit ? 'bg-line-2' : share >= 1 ? 'bg-bad' : share >= 0.6 ? 'bg-warn' : 'bg-accent-fg'
  return (
    <div className="flex flex-1 basis-56 flex-col gap-1.5">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-muted">{label}</span>
        <span className="tabular-nums">
          <span className="text-lg font-semibold text-fg">${spent.toFixed(2)}</span>
          <span className="text-dim"> {limit ? `of $${limit}` : 'no limit'}</span>
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-sunk">
        <motion.div initial={{ width: 0 }} animate={{ width: `${share * 100}%` }} className={`h-full rounded-full ${color}`} />
      </div>
    </div>
  )
}

function Budget({ health, view, save, reset }: { health: Health; view: SettingsView; save: (p: Patch) => void; reset: (k: string) => void }) {
  const b = health.lanes.budget
  const v = view.effective.budget
  const o = view.overrides.budget
  const enabled = (health.lanes.engines ?? []).filter((e) => e.id !== 'claude').map((e) => e.id)
  const level = LEVEL[b?.level ?? 'normal'] ?? LEVEL.normal
  return (
    <>
      <motion.section variants={rise} className="flex flex-col gap-4 rounded-lg border border-line bg-panel px-4 py-4">
        <div className="flex flex-wrap gap-6">
          <Meter label="Today" spent={b?.day.spent ?? 0} limit={v.daily} />
          <Meter label="This month" spent={b?.month.spent ?? 0} limit={v.monthly} />
        </div>
        <p className="text-xs">
          <span className={`font-medium ${level?.tone}`}>{level?.label}</span>
          <span className="text-muted"> · {v.regulate ? level?.what : 'Regulation is off: lanes always run as configured.'}</span>
        </p>
      </motion.section>

      <Panel title="Limits" hint="Spend is the cost each CLI reports. Claude prices its turns at API rates even on a plan, so it works as a usage meter; Codex and Cursor report none (they use your plan). Alerts arrive in Telegram at 50, 80 and 100 %.">
        <Row label="Per day" hint="Empty: no daily limit." changed={has(o, 'daily')} onReset={() => reset('budget.daily')}>
          <NumberField label="daily budget" prefix="$" placeholder="none" value={v.daily} onSave={(n) => save({ budget: { daily: n } })} />
        </Row>
        <Row label="Per month" hint="Empty: no monthly limit." changed={has(o, 'monthly')} onReset={() => reset('budget.monthly')}>
          <NumberField label="monthly budget" prefix="$" placeholder="none" value={v.monthly} onSave={(n) => save({ budget: { monthly: n } })} />
        </Row>
      </Panel>

      <Panel title="Use your plans first" hint="Codex and Cursor run on your ChatGPT or Cursor subscription and OpenCode can run free models, so a lane there costs nothing extra. Send lanes to them before Claude spends API-priced budget.">
        <Row label="Plan first" hint={`Lanes you pin to an engine keep it. ${b?.fallback ? `Goes to: ${b.fallback}.` : 'No plan engine enabled yet: turn one on in Engines.'}`} changed={has(o, 'planFirst')} onReset={() => reset('budget.planFirst')}>
          <Segmented<PlanFirst> label="plan first" value={v.planFirst} options={['off', 'lite', 'all']} onChange={(x) => save({ budget: { planFirst: x } })} />
        </Row>
      </Panel>

      <Panel title="Regulation" hint="As spend grows: from 60 % effort is capped at medium and lite skips the review pass; from 90 % lite runs on low on the plan engine; at 100 % every new lane moves there.">
        <Row label="Regulate lanes" changed={has(o, 'regulate')} onReset={() => reset('budget.regulate')}>
          <Toggle label="regulate" on={v.regulate} onChange={(x) => save({ budget: { regulate: x } })} />
        </Row>
        <Row
          label="Plan engine"
          hint={`Where plan-first and budget-saving lanes run: a flat plan (Codex, Cursor) or a free model (OpenCode, Hermes with an OpenRouter :free model). ${b?.fallback ? `Now: ${b.fallback}.` : 'None enabled yet: turn one on in Engines.'}`}
          changed={has(o, 'fallback')}
          onReset={() => reset('budget.fallback')}
        >
          <Select
            label="fallback engine"
            value={v.fallback}
            onChange={(x) => save({ budget: { fallback: x } })}
            options={[{ value: 'auto', label: 'First enabled (Codex, Cursor, OpenCode, Hermes)' }, ...['codex', 'cursor', 'opencode', 'hermes'].map((e) => ({ value: e, label: `${e}${enabled.includes(e) ? '' : ' (not enabled)'}` })), { value: 'off', label: 'None: keep Claude' }]}
          />
        </Row>
      </Panel>
    </>
  )
}

function EnginesTab({ health, view, save, reset }: { health: Health; view: SettingsView; save: (p: Patch) => void; reset: (k: string) => void }) {
  const e = view.effective.engines
  const o = view.overrides.engines
  const r = view.effective.roles
  const ro = view.overrides.roles
  const status = new Map((health.lanes.engines ?? []).map((x) => [x.id, x]))
  const enabled = ['claude', ...(['codex', 'cursor', 'opencode', 'hermes'] as const).filter((id) => e[id].enabled)]
  const engineOptions = enabled.map((id) => ({ value: id, label: id }))
  const role = (key: 'reviewer' | 'supervisor' | 'visual' | 'curator', extra: readonly { value: string; label: string }[], label: string, hint: string) => (
    <Row label={label} hint={hint} changed={has(ro, key)} onReset={() => reset(`roles.${key}`)}>
      <Select label={label} value={r[key]} options={[...extra, ...engineOptions]} onChange={(v) => save({ roles: { [key]: v } })} />
    </Row>
  )
  return (
    <>
      <Panel title="Engines" hint="Each one is a CLI on this Mac, signed in with your account. Turn one on, then Install and Sign in from its row if it needs it.">
        <EngineRow id="claude" label="Claude Code" status={status.get('claude')} always />
        {(['codex', 'cursor', 'opencode', 'hermes'] as const).map((id) => (
          <EngineRow key={id} id={id} label={{ codex: 'Codex', cursor: 'Cursor', opencode: 'OpenCode', hermes: 'Hermes' }[id]} status={status.get(id)}>
            <Toggle label={`${id} enabled`} on={e[id].enabled} onChange={(v) => save({ engines: { [id]: { enabled: v } } })} />
            {id === 'hermes' && <TextField label="hermes provider" width="w-28" value={e.hermes.provider} placeholder="openrouter" onSave={(v) => save({ engines: { hermes: { provider: v } } })} />}
            <TextField label={`${id} model`} width="w-48" value={e[id].model} placeholder={id === 'opencode' ? 'provider/model' : 'CLI default'} onSave={(v) => save({ engines: { [id]: { model: v } } })} />
            {has(o, id) && (
              <button type="button" onClick={() => reset(`engines.${id}`)} className="rounded bg-raised px-1.5 py-px text-[10px] text-muted hover:text-fg">
                reset
              </button>
            )}
          </EngineRow>
        ))}
      </Panel>

      <Panel title="Roles" hint="Which engine does what. A role on an engine that is turned off falls back to Claude.">
        <Row label="Implementer · lite" changed={has(ro?.implementer, 'lite')} onReset={() => reset('roles.implementer.lite')}>
          <Select label="lite implementer" value={r.implementer.lite} options={engineOptions} onChange={(v) => save({ roles: { implementer: { lite: v } } })} />
        </Row>
        <Row label="Implementer · full" changed={has(ro?.implementer, 'full')} onReset={() => reset('roles.implementer.full')}>
          <Select label="full implementer" value={r.implementer.full} options={engineOptions} onChange={(v) => save({ roles: { implementer: { full: v } } })} />
        </Row>
        {role('reviewer', [], 'Reviewer', 'The review pass on finished work, and the PRs you review.')}
        {role('supervisor', [{ value: 'opposite', label: 'opposite vendor' }, { value: 'off', label: 'off' }], 'Supervisor', 'Checks finished work against the ticket after mevo re-runs the gates.')}
        <Row label="Supervisor rounds" hint="How many times concerns go back to the implementer." changed={has(ro, 'supervisorRounds')} onReset={() => reset('roles.supervisorRounds')}>
          <NumberField label="supervisor rounds" value={r.supervisorRounds} onSave={(v) => v !== null && save({ roles: { supervisorRounds: Math.round(v) } })} />
        </Row>
        {role('visual', [], 'Visual check', 'The Run visual check button.')}
        {role('curator', [{ value: 'off', label: 'off' }], 'Learnings curator', 'Reads PR feedback once a day and proposes team rules.')}
      </Panel>
    </>
  )
}

function EngineRow({ id, label, status, always = false, children }: { id: string; label: string; status: NonNullable<Health['lanes']['engines']>[number] | undefined; always?: boolean; children?: ReactNode }) {
  const [result, setResult] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const test = async () => {
    setTesting(true)
    try {
      const r = await controls.testEngine(id)
      setResult(`${r.ok ? '✓' : '✕'} ${r.detail}${r.model ? ` · ${r.model}` : ''} · ${r.seconds}s`)
    } catch (err) {
      setResult(`✕ ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setTesting(false)
    }
  }
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-xs">
      <Dot ok={status ? status.installed && status.signedIn !== false : always ? true : null} />
      <span className="w-24 font-medium text-fg">{label}</span>
      <span className="min-w-0 flex-1 truncate text-dim">{status ? (status.installed ? `${status.version ?? 'installed'} · ${status.detail}` : 'not installed') : always ? 'always on' : 'off'}</span>
      <span className="flex flex-wrap items-center gap-2">
        {children}
        <Button variant="ghost" disabled={testing || !status?.installed} onClick={() => void test()}>
          {testing ? 'Testing…' : 'Test'}
        </Button>
      </span>
      {status && <EngineSetupBar id={id} status={status} />}
      {status && status.roles.length > 0 && (
        <span className="w-full pl-[22px] text-[11px] text-muted">
          {status.roles.join(' · ')}
        </span>
      )}
      {result && <span className="w-full pl-[22px] font-mono text-[11px] text-fg-2">{result}</span>}
    </div>
  )
}

function Integrations({ health, busy, run, view, save, reset }: { health: Health; busy: string | null; run: Run; view: SettingsView; save: (p: Patch) => void; reset: (k: string) => void }) {
  const sl = view.effective.slack
  const so = view.overrides.slack
  const slackCheck = health.slack ?? { ok: null, detail: 'add the Slack tokens to .env', at: null }
  const figmaCheck = health.figma ?? { ok: null, detail: 'add FIGMA_TOKEN to .env', at: null }
  return (
    <>
    <Panel
      title="Figma"
      hint="When a ticket links a Figma frame, the daemon renders it and reads its spec (sizes, spacing, colors, type, components) with your token, and the lane builds against it. The visual check and the supervisor compare the result with it. UI tickets without a link get a note."
    >
      <Row label="Use Figma links in tickets" hint={<span className={figmaCheck.ok === false ? 'text-bad' : ''}>{figmaCheck.detail}</span>} changed={has(view.overrides.figma, 'enabled')} onReset={() => reset('figma.enabled')}>
        <Toggle label="figma" on={view.effective.figma.enabled} onChange={(v) => save({ figma: { enabled: v } })} />
      </Row>
    </Panel>
    <Panel
      title="Slack"
      hint={
        <>
          <span className={slackCheck.ok === false ? 'text-bad' : ''}>{slackCheck.detail}</span>. Each part is its own switch. Tokens live in .env (SLACK_BOT_TOKEN, SLACK_USER_TOKEN, SLACK_USER_ID); see .env.example for the scopes.
        </>
      }
    >
      <Row label="Read linked threads" hint="A Slack thread linked in a ticket goes to the lane as context, like Linear comments." changed={has(so, 'threads')} onReset={() => reset('slack.threads')}>
        <Toggle label="slack threads" on={sl.threads} onChange={(v) => save({ slack: { threads: v } })} />
      </Row>
      <Row label="Notifications by DM" hint="What Telegram sends you, also as Slack DMs from the bot, with links to the PR, Linear and the app." changed={has(so, 'notify')} onReset={() => reset('slack.notify')}>
        <Toggle label="slack notifications" on={sl.notify} onChange={(v) => save({ slack: { notify: v } })} />
      </Row>
      <Row label="Post PRs ready for review" hint="When a PR of yours leaves draft (here or on GitHub), post it to this channel with its size, checks and Greptile score." changed={has(so, 'announce') || has(so, 'channel')} onReset={() => (reset('slack.announce'), reset('slack.channel'))}>
        <TextField label="slack channel" value={sl.channel} placeholder="#web-prs or C0123…" width="w-40" onSave={(v) => save({ slack: { channel: v } })} />
        <Toggle label="announce PRs" on={sl.announce} onChange={(v) => save({ slack: { announce: v } })} />
      </Row>
      <Row label="Roll call" hint="Your PRs waiting for review (link, Linear id, CI, who is asked or owes a re-review) go to Slack at these times, as the bot. If nothing changed since the last post in that channel, it skips. Times are this computer's. Post one by hand from Today." changed={has(so, 'rollCalls') || has(so, 'reviewSummaryAt')} onReset={() => (reset('slack.rollCalls'), reset('slack.reviewSummaryAt'))}>
        <RollCalls value={sl.rollCalls?.length ? sl.rollCalls : sl.reviewSummaryAt ? [{ at: sl.reviewSummaryAt, days: 'weekdays' }] : []} fallback={sl.channel} onSave={(rollCalls) => save({ slack: { rollCalls, reviewSummaryAt: '' } })} />
      </Row>
      <Row label="Auto nudge" hint="Reviewers to nudge get the DM by themselves (as you, the same text Nudge drafts): only in their working hours on weekdays (8:00 to 19:00 their time), at most once a day each, after the PR has waited 4 hours. Telegram tells you who was nudged. Needs SLACK_USER_TOKEN." changed={has(so, 'autoNudge')} onReset={() => reset('slack.autoNudge')}>
        <Toggle label="auto nudge" on={sl.autoNudge ?? false} onChange={(v) => save({ slack: { autoNudge: v } })} />
      </Row>
      <Row label="Summarize my mentions" hint="Every few minutes, threads where someone tagged you are read and summarized with what you should do, on Today and by DM and Telegram. Each summary is a small model call." changed={has(so, 'mentions')} onReset={() => reset('slack.mentions')}>
        <Toggle label="slack mentions" on={sl.mentions} onChange={(v) => save({ slack: { mentions: v } })} />
      </Row>
      <NightShiftRows value={sl.nightShift} changed={has(so, 'nightShift')} reset={() => reset('slack.nightShift')} save={(nightShift) => save({ slack: { nightShift } })} />
    </Panel>
    <motion.div variants={stagger} className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
      <Card title="Telegram bot" check={health.telegram} extra={health.telegram.bot}>
        <Button disabled={busy !== null} onClick={run('bot', () => controls.restartBot())}>
          {busy === 'bot' ? 'Restarting…' : 'Restart bot'}
        </Button>
      </Card>
      <Card title="Linear" check={health.linear} extra={health.linear.lastPollAt ? `last poll ${timeAgo(health.linear.lastPollAt)} ago · ${health.linear.tracked} tracked` : null}>
        <Button disabled={busy !== null} onClick={run('poll', () => controls.poll())}>
          {busy === 'poll' ? 'Polling…' : 'Poll now'}
        </Button>
      </Card>
      <Card title="GitHub" check={health.github} />
      {health.uploads && (
        <Card title="GitHub uploads" check={health.uploads} extra={health.uploads.login ? `browser profile signed in as ${health.uploads.login}` : 'screenshots and videos attach to PRs through a signed-in browser'}>
          <Button disabled={busy !== null} title="opens a Chrome window on the Mac" onClick={run('ghlogin', () => controls.githubLogin())}>
            {health.uploads.login ? 'Sign in again' : 'Sign in to GitHub'}
          </Button>
        </Card>
      )}
      <Card title="PR sync" check={health.prSync} />
      {health.mainSync && <Card title="Main sync" check={health.mainSync} extra="fetches main every few minutes; behind branches show an Update button" />}
      {health.reviews && <Card title="Review requests" check={health.reviews} extra="GitHub review requests and mentions, PR links in Linear mentions" />}
      <Card title="Claude" check={health.claude} />
      <Card title="E2E stack" check={health.e2e} extra={Object.entries(health.e2e.ports).map(([k, up]) => `${k} ${up ? '●' : '○'}`).join('  ') || null} />
      <Card title="Tunnel" check={health.tunnel} extra={health.tunnel.url}>
        {health.tunnel.url && (
          <Button variant="ghost" onClick={() => void navigator.clipboard.writeText(health.tunnel.url ?? '')}>
            Copy URL
          </Button>
        )}
        <ConfirmButton
          label="Sign out phones"
          confirm="Sign out every phone and browser"
          onConfirm={() => void controls.revokeSessions().then((r) => notice({ title: `Signed out ${r.revoked} session${r.revoked === 1 ? '' : 's'}`, detail: 'Telegram /tunnel gives a new one-time link', tone: 'accent' }), (e: unknown) => failed(e))}
        />
      </Card>
    </motion.div>
    </>
  )
}

function StatusTab({ health, busy, setBusy, run, refresh }: { health: Health; busy: string | null; setBusy: (b: string | null) => void; run: Run; refresh: () => Promise<void> }) {
  const checks: readonly [string, CheckState][] = [
    ['Telegram', health.telegram],
    ['Linear', health.linear],
    ['GitHub', health.github],
    ['Claude', health.claude],
    ['PR sync', health.prSync],
    ['E2E', health.e2e],
  ]
  return (
    <>
      <motion.section variants={rise} className="flex flex-wrap gap-x-5 gap-y-2 rounded-lg border border-line bg-panel px-4 py-3 text-xs">
        {checks.map(([name, c]) => (
          <span key={name} className="flex items-center gap-1.5" title={c.detail}>
            <Dot ok={c.ok} />
            {name}
          </span>
        ))}
        <span className="ml-auto text-muted">
          {health.lanes.active.length}/{health.lanes.max} lanes{health.lanes.paused ? ' · paused' : ''}
        </span>
      </motion.section>
      <StopEverything health={health} busy={busy} run={run} />
      {isDesktop && <DaemonProcessCard busy={busy} setBusy={setBusy} refresh={refresh} />}
    </>
  )
}

function Card({ title, check, extra, children }: { title: string; check: CheckState; extra?: string | null; children?: ReactNode }) {
  return (
    <motion.div
      variants={rise}
      layout
      whileHover={{ y: -2 }}
      className={`flex flex-col gap-2 rounded-lg border bg-panel px-4 py-3 transition-colors duration-500 ${check.ok === false ? 'border-[#4a2a2f]' : 'border-line'}`}
    >
      <div className="flex items-center gap-2">
        <Dot ok={check.ok} pulse />
        <span className="font-medium">{title}</span>
        {check.at && <span className="ml-auto text-[11px] text-dim">{timeAgo(check.at)} ago</span>}
      </div>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.p key={check.detail} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className={`text-xs leading-snug ${check.ok === false ? 'text-bad' : 'text-fg-2'}`}>
          {check.detail}
        </motion.p>
      </AnimatePresence>
      {extra && <Mono className="truncate text-muted">{extra}</Mono>}
      {children && <div className="flex gap-2">{children}</div>}
    </motion.div>
  )
}

function DaemonProcessCard({ busy, setBusy, refresh }: { busy: string | null; setBusy: (b: string | null) => void; refresh: () => Promise<void> }) {
  const [proc, setProc] = useState<DaemonProcess | null>(null)
  const [logs, setLogs] = useState<readonly string[]>([])
  const box = useRef<HTMLPreElement>(null)

  useEffect(() => {
    const tick = async () => {
      setProc(await desktop.status().catch(() => null))
      setLogs(await desktop.logs().catch(() => []))
    }
    void tick()
    const id = setInterval(() => void tick(), 2000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight
  }, [logs.length])

  const act = (key: string, fn: () => Promise<DaemonProcess>, confirmText?: string) => async () => {
    if (confirmText && !window.confirm(confirmText)) return
    setBusy(key)
    try {
      setProc(await fn())
      setTimeout(() => void refresh(), 2500)
    } catch (err) {
      failed(err)
    } finally {
      setBusy(null)
    }
  }
  const killWarning = 'Restarting the daemon stops any lane that is running right now. Continue?'

  return (
    <Section
      title="Daemon process"
      className="max-md:[&>div:first-child]:flex-col max-md:[&>div:first-child]:items-start max-md:[&>div:first-child]:gap-2"
      right={
        <div className="flex gap-2">
          {proc?.external ? null : proc?.running ? (
            <>
              <Button disabled={busy !== null} onClick={act('restart', desktop.restart, killWarning)}>
                {busy === 'restart' ? 'Restarting…' : 'Restart daemon'}
              </Button>
              <Button variant="danger" disabled={busy !== null} onClick={act('stop', desktop.stop, killWarning)}>
                Stop
              </Button>
            </>
          ) : (
            <Button variant="primary" disabled={busy !== null} onClick={act('start', desktop.start)}>
              {busy === 'start' ? 'Starting…' : 'Start daemon'}
            </Button>
          )}
        </div>
      }
    >
      <div className="flex items-center gap-2 text-xs text-fg-2">
        <Dot ok={proc?.running ?? null} pulse />
        {proc?.external
          ? 'running from a terminal · stop it there (Ctrl+C) to let the app manage it'
          : proc?.running
            ? `running · pid ${proc.pid} · since ${proc.startedAt ? new Date(proc.startedAt).toLocaleTimeString([], { hour12: false }) : '—'}`
            : `stopped${proc?.exitCode != null ? ` · exit ${proc.exitCode}` : ''}`}
        {proc && <Mono className="ml-auto text-dim">{proc.root}</Mono>}
      </div>
      <pre ref={box} className="h-56 overflow-auto rounded-lg border border-line bg-sunk px-3 py-2.5 font-mono text-[11px] leading-[1.6] whitespace-pre-wrap text-muted">
        {logs.length ? logs.join('\n') : 'no output yet'}
      </pre>
    </Section>
  )
}

// The emergency brake: every lane killed and parked with a RESUME.md, the queue paused, and
// data/pending.md listing what is left. Optionally the daemon goes down too.
function StopEverything({ health, busy, run }: { health: Health; busy: string | null; run: (key: string, fn: () => Promise<unknown>) => () => Promise<void> }) {
  const [result, setResult] = useState<string | null>(null)
  const go = (shutdown: boolean) =>
    run(shutdown ? 'shutdown' : 'stopall', async () => {
      const r = await controls.stopAll(shutdown)
      setResult(shutdown ? 'Stopped. The daemon is shutting down.' : `Stopped ${r.stopped.length ? r.stopped.join(', ') : 'nothing (no lane was running)'}. Lanes are paused. Pending work: ${r.pending}`)
    })
  return (
    <motion.section variants={rise} className="flex flex-wrap items-center gap-3 rounded-lg border border-[#4a2a2f] bg-[#1b1416] px-4 py-3">
      <div className="min-w-0 flex-1">
        <h2 className="text-sm font-medium">Stop everything</h2>
        <p className="text-xs text-muted">
          {health.lanes.active.length ? `${health.lanes.active.length} lane(s) running.` : 'No lane running.'} Kills every lane and the dev servers it started, saves a RESUME.md per ticket, pauses the queue and writes data/pending.md.
        </p>
        {result && <p className="mt-1 text-xs text-fg-2">{result}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        <ConfirmButton variant="danger" label="Stop all lanes" confirm="Yes, stop them" disabled={busy !== null} onConfirm={() => void go(false)()} />
        <ConfirmButton variant="ghost" label="Stop and shut down" confirm="Yes, shut down" disabled={busy !== null} onConfirm={() => void go(true)()} />
      </div>
    </motion.section>
  )
}

// Install from mevo, sign in in your terminal (it is interactive), or copy either command.
function EngineSetupBar({ id, status }: { id: string; status: NonNullable<Health['lanes']['engines']>[number] }) {
  const setup = ENGINE_SETUP[id]
  const [job, setJob] = useState<EngineSetupStatus | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  useEffect(() => {
    if (job?.state !== 'installing') return
    const t = setInterval(async () => {
      const all = await controls.engineSetup().catch(() => [])
      const mine = all.find((s) => s.id === id)
      if (mine) setJob(mine)
      if (mine && mine.state !== 'installing') await controls.probe().catch(() => undefined)
    }, 1500)
    return () => clearInterval(t)
  }, [job?.state, id])
  if (!setup) return null
  const needsInstall = !status.installed
  const needsLogin = status.installed && status.signedIn === false
  const copy = async (cmd: string) => {
    try {
      await navigator.clipboard.writeText(cmd)
      setCopied(cmd)
      setTimeout(() => setCopied(null), 1500)
    } catch {
      setNote(cmd)
    }
  }
  const term = async (step: 'install' | 'login') => {
    try {
      const r = await controls.engineTerminal(id, step)
      setNote(step === 'login' ? `Opened ${r.app}. Sign in there${setup.loginHint ? ` (${setup.loginHint})` : ''}, then press Check again.` : `Opened ${r.app} with the install running.`)
    } catch (err) {
      failed(err)
    }
  }
  const install = async () => {
    try {
      setJob((await controls.installEngine(id)).status)
    } catch (err) {
      failed(err)
    }
  }
  const cmd = (c: string) => (
    <span className="flex min-w-0 items-center gap-1.5">
      <Mono className="truncate rounded bg-sunk px-1.5 py-0.5 text-fg-2">{c}</Mono>
      <button type="button" className="shrink-0 text-accent-fg hover:underline" onClick={() => void copy(c)}>
        {copied === c ? 'copied' : 'copy'}
      </button>
    </span>
  )
  if (!needsInstall && !needsLogin && job?.state !== 'failed') {
    return setup.login ? (
      <span className="w-full pl-[22px] text-[11px] text-dim">
        <button type="button" className="hover:text-fg" onClick={() => void term('login')}>
          Sign in again
        </button>
        {note && <span className="ml-2 text-fg-2">{note}</span>}
      </span>
    ) : null
  }
  return (
    <div className="ml-[22px] flex w-full flex-col gap-2 rounded-md border border-[#3d3522] bg-[#1a1812] px-3 py-2.5">
      <span className="text-[11.5px] text-warn">{needsInstall ? 'Turned on but not installed on this Mac: its roles fall back to another engine until you install it.' : 'Installed but not signed in.'}</span>
      {needsInstall && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-muted">1. Install</span>
          {cmd(setup.install)}
          <ConfirmButton
            variant="default"
            disabled={job?.state === 'installing'}
            label={job?.state === 'installing' ? 'Installing…' : 'Install'}
            confirm={`Run "${setup.install}" from ${installSource(setup.install)}`}
            onConfirm={() => void install()}
          />
          <Button variant="ghost" onClick={() => void term('install')}>
            In my terminal
          </Button>
        </div>
      )}
      {setup.login && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-muted">{needsInstall ? '2.' : '1.'} Sign in</span>
          {cmd(setup.login)}
          <Button variant={needsLogin ? 'primary' : 'default'} disabled={needsInstall && job?.state !== 'done'} onClick={() => void term('login')}>
            Sign in in my terminal
          </Button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button variant="ghost" onClick={() => void controls.probe()}>
          Check again
        </Button>
        {job?.state === 'done' && <span className="text-[11px] text-ok">Installed.{setup.login ? ' Now sign in.' : ''}</span>}
        {job?.state === 'failed' && <span className="text-[11px] text-bad">The install failed. Try it in your terminal.</span>}
      </div>
      {job && job.output.trim() && job.state !== 'done' && <pre className="max-h-32 overflow-auto rounded bg-sunk px-2 py-1.5 font-mono text-[10.5px] whitespace-pre-wrap text-muted">{job.output.trim().split('\n').slice(-12).join('\n')}</pre>}
      {note && <span className="text-[11px] text-fg-2">{note}</span>}
    </div>
  )
}

// where an install command downloads from, said before it runs
function installSource(cmd: string): string {
  const url = /https?:\/\/([^/\s]+)/.exec(cmd)?.[1]
  if (url) return url
  if (/^npm i/.test(cmd)) return `npm (${cmd.split(' ').pop() ?? ''})`
  return 'your shell'
}

// The Roll call times: each with its days and, if not the default one, its channel.
function RollCalls({ value, fallback, onSave }: { value: readonly RollCall[]; fallback: string; onSave: (v: RollCall[]) => void }) {
  const [list, setList] = useState<RollCall[]>(() => [...value])
  useEffect(() => setList([...value]), [value])
  const field = 'rounded-md border border-line-2 bg-bg px-2 py-1 text-xs text-fg outline-none focus:border-accent'
  const change = (i: number, patch: Partial<RollCall>) => setList((l) => l.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  const dirty = JSON.stringify(list) !== JSON.stringify(value)
  return (
    <div className="flex flex-col gap-1.5">
      {list.map((rc, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1.5">
          <input type="time" aria-label="time" value={rc.at} onChange={(e) => change(i, { at: e.target.value })} className={`${field} w-[7.5rem]`} />
          <select aria-label="days" value={rc.days} onChange={(e) => change(i, { days: e.target.value as RollCall['days'] })} className={field}>
            <option value="weekdays">Weekdays</option>
            <option value="daily">Every day</option>
          </select>
          <input aria-label="channel" value={rc.channel ?? ''} placeholder={fallback || '#channel'} onChange={(e) => change(i, e.target.value.trim() ? { channel: e.target.value } : { channel: '' })} className={`${field} w-36`} />
          <button type="button" aria-label="remove this time" className="px-1 text-muted hover:text-bad" onClick={() => setList((l) => l.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        {list.length < 6 && (
          <button type="button" className="text-xs text-accent-fg hover:underline" onClick={() => setList((l) => [...l, { at: '09:00', days: 'weekdays' }])}>
            + Add a time
          </button>
        )}
        {dirty && (
          <Button variant="primary" onClick={() => onSave(list.filter((x) => /^\d{2}:\d{2}$/.test(x.at)).map(({ channel, ...x }) => (channel?.trim() ? { ...x, channel: channel.trim() } : x)))}>
            Save
          </Button>
        )}
      </div>
    </div>
  )
}

const NIGHT_DEFAULTS: NightShiftConfig = { enabled: false, mode: 'shadow', from: '22:00', to: '07:30', days: 'daily', followSlack: true, wake: [], dmAsMe: false }

// Night Shift: when it runs, what the bot may post by itself, and what wakes you.
function NightShiftRows({ value, changed, reset, save }: { value: Partial<NightShiftConfig> | undefined; changed: boolean; reset: () => void; save: (p: Partial<NightShiftConfig>) => void }) {
  const ns = { ...NIGHT_DEFAULTS, ...value }
  const field = 'rounded-md border border-line-2 bg-bg px-2 py-1 text-xs text-fg outline-none focus:border-accent'
  return (
    <>
      <Row
        label="Night Shift"
        hint="While you are away, mevo reads your mentions and DMs, sorts them (FYI, it can answer from your tickets and PRs, needs you, urgent) and drafts what its bot would say, always labelled as your assistant. Post factual answers: it posts the answers it can give from your work, and once per thread a “noted, you will see this when back” for what needs you. It never writes as you, approves, merges or promises dates. When you are back you get the morning handoff on Today and Telegram. Needs the bot's chat:write and your token's im:history, im:read, users:read, users.profile:read."
        changed={changed}
        onReset={reset}
      >
        <Select label="night shift mode" value={ns.mode} options={[{ value: 'shadow', label: 'Drafts only' }, { value: 'facts', label: 'Post factual answers' }]} onChange={(v) => save({ mode: v as NightShiftConfig['mode'] })} />
        <Toggle label="night shift" on={ns.enabled} onChange={(v) => save({ enabled: v })} />
      </Row>
      {ns.enabled && (
        <>
          <Row label="Away hours" hint="This computer's time. From after To crosses midnight. Outside them, your switch on Today still turns it on.">
            <input type="time" aria-label="from" value={ns.from} onChange={(e) => /^\d{2}:\d{2}$/.test(e.target.value) && save({ from: e.target.value })} className={`${field} w-[7.5rem]`} />
            <span className="text-xs text-muted">to</span>
            <input type="time" aria-label="to" value={ns.to} onChange={(e) => /^\d{2}:\d{2}$/.test(e.target.value) && save({ to: e.target.value })} className={`${field} w-[7.5rem]`} />
            <Select label="night shift days" value={ns.days} options={[{ value: 'daily', label: 'Every day' }, { value: 'weekdays', label: 'Weekdays' }]} onChange={(v) => save({ days: v as NightShiftConfig['days'] })} />
          </Row>
          <Row label="Follow my Slack status" hint="Also on while Slack shows you away, or your status is 🌙, “night shift” or “ooo”.">
            <Toggle label="follow slack status" on={ns.followSlack} onChange={(v) => save({ followSlack: v })} />
          </Row>
          <Row label="Answer DMs from my account" hint="A DM is answered in that same conversation, from your account, always starting with “This is mevo, your assistant, writing from your account: you are on Night Shift”. In Post factual answers mode it answers questions about your work and, once per person, says the rest waits for you. Off: the bot answers them in their own DM with the bot.">
            <Toggle label="answer DMs from my account" on={ns.dmAsMe} onChange={(v) => save({ dmAsMe: v })} />
          </Row>
          <Row label="Wake me for" hint="Messages with these words or names are urgent and reach you on Telegram right away, whatever the model thinks. Comma separated.">
            <TextField label="wake words" value={ns.wake.join(', ')} placeholder="prod, down, dom" onSave={(v) => save({ wake: v.split(',').map((w) => w.trim()).filter(Boolean).slice(0, 20) })} />
          </Row>
        </>
      )}
    </>
  )
}
