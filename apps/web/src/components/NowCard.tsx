import { type BudgetStatus, type LiveLine, type Estimate, fmtMinutes, type Health, minutesRange, usdRange, liveSpend, openComments, reportsCost, runStartedAt, type StartChoice, type Ticket, usd } from '@ticketflow/shared'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { actions } from '../lib/api.js'
import { laneOf, readConfirmRule, SENSITIVE, useEstimates, useNow, writeConfirmRule, type ConfirmRule } from '../lib/estimates.js'
import { failed } from '../lib/notice.js'
import { useTriage } from '../lib/triage.js'
import { canMarkReady, greptileClear, modelName, priorityLabel } from './status.js'
import { Button, ConfirmButton } from './ui.js'

type Run = (fn: () => Promise<unknown>) => () => Promise<void>

const LANE_NAME: Record<StartChoice, string> = { lite: 'Lite', full: 'Full', max: 'Max' }

export const estLine = (e: Estimate | null, costs = true) => (e ? [minutesRange(e.minutes), costs && e.cost ? usdRange(e.cost) : null].filter(Boolean).join(' · ') : null)

// Elapsed against the estimate for the lane that is running; amber once past its upper end.
export function useRunClock(t: Ticket) {
  const now = useNow(t.status === 'running' ? 10_000 : 600_000)
  const est = useEstimates(t)[laneOf(t)]
  const since = runStartedAt(t)
  const elapsed = since && t.status === 'running' ? (now - new Date(since).getTime()) / 60000 : null
  const spend = liveSpend(t, est?.rate ?? null, now)
  const over = elapsed !== null && est ? elapsed > est.minutes[1] : false
  const quietFor = t.stage ? (now - new Date(t.stage.at).getTime()) / 60000 : null
  return { est, elapsed, spend, over, quietFor, now }
}

// The card under the stepper: what is happening now, what you do next, or how to start.
export function NowCard({ ticket: t, busy, run, budget, engines, last }: { ticket: Ticket; busy: boolean; run: Run; budget?: BudgetStatus | undefined; engines: NonNullable<Health['lanes']['engines']>; last?: LiveLine | undefined }) {
  if (t.status === 'assigned') return <StartPanel ticket={t} busy={busy} run={run} budget={budget} engines={engines} />
  if (t.status === 'running' || t.status === 'queued') return <RunCard ticket={t} busy={busy} run={run} last={last} />
  return <NextCard ticket={t} busy={busy} run={run} engines={engines} />
}

function Frame({ label, tone = 'accent', children }: { label: string; tone?: 'accent' | 'warn' | 'bad' | 'ok'; children: React.ReactNode }) {
  const cls = {
    accent: 'border-accent/40 bg-accent/[.06] [--k:var(--color-accent-fg)]',
    warn: 'border-[#3d3522] bg-[#1a1812] [--k:var(--color-warn)]',
    bad: 'border-[#4a2a2f] bg-[#1b1416] [--k:var(--color-bad)]',
    ok: 'border-line bg-panel [--k:var(--color-ok)]',
  }[tone]
  return (
    <motion.section layout className={`flex flex-col gap-3 rounded-xl border px-4 py-3.5 ${cls}`}>
      <span className="text-[11px] font-medium tracking-wide text-[var(--k)] uppercase">{label}</span>
      {children}
    </motion.section>
  )
}

