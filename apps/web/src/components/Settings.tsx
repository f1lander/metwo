import type { CheckState, Effort, Health, PlanFirst, SettingsView } from '@ticketflow/shared'
import { AnimatePresence, motion } from 'motion/react'
import { Fragment, type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { controls, loadSettings } from '../lib/api.js'
import { href, type SettingsTab } from '../lib/route.js'
import { type DaemonProcess, desktop, isDesktop } from '../lib/tauri.js'
import { modelName } from './status.js'
import { Button, ConfirmButton, Count, Dot, Mono, rise, Section, stagger, timeAgo } from './ui.js'
import { failed } from '../lib/notice.js'

const TABS: readonly { id: SettingsTab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'budget', label: 'Budget' },
  { id: 'engines', label: 'Engines' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'status', label: 'Status' },
]

type Patch = Parameters<typeof controls.saveSettings>[0]
type Run = (key: string, fn: () => Promise<unknown>) => () => Promise<void>

// Everything you can change while metwo runs. Changes are saved in data/state.json and win over
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
          <Integrations health={health} busy={busy} run={run} />
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
        <Row label="Triage the cycle by itself" hint="AI sizes new and edited cycle issues a few times a day. Off: only when you press Triage. Each run counts in the budget." changed={has(view.overrides, 'triage')} onReset={() => reset('triage')}>
          <Toggle label="auto triage" on={view.effective.triage?.auto ?? false} onChange={(v) => save({ triage: { auto: v } })} />
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
      </Panel>
    </>
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
      <Panel title="Engines" hint="Each one is a CLI on this Mac, signed in with your account. Install and sign in first (docs/engines.md), then turn it on here.">
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
        {role('supervisor', [{ value: 'opposite', label: 'opposite vendor' }, { value: 'off', label: 'off' }], 'Supervisor', 'Checks finished work against the ticket after metwo re-runs the gates.')}
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
      <span className="min-w-0 flex-1 truncate text-dim">{status ? `${status.version ?? 'not installed'} · ${status.detail}` : always ? 'always on' : 'off'}</span>
      <span className="flex flex-wrap items-center gap-2">
        {children}
        <Button variant="ghost" disabled={testing || !status?.installed} onClick={() => void test()}>
          {testing ? 'Testing…' : 'Test'}
        </Button>
      </span>
      {status && status.roles.length > 0 && (
        <span className="w-full pl-[22px] text-[11px] text-muted">
          {status.roles.join(' · ')}
        </span>
      )}
      {result && <span className="w-full pl-[22px] font-mono text-[11px] text-fg-2">{result}</span>}
    </div>
  )
}

function Integrations({ health, busy, run }: { health: Health; busy: string | null; run: Run }) {
  return (
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
      </Card>
    </motion.div>
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