function RunCard({ ticket: t, busy, run, last }: { ticket: Ticket; busy: boolean; run: Run; last?: LiveLine | undefined }) {
  const { est, elapsed, spend, over, quietFor } = useRunClock(t)
  if (t.status === 'queued') {
    return (
      <Frame label="Queued">
        <p className="text-[13px] text-fg-2">Waiting for a free lane slot. It starts on its own.</p>
        <div className="flex gap-2">
          <ConfirmButton variant="default" label="Stop" confirm={`Take ${t.id} out of the queue`} disabled={busy} onConfirm={() => void run(() => actions.stop(t))()} />
        </div>
      </Frame>
    )
  }
  const pct = elapsed !== null && est ? Math.min(1, elapsed / est.minutes[1]) : null
  return (
    <Frame label={`Now · ${t.stage?.phase === 'review' ? 'review pass' : t.stage?.phase === 'checks' ? 'gates + supervisor' : 'implementing'}`} tone={over ? 'warn' : 'accent'}>
      <div className="flex flex-col gap-1">
        <span className="truncate font-mono text-[13px] leading-snug text-fg" title={last?.text}>
          {last ? `→ ${last.text.split('\n')[0]}` : 'starting…'}
        </span>
        <span className="text-xs text-muted">
          {[t.lane, t.model ? modelName(t.model) : null, t.effort].filter(Boolean).join(' · ')}
          {quietFor !== null && quietFor >= 1 ? ` · ${fmtMinutes(quietFor)} in this step` : ''}
          {last ? ` · last line ${ago(last.at)}` : ''}
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 text-xs text-muted">
          <span>
            <strong className={`font-medium ${over ? 'text-warn' : 'text-fg'}`}>{elapsed !== null ? fmtMinutes(elapsed) : '…'}</strong>
            {est ? ` of ~${fmtMinutes(est.minutes[1])}` : ' elapsed'}
            {over ? ' · over the estimate' : ''}
          </span>
          <span title={spend?.approx ? 'cost of finished turns, plus the time since at your usual $/min' : 'what the finished turns reported'}>
            {spend ? (
              <>
                <strong className="font-medium text-fg">
                  {spend.approx ? '≈ ' : ''}
                  {usd(spend.usd)}
                </strong>{' '}
                so far
              </>
            ) : reportsCost(t) ? (
              'cost shows after the first turn'
            ) : (
              'no cost reported by this engine'
            )}
          </span>
        </div>
        <div className="h-1 overflow-hidden rounded-full bg-line">
          {pct !== null ? (
            <motion.div className={`h-1 rounded-full ${over ? 'bg-warn' : 'bg-accent'}`} initial={false} animate={{ width: `${pct * 100}%` }} />
          ) : (
            <motion.div className="h-1 w-1/4 rounded-full bg-accent/70" animate={{ x: ['-100%', '400%'] }} transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }} />
          )}
        </div>
        {!est && <span className="text-[11px] text-dim">No estimate yet: it needs 5 finished runs like this one.</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={over ? 'primary' : 'default'}
          disabled={busy}
          aria-pressed={Boolean(t.pauseAfter)}
          title="lets the current step finish, then stops before the next one; resume picks up from there"
          onClick={run(() => actions.pauseAfter(t, !t.pauseAfter))}
        >
          {t.pauseAfter ? 'Pausing after this step · undo' : 'Pause after this step'}
        </Button>
        <ConfirmButton variant="default" label="Stop now" confirm={`Stop ${t.id}: kill the lane, keep a resume note`} disabled={busy} onConfirm={() => void run(() => actions.stop(t))()} />
      </div>
    </Frame>
  )
}

function nextLine(t: Ticket): { label: string; text: string; tone: 'warn' | 'bad' | 'ok' | 'accent' } {
  switch (t.status) {
    case 'needs_input':
      return { label: 'The lane is asking', text: t.question ?? '', tone: 'warn' }
    case 'failed':
      return { label: 'It failed', text: t.failure?.title ?? t.error ?? 'The lane stopped with an error.', tone: 'bad' }
    case 'stopped':
      return { label: t.stopped?.reason.startsWith('paused') ? 'Paused' : 'Stopped', text: `${t.stopped?.reason ?? 'Stopped'}. Where it was is saved in RESUME.md; resume continues the same session.`, tone: 'warn' }
    case 'review_ready':
      return { label: 'Next step', text: t.prUrl || t.pr ? 'Look at the changes, then push them to the PR.' : 'Look at the changes, then push. It opens a draft PR with your GitHub account.', tone: 'warn' }
    case 'no_change':
      return { label: 'Next step', text: 'The lane thinks nothing needs to change. Read why in Overview, then close it in Linear or retry.', tone: 'warn' }
    case 'pr_draft': {
      const open = openComments(t).length
      if (t.pr?.ci === 'failure') return { label: 'Next step', text: 'CI is failing on the PR. Open the checks, or tell the agent what to fix.', tone: 'bad' }
      if (open) return { label: 'Next step', text: `${open} comment${open === 1 ? '' : 's'} on the PR to deal with. Pick them in Comments.`, tone: 'warn' }
      if (t.behindMain?.conflicts) return { label: 'Next step', text: 'Main moved and conflicts with this branch. Update from main.', tone: 'warn' }
      if (canMarkReady(t)) return { label: 'Next step', text: greptileClear(t) ? 'Greptile is clear. Mark it ready so teammates can review.' : 'Mark it ready for review when you are happy with it.', tone: 'accent' }
      if (t.pr?.state === 'MERGED') return { label: 'Merged', text: 'Merged on GitHub. Move it to QA or Done in Linear.', tone: 'ok' }
      return { label: 'Waiting', text: 'Waiting on review. metwo tells you when something comes in.', tone: 'ok' }
    }
    case 'done':
      return { label: 'Done', text: 'Closed.', tone: 'ok' }
    case 'skipped':
      return { label: 'Skipped', text: 'Skipped. Start it again whenever you want.', tone: 'ok' }
    default:
      return { label: 'Next step', text: '', tone: 'accent' }
  }
}

function NextCard({ ticket: t, busy, run, engines }: { ticket: Ticket; busy: boolean; run: Run; engines: NonNullable<Health['lanes']['engines']> }) {
  const [answer, setAnswer] = useState('')
  const n = nextLine(t)
  return (
    <Frame label={n.label} tone={n.tone}>
      {n.text && <p className={`text-[13.5px] leading-relaxed ${t.status === 'needs_input' ? 'whitespace-pre-wrap text-fg-2' : 'text-fg'}`}>{n.text}</p>}
      {t.status === 'failed' && t.failure && (
        <>
          <p className="text-xs leading-relaxed text-fg-2">{t.failure.hint}</p>
          <pre className="max-h-28 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-muted">{t.failure.detail}</pre>
        </>
      )}
      {t.status === 'needs_input' && (
        <>
          <label htmlFor="answer" className="sr-only">
            Your answer
          </label>
          <textarea
            id="answer"
            rows={3}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            className="rounded-md border border-line-2 bg-bg px-3 py-2 text-[13px] outline-none transition-colors focus:border-accent max-md:text-[16px]"
          />
          <Button variant="primary" className="self-start" disabled={busy || !answer.trim()} onClick={run(() => actions.answer(t, answer))}>
            Send answer
          </Button>
        </>
      )}
      <NextActions ticket={t} busy={busy} run={run} engines={engines} />
    </Frame>
  )
}

function NextActions({ ticket: t, busy, run, engines }: { ticket: Ticket; busy: boolean; run: Run; engines: NonNullable<Health['lanes']['engines']> }) {
  const [engine, setEngine] = useState('')
  const retry = t.status === 'failed' || t.status === 'no_change' || t.status === 'skipped'
  const go = (lane: StartChoice) => run(() => actions.start(t, lane, engine || undefined))
  const pushing = Boolean(t.pushing && !t.pushing.error)
  return (
    <div className="flex flex-wrap items-center gap-2">
      {t.status === 'stopped' && (
        <Button variant="primary" disabled={busy} title="continues the same session from RESUME.md" onClick={run(() => actions.resume(t))}>
          Resume
        </Button>
      )}
      {t.status === 'review_ready' && (
        <Button variant="primary" disabled={busy || pushing} onClick={run(() => actions.push(t))}>
          {pushing ? 'Pushing…' : t.pushing?.error ? 'Try the push again' : t.prUrl || t.pr ? 'Push to the PR' : 'Push + draft PR'}
        </Button>
      )}
      {t.behindMain && (
        <Button
          variant={t.status === 'pr_draft' && t.behindMain.conflicts ? 'primary' : 'default'}
          disabled={busy}
          title={t.behindMain.conflicts ? 'merging main conflicts; the lane resolves them and comes back for your review' : 'merges main, re-runs the gates, pushes to the PR if green'}
          onClick={run(() => actions.updateMain(t))}
        >
          Update from main · {t.behindMain.commits} behind{t.behindMain.conflicts ? ', conflicts' : ''}
        </Button>
      )}
      {canMarkReady(t) && (
        <Button variant={greptileClear(t) ? 'primary' : 'default'} disabled={busy} title="takes the PR out of draft so teammates can review it" onClick={run(() => actions.ready(t))}>
          Ready for review
        </Button>
      )}
      {(t.status === 'pr_draft' || t.status === 'no_change') && (
        <>
          <Button variant={t.status === 'pr_draft' && !canMarkReady(t) ? 'primary' : 'default'} disabled={busy} onClick={run(() => actions.moveInLinear(t, 'qa'))}>
            Move to QA
          </Button>
          <Button variant={t.status === 'no_change' ? 'primary' : 'default'} disabled={busy} onClick={run(() => actions.moveInLinear(t, 'done'))}>
            Done in Linear
          </Button>
        </>
      )}
      {retry && (
        <>
          <Button disabled={busy} onClick={go('lite')}>
            Retry lite
          </Button>
          <Button disabled={busy} onClick={go('full')}>
            Retry full
          </Button>
          <Button disabled={busy} onClick={go('max')}>
            Retry max
          </Button>
          <EnginePicker engines={engines} value={engine} onChange={setEngine} />
        </>
      )}
      {(t.status === 'failed' || t.status === 'no_change' || t.status === 'stopped') && (
        <Button variant="ghost" disabled={busy} onClick={run(() => actions.done(t))}>
          Dismiss
        </Button>
      )}
      {t.status === 'review_ready' && (
        <ConfirmButton variant="ghost" label="Discard" confirm={`Discard the work on ${t.id}`} disabled={busy} onConfirm={() => void run(() => actions.skip(t))()} />
      )}
      {t.pushing && <p className={`w-full text-xs leading-snug ${t.pushing.error ? 'text-bad' : 'text-muted'}`}>{t.pushing.error ?? `${t.pushing.step}…`}</p>}
    </div>
  )
}

function EnginePicker({ engines, value, onChange }: { engines: NonNullable<Health['lanes']['engines']>; value: string; onChange: (v: string) => void }) {
  const installed = engines.filter((e) => e.installed)
  if (installed.length < 2) return null
  return (
    <label className="flex items-center gap-1.5 text-xs text-muted">
      on
      <select value={value} onChange={(e) => onChange(e.target.value)} className="rounded-md border border-line-2 bg-bg px-2 py-1.5 text-xs text-fg outline-none focus:border-accent">
        <option value="">default (lane setting)</option>
        {installed.map((e) => (
          <option key={e.id} value={e.id}>
            {e.label}
          </option>
        ))}
      </select>
    </label>
  )
}

interface Check {
  readonly ok: boolean | null
  readonly text: string
}

// What could make starting this one a bad idea; any ⚠ (or an estimate over your limits) asks first.
export function safetyChecks(t: Ticket, est: Estimate | null, budget: BudgetStatus | undefined): readonly Check[] {
  const sensitive = t.labels.filter((l) => SENSITIVE.test(l))
  const p = priorityLabel(t.priority)
  const out: Check[] = [sensitive.length ? { ok: false, text: `${sensitive.join(', ')} label: read the diff closely` } : { ok: true, text: 'no sensitive label' }]
  if (budget?.day.limit) {
    const left = budget.day.limit - budget.day.spent
    const need = est?.cost?.[1] ?? 0
    out.push(need > left ? { ok: false, text: `budget: ${usd(budget.day.spent)} of ${usd(budget.day.limit)} today, this may not fit` } : { ok: true, text: `budget: ${usd(budget.day.spent)} of ${usd(budget.day.limit)} today, this fits` })
  }
  if (p === 'Urgent' || p === 'High') out.push({ ok: null, text: `${p} priority: nothing is pushed until you review it` })
  return out
}

function overRule(est: Estimate | null, rule: ConfirmRule): string | null {
  if (!rule.enabled || !est) return null
  if (est.minutes[1] > rule.minutes) return `estimated up to ${fmtMinutes(est.minutes[1])}`
  if (est.cost && est.cost[1] > rule.usd) return `estimated up to ${usd(est.cost[1])}`
  return null
}

function StartPanel({ ticket: t, busy, run, budget, engines }: { ticket: Ticket; busy: boolean; run: Run; budget?: BudgetStatus | undefined; engines: NonNullable<Health['lanes']['engines']> }) {
  const est = useEstimates(t)
  const triage = useTriage(t.id)
  const [engine, setEngine] = useState('')
  const [rule, setRule] = useState<ConfirmRule>(readConfirmRule)
  const [asking, setAsking] = useState<{ lane: StartChoice; why: string[] } | null>(null)
  const any = est[t.suggestedLane] ?? est.lite ?? est.full ?? est.max
  const basis = any ? `from your last ${any.n} ${any.lane} runs on similar tickets (${any.basis})` : null

  const start = (lane: StartChoice, force = false) => {
    const checks = safetyChecks(t, est[lane], budget)
    const why = [overRule(est[lane], rule), ...checks.filter((c) => c.ok === false).map((c) => c.text)].filter((x): x is string => Boolean(x))
    if (!force && why.length) {
      setAsking({ lane, why })
      return
    }
    setAsking(null)
    void run(() => actions.start(t, lane, engine || undefined))()
  }
  const toggle = (enabled: boolean) => {
    const next = { ...rule, enabled }
    setRule(next)
    writeConfirmRule(next)
  }
  const checks = safetyChecks(t, est[t.suggestedLane], budget)

  return (
    <Frame label="Before you start">
      <div className="flex flex-col gap-1">
        <span className="text-[14.5px] leading-snug font-medium">
          Suggested: {t.suggestedLane} lane{t.reason ? ` · ${t.reason.replace(/\.$/, '')}` : ''}
        </span>
        {triage && <span className="text-xs text-muted">Triage: {triage.why}</span>}
        <span className="text-[11.5px] text-dim">{basis ? `Estimates ${basis}. No AI used.` : 'No estimates yet: they show after 5 finished runs like this one.'}</span>
      </div>
      <div className="grid grid-cols-3 gap-2.5 max-sm:grid-cols-1">
        {(['lite', 'full', 'max'] as const).map((lane) => {
          const e = est[lane]
          const pick = lane === t.suggestedLane
          return (
            <div key={lane} className={`flex flex-col gap-1.5 rounded-lg border px-3 py-2.5 ${pick ? 'border-accent bg-accent/10' : 'border-line-2 bg-panel'}`}>
              <span className="font-semibold">
                {LANE_NAME[lane]} {pick && <span className="text-[11px] font-normal text-accent-fg">suggested</span>}
              </span>
              <span className="text-xs text-fg-2">{estLine(e) ?? (lane === 'max' ? 'full lane at max effort' : 'no estimate yet')}</span>
              <span className="text-[11px] text-muted">{e ? `came back clean ${e.clean.ok} of ${e.clean.of} times` : lane === 'max' ? 'slower, deeper; only when you ask' : `${lane === 'lite' ? 'one pass, quick fixes' : 'review pass + supervisor'}`}</span>
              <Button variant={pick ? 'primary' : 'default'} className="mt-1" disabled={busy} onClick={() => start(lane)}>
                Start {lane}
              </Button>
            </div>
          )
        })}
      </div>
      <AnimatePresence initial={false}>
        {asking && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div role="alertdialog" aria-label="confirm start" className="flex flex-col gap-2 rounded-lg border border-[#3d3522] bg-[#1a1812] px-3 py-2.5">
              <span className="text-[13px] font-medium text-warn">Start {asking.lane} anyway?</span>
              <ul className="text-xs leading-relaxed text-fg-2">
                {asking.why.map((w) => (
                  <li key={w}>⚠ {w}</li>
                ))}
              </ul>
              <div className="flex gap-2">
                <Button variant="primary" disabled={busy} onClick={() => start(asking.lane, true)}>
                  Start {asking.lane}
                </Button>
                <Button variant="ghost" onClick={() => setAsking(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="flex flex-col gap-1.5 border-t border-line-2 pt-2.5">
        <span className="text-xs font-medium">Safety check</span>
        <span className="text-xs leading-relaxed text-fg-2">
          {checks.map((c, i) => (
            <span key={c.text}>
              {i > 0 && ' · '}
              <span className={c.ok === false ? 'text-warn' : c.ok === null ? 'text-fg-2' : 'text-fg-2'}>{c.ok === false ? '⚠' : c.ok === null ? '•' : '✓'}</span> {c.text}
            </span>
          ))}
        </span>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <label className="flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={rule.enabled} onChange={(e) => toggle(e.target.checked)} className="accent-[#7c5cff]" />
            Ask me before starting one estimated over {rule.minutes} min or {usd(rule.usd)}
          </label>
          <EnginePicker engines={engines} value={engine} onChange={setEngine} />
          <Button variant="ghost" className="ml-auto" disabled={busy} onClick={run(() => actions.skip(t))}>
            Skip
          </Button>
        </div>
      </div>
    </Frame>
  )
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`
}
