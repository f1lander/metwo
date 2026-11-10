import { canFinishChecks, questionOptions, type BudgetStatus, type LiveLine, type Estimate, fmtMinutes, type Health, minutesRange, usdRange, liveSpend, openComments, type Readiness, reportsCost, runMinutes, type StartChoice, type Ticket, usd } from '@ticketflow/shared'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { actions } from '../lib/api.js'
import { laneOf, readConfirmRule, SENSITIVE, useEstimates, useNow, writeConfirmRule, type ConfirmRule } from '../lib/estimates.js'
import { failed, notice } from '../lib/notice.js'
import { useTriage } from '../lib/triage.js'
import { ChannelPicker, lastChannel } from './ChannelPicker.js'
import { canMarkReady, greptileClear, modelName, priorityLabel } from './status.js'
import { LocalChecksCard, localFailed, push } from './LocalChecks.js'
import { ReviewersCard } from './FollowUp.js'
import { Markdown } from './Markdown.js'
import { ReadyButton } from './Ready.js'
import { Button, ConfirmButton } from './ui.js'

type Run = (fn: () => Promise<unknown>) => () => Promise<void>

const LANE_NAME: Record<StartChoice, string> = { lite: 'Lite', full: 'Full', max: 'Max' }

export const estLine = (e: Estimate | null, costs = true) => (e ? [minutesRange(e.minutes), costs && e.cost ? usdRange(e.cost) : null].filter(Boolean).join(' · ') : null)

// Elapsed against the estimate for the lane that is running; amber once past its upper end.
export function useRunClock(t: Ticket) {
  const now = useNow(t.status === 'running' ? 10_000 : 600_000)
  const est = useEstimates(t)[laneOf(t)]
  const elapsed = t.status === 'running' ? runMinutes(t, now) : null
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

function Frame({ label, tone = 'accent', lead, children }: { label: string; tone?: 'accent' | 'warn' | 'bad' | 'ok'; lead?: string | undefined; children: React.ReactNode }) {
  const cls = {
    accent: 'border-accent/40 bg-accent/[.06] [--k:var(--color-accent-fg)]',
    warn: 'border-[#3d3522] bg-[#1a1812] [--k:var(--color-warn)]',
    bad: 'border-[#4a2a2f] bg-[#1b1416] [--k:var(--color-bad)]',
    ok: 'border-line bg-panel [--k:var(--color-ok)]',
  }[tone]
  return (
    <motion.section layout className={`flex flex-col gap-2.5 rounded-xl border px-4 py-3 ${cls}`}>
      {/* the label and what to do, on one line */}
      <div className="flex items-baseline gap-2.5">
        <span className="shrink-0 text-[11px] font-semibold tracking-wide text-[var(--k)] uppercase">{label}</span>
        {lead && <p className="text-[13.5px] leading-relaxed text-fg">{lead}</p>}
      </div>
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
      if (t.localChecks?.status === 'fail') return { label: 'Next step', text: `What CI runs failed here, so ${t.prUrl || t.pr ? `nothing is pushed${t.unpushed?.count ? `: ${t.unpushed.count} commit${t.unpushed.count === 1 ? '' : 's'}, your fixes included, wait here` : ''}` : 'the PR stays closed'}. Let the lane fix it, or push anyway if the failure is not this change.`, tone: 'bad' }
      return { label: 'Next step', text: t.prUrl || t.pr ? 'Look at the changes, then push them to the PR.' : 'Look at the changes, then push. It opens a draft PR with your GitHub account.', tone: 'warn' }
    case 'no_change':
      return { label: 'Next step', text: 'The lane thinks nothing needs to change. Read why in Overview, then close it in Linear or retry.', tone: 'warn' }
    case 'pr_draft': {
      const open = openComments(t).length
      const ahead = t.unpushed?.count ?? 0
      if (ahead) return { label: 'Next step', text: `${ahead} commit${ahead === 1 ? '' : 's'} here (fixes included) ${ahead === 1 ? 'is' : 'are'} not on the PR yet, so GitHub, CI and Greptile still see the old code. Push them.`, tone: 'warn' }
      const onlyGreptile = Boolean(t.ci?.jobs.length && t.ci.jobs.every((j) => /greptile/i.test(j.name)))
      if (t.pr?.ci === 'failure' && onlyGreptile) return { label: 'Greptile is red', text: `Only Greptile's check failed: its score${t.pr.greptile?.score ? ` (${t.pr.greptile.score}/5)` : ''} is under the repo's minimum. Fix its findings, then it reviews again.`, tone: 'warn' }
      if (t.pr?.ci === 'failure') return { label: 'CI is red', text: t.ci?.why ? `CI is failing on the PR. ${t.ci.why}` : 'CI is failing on the PR. Fix CI sends the failing jobs and their logs to the lane.', tone: 'bad' }
      if (open) return { label: 'Next step', text: `${open} comment${open === 1 ? '' : 's'} on the PR to deal with. Pick them in Comments.`, tone: 'warn' }
      if (t.behindMain?.conflicts) return { label: 'Next step', text: 'Main moved and conflicts with this branch. Update from main.', tone: 'warn' }
      if (canMarkReady(t)) return { label: 'Next step', text: greptileClear(t) ? 'Greptile is clear. Mark it ready so teammates can review.' : 'Mark it ready for review when you are happy with it.', tone: 'accent' }
      if (t.pr?.state === 'MERGED') return { label: 'Merged', text: 'Merged on GitHub. Move it to QA or Done in Linear.', tone: 'ok' }
      return { label: 'Waiting', text: 'Waiting on review. mevo tells you when something comes in.', tone: 'ok' }
    }
    case 'done':
      return { label: 'Done', text: 'Closed.', tone: 'ok' }
    case 'skipped':
      return { label: 'Skipped', text: 'Skipped. Start it again whenever you want.', tone: 'ok' }
    default:
      return { label: 'Next step', text: '', tone: 'accent' }
  }
}

// After a quick fix: what to look at by hand (no screenshots or e2e were run)
function QuickCheck({ ticket: t, busy, run }: { ticket: Ticket; busy: boolean; run: Run }) {
  const q = t.quickCheck
  if (!q || q.done || t.status === 'running') return null
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-accent/30 bg-accent/5 px-2.5 py-2 text-xs">
      <span className="font-medium text-fg">Check the quick fix by hand{t.port ? ` (dev server :${t.port})` : ''}</span>
      <ul className="flex flex-col gap-0.5 text-fg-2">
        {q.steps.map((s) => (
          <li key={s}>· {s}</li>
        ))}
      </ul>
      <span>
        <Button disabled={busy} onClick={run(() => actions.quickChecked(t))}>
          Looks right
        </Button>
      </span>
    </div>
  )
}

// The fixes are here but the PR on GitHub doesn't have them yet
function Unpushed({ ticket: t }: { ticket: Ticket }) {
  const u = t.unpushed
  if (!u?.count || !t.pr || t.pr.state !== 'OPEN') return null
  return (
    <details className="rounded-md border border-warn/30 bg-warn/5 px-2.5 py-1.5 text-xs">
      <summary className="cursor-pointer text-warn">
        {u.count} commit{u.count === 1 ? '' : 's'} here {u.count === 1 ? 'is' : 'are'} not on GitHub yet: the PR still shows the code before {u.count === 1 ? 'it' : 'them'}
      </summary>
      <ul className="mt-1 flex flex-col gap-0.5">
        {u.commits.map((c) => (
          <li key={c.sha} className="truncate text-fg-2">
            <span className="font-mono text-[11px] text-muted">{c.sha}</span> {c.subject}
          </li>
        ))}
        {u.count > u.commits.length && <li className="text-dim">and {u.count - u.commits.length} merge commit{u.count - u.commits.length === 1 ? '' : 's'}</li>}
      </ul>
    </details>
  )
}

function NextCard({ ticket: t, busy, run, engines }: { ticket: Ticket; busy: boolean; run: Run; engines: NonNullable<Health['lanes']['engines']> }) {
  const n = nextLine(t)
  return (
    <Frame label={n.label === 'Next step' ? 'Next' : n.label} tone={n.tone} lead={t.status === 'needs_input' ? undefined : n.text || undefined}>
      {t.status === 'needs_input' && <QuestionBox ticket={t} busy={busy} run={run} />}
      {t.status === 'failed' && t.failure && (
        <>
          <p className="text-xs leading-relaxed text-fg-2">{t.failure.hint}</p>
          <pre className="max-h-28 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-muted">{t.failure.detail}</pre>
        </>
      )}
      {t.behindPr && (
        <p className={`text-xs leading-relaxed ${t.behindPr.why === 'conflicts' || t.behindPr.why === 'error' ? 'text-bad' : 'text-warn'}`}>
          GitHub has {t.behindPr.commits || 'new'} commit(s) on this branch the worktree doesn't. {t.behindPr.detail}
          {t.behindPr.files?.length ? ` Files: ${t.behindPr.files.join(', ')}.` : ''}
        </p>
      )}
      <QuickCheck ticket={t} busy={busy} run={run} />
      <Unpushed ticket={t} />
      <LocalChecksCard ticket={t} busy={busy} run={run} />
      <ReviewersCard ticket={t} busy={busy} run={run} />
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
      {canFinishChecks(t) && (
        <Button variant="primary" disabled={busy} title="the lane's work is done; runs the gates and supervisor again and comes back for your review" onClick={run(() => actions.finishChecks(t))}>
          Finish the checks
        </Button>
      )}
      {t.status === 'stopped' && <ResumeChoice ticket={t} busy={busy} run={run} engines={engines} />}
      {t.status === 'review_ready' && localFailed(t) && (
        <>
          <Button variant="primary" disabled={busy} title="sends the failures to the lane; it fixes them, the checks run again and the PR opens when they pass" onClick={run(() => actions.fixLocalChecks(t))}>
            Let the lane fix it
          </Button>
          <ConfirmButton label={t.prUrl || t.pr ? 'Push anyway' : 'Open PR anyway'} confirm="CI will likely fail the same way" disabled={busy} onConfirm={() => void run(() => push(t, true))()} />
        </>
      )}
      {/* everything after this sits on the right, quieter */}
      <span className="order-1 ml-auto" aria-hidden="true" />
      {t.status === 'review_ready' && !localFailed(t) && (
        <Button variant="primary" disabled={busy || pushing || t.localChecks?.status === 'running'} title="runs the local checks first if this commit has none" onClick={run(() => push(t))}>
          {pushing ? 'Pushing…' : t.localChecks?.status === 'running' ? 'Local checks running…' : t.pushing?.error ? 'Try the push again' : t.prUrl || t.pr ? 'Push to the PR' : 'Push + draft PR'}
        </Button>
      )}
      {t.status === 'pr_draft' && t.unpushed?.count ? (
        localFailed(t) ? (
          <ConfirmButton variant="primary" label={`Push ${t.unpushed.count} commit${t.unpushed.count === 1 ? '' : 's'} anyway`} confirm="Push even though the local checks failed" disabled={busy || pushing} onConfirm={() => void run(() => push(t, true))()} />
        ) : (
          <Button variant="primary" disabled={busy || pushing || t.localChecks?.status === 'running'} title="runs the local checks first if this commit has none" onClick={run(() => push(t))}>
            {pushing ? 'Pushing…' : t.localChecks?.status === 'running' ? 'Local checks running…' : `Push ${t.unpushed.count} commit${t.unpushed.count === 1 ? '' : 's'}`}
          </Button>
        )
      ) : null}
      {t.status === 'pr_draft' && t.pr?.ci === 'failure' && (
        <>
          <Button variant={t.unpushed?.count ? 'default' : 'primary'} disabled={busy} title="sends the failing jobs and their logs to the lane: it fixes them if they are this change, explains if not" onClick={run(() => actions.fixCi(t))}>
            Fix CI
          </Button>
          {t.ci?.jobs.some((j) => j.runId) && (
            <Button disabled={busy} title="gh run rerun --failed" onClick={run(async () => {
              const r = await actions.rerunCi(t)
              notice({ id: t.id, title: `Re-running ${r.runs} CI run${r.runs === 1 ? '' : 's'}`, tone: 'accent' })
            })}>
              Re-run failed jobs
            </Button>
          )}
        </>
      )}
      {(t.pr?.state === 'OPEN' || t.behindPr) && t.worktree && t.status !== 'running' && t.status !== 'queued' && (
        <Button
          variant={t.behindPr ? 'primary' : 'ghost'}
          className={t.behindPr ? '' : 'order-2'}
          disabled={busy}
          title="brings the PR branch's new commits from GitHub (its Update branch button, a teammate's push) into the worktree; merges them with local commits if needed"
          onClick={run(async () => {
            const r = await actions.pullFromGithub(t)
            notice({ id: t.id, title: r.outcome === 'current' || r.outcome === 'ahead' ? 'Nothing new on GitHub' : r.text, ...(r.outcome === 'merged' ? { detail: 'Push to send the merge to the PR' } : {}), tone: 'ok' })
          })}
        >
          {t.behindPr?.commits ? `Pull ${t.behindPr.commits} commit(s) from GitHub` : 'Pull'}
        </Button>
      )}
      {t.behindMain && (
        <Button
          variant={t.status === 'pr_draft' && t.behindMain.conflicts ? 'primary' : 'ghost'}
          className={t.status === 'pr_draft' && t.behindMain.conflicts ? '' : 'order-2'}
          disabled={busy}
          title={t.behindMain.conflicts ? 'merging main conflicts; the lane resolves them and comes back for your review' : 'merges main, re-runs the gates, pushes to the PR if green'}
          onClick={run(() => actions.updateMain(t))}
        >
          {t.status === 'pr_draft' && t.behindMain.conflicts ? 'Update from main' : 'Update'} · {t.behindMain.commits} behind{t.behindMain.conflicts ? ', conflicts' : ''}
        </Button>
      )}
      {canMarkReady(t) && (
        <ReadyButton ticket={t} busy={busy} wrap={run} primary={greptileClear(t)} />
      )}
      {t.status === 'pr_draft' && t.pr && !t.pr.isDraft && t.pr.state === 'OPEN' && (
        <SlackPost ticket={t} busy={busy} run={run} />
      )}
      {(t.status === 'pr_draft' || t.status === 'no_change') && (
        <>
          <Button variant={t.status === 'pr_draft' && !canMarkReady(t) && t.pr?.ci !== 'failure' ? 'primary' : 'ghost'} className={t.status === 'pr_draft' && !canMarkReady(t) && t.pr?.ci !== 'failure' ? '' : 'order-2'} disabled={busy} title="moves the ticket to QA in Linear" onClick={run(() => actions.moveInLinear(t, 'qa'))}>
            {t.status === 'pr_draft' && !canMarkReady(t) && t.pr?.ci !== 'failure' ? 'Move to QA' : 'To QA'}
          </Button>
          <Button variant={t.status === 'no_change' ? 'primary' : 'ghost'} className={t.status === 'no_change' ? '' : 'order-2'} disabled={busy} title="moves the ticket to Done in Linear" onClick={run(() => actions.moveInLinear(t, 'done'))}>
            {t.status === 'no_change' ? 'Done in Linear' : 'To Done'}
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
        <Button variant="ghost" className="order-2" disabled={busy} title={t.pr?.state === 'OPEN' ? 'back to its PR, which is still open on GitHub' : 'closes it in mevo'} onClick={run(() => actions.dismiss(t))}>
          Dismiss
        </Button>
      )}
      {(t.status === 'done' || t.status === 'skipped') && t.pr?.state !== 'MERGED' && (
        <Button disabled={busy} title="reads the PR from GitHub and puts the ticket back where it is there" onClick={run(async () => {
          const r = await actions.reopen(t)
          notice({ id: t.id, title: r.message, tone: r.status === t.status ? 'warn' : 'ok' })
        })}>
          Reopen · sync with GitHub
        </Button>
      )}
      {t.status === 'review_ready' && (
        <ConfirmButton variant="ghost" className="order-2" label="Discard" confirm={`Discard the work on ${t.id}`} disabled={busy} onConfirm={() => void run(() => actions.skip(t))()} />
      )}
      {t.pushing && <p className={`order-3 w-full text-xs leading-snug ${t.pushing.error ? 'text-bad' : 'text-muted'}`}>{t.pushing.error ?? `${t.pushing.step}…`}</p>}
    </div>
  )
}

const MODELS: Record<string, readonly string[]> = { claude: ['opus', 'sonnet', 'haiku'] }

// A stopped lane: go on where it was, on the same or another engine and model, or start over.
function ResumeChoice({ ticket: t, busy, run, engines }: { ticket: Ticket; busy: boolean; run: Run; engines: NonNullable<Health['lanes']['engines']> }) {
  const was = t.engine ?? t.sessionEngine ?? 'claude'
  const [engine, setEngine] = useState('')
  const [model, setModel] = useState('')
  const installed = engines.filter((e) => e.installed)
  const ref = engine ? `${engine}${model.trim() ? `:${model.trim()}` : ''}` : model.trim() ? `${was.split(':')[0]}:${model.trim()}` : ''
  const other = Boolean(ref) && ref !== was
  const models: readonly string[] = MODELS[engine || (was.split(':')[0] ?? 'claude')] ?? []
  return (
    <>
      <Button variant="primary" disabled={busy} title={other ? `${ref} picks up the work so far: the brief, ARM-SUMMARY.md, RESUME.md and the commits` : 'continues the same session from RESUME.md'} onClick={run(() => actions.resume(t, other ? { engine: ref } : {}))}>
        {other ? `Continue on ${ref}` : 'Resume'}
      </Button>
      {installed.length > 0 && (
        <label className="flex items-center gap-1.5 text-xs text-muted">
          on
          <select aria-label="engine" value={engine} onChange={(e) => (setEngine(e.target.value), setModel(''))} className="rounded-md border border-line-2 bg-bg px-2 py-1.5 text-xs text-fg outline-none focus:border-accent">
            <option value="">{was} (as before)</option>
            {installed.map((e) => (
              <option key={e.id} value={e.id}>
                {e.label}
              </option>
            ))}
          </select>
          {models.length > 0 ? (
            <select aria-label="model" value={model} onChange={(e) => setModel(e.target.value)} className="rounded-md border border-line-2 bg-bg px-2 py-1.5 text-xs text-fg outline-none focus:border-accent">
              <option value="">default model</option>
              {models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : (
            <input aria-label="model" placeholder="model (optional)" value={model} onChange={(e) => setModel(e.target.value)} className="w-44 rounded-md border border-line-2 bg-bg px-2 py-1.5 text-xs text-fg outline-none focus:border-accent" />
          )}
        </label>
      )}
      {!t.prUrl && !t.pr && (
        <ConfirmButton
          label="Start over"
          confirm={`Throw away this lane's work (kept on a backup branch) and start fresh${ref ? ` on ${ref}` : ''}`}
          disabled={busy}
          onConfirm={() => void run(() => actions.resume(t, { fresh: true, ...(ref ? { engine: ref } : {}) }))()}
        />
      )}
    </>
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
  const r = t.readiness
  if (r) out.push(r.verdict === 'ready' ? { ok: true, text: `readiness: ready, ${r.confidence}% sure` } : { ok: false, text: `readiness: ${r.verdict === 'clarify' ? 'needs clarification' : 'on hold'} (${r.confidence}%): ${r.why}` })
  return out
}

function overRule(est: Estimate | null, rule: ConfirmRule): string | null {
  if (!rule.enabled || !est) return null
  if (est.minutes[1] > rule.minutes) return `estimated up to ${fmtMinutes(est.minutes[1])}`
  if (est.cost && est.cost[1] > rule.usd) return `estimated up to ${usd(est.cost[1])}`
  return null
}

const VERDICT: Record<Readiness['verdict'], { label: string; cls: string }> = {
  ready: { label: 'Ready to start', cls: 'border-[#27463a] bg-[#16281f] text-ok' },
  clarify: { label: 'Needs clarification', cls: 'border-[#3d3522] bg-[#1a1812] text-warn' },
  hold: { label: 'Hold', cls: 'border-[#4a2a2f] bg-[#2a1a1d] text-bad' },
}

// What a cheap model read in the ticket and its Linear discussion, before you spend a lane on it.
function ReadinessBox({ ticket: t, busy, run }: { ticket: Ticket; busy: boolean; run: Run }) {
  const r = t.readiness
  const checking = Boolean(t.readinessRunning && !t.readinessRunning.error)
  const [asking, setAsking] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const check = () => void run(() => actions.readiness(t))()
  if (!r) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
        <span>Readiness</span>
        {checking ? (
          <span className="animate-pulse">Reading the ticket and its discussion…</span>
        ) : (
          <>
            <span>{t.readinessRunning?.error ? `Readiness check failed: ${t.readinessRunning.error}` : 'Not checked yet: is it clear enough to start?'}</span>
            <button type="button" className="ml-auto text-accent-fg hover:underline disabled:opacity-50" disabled={busy} onClick={check}>
              Check readiness
            </button>
          </>
        )}
      </div>
    )
  }
  const v = VERDICT[r.verdict]
  const draft = () => setAsking(r.questions.map((q) => `- ${q}`).join('\n'))
  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted">Readiness</span>
        <span className={`rounded-full border px-2 py-px text-[11px] font-medium whitespace-nowrap ${v.cls}`}>{v.label}</span>
        <span className="font-mono text-fg-2" title="how sure it is an agent can finish it as asked without asking anyone">
          {r.confidence}%
        </span>
        <span className="min-w-24 flex-1 truncate text-fg-2" title={r.why}>
          {r.why}
        </span>
        {(r.questions.length > 0 || r.scope.length > 0 || r.decisions.length > 0) && (
          <button type="button" className="shrink-0 text-accent-fg hover:underline" onClick={() => setOpen((o) => !o)}>
            {open ? 'Hide' : r.questions.length ? `${r.questions.length} question${r.questions.length === 1 ? '' : 's'} ▸` : 'Details ▸'}
          </button>
        )}
        <button type="button" className="shrink-0 text-muted hover:text-fg disabled:opacity-50" disabled={busy || checking} onClick={check}>
          {checking ? 'Checking…' : 'Check again'}
        </button>
      </div>
      {open && (
    <div className="flex flex-col gap-2 border-l-2 border-line-2 pl-3">
      <span className="text-dim">
        {r.engine.replace(/^(\w+):/, '$1 · ')} · {r.comments} comment{r.comments === 1 ? '' : 's'} read
        {r.cost ? ` · $${r.cost.toFixed(3)}` : ''}
      </span>
      {r.questions.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium tracking-wide text-warn uppercase">Questions to ask</span>
          <ul className="flex flex-col gap-0.5 text-fg-2">
            {r.questions.map((q) => (
              <li key={q}>? {q}</li>
            ))}
          </ul>
        </div>
      )}
      {(r.scope.length > 0 || r.decisions.length > 0) && (
        <details className="text-fg-2">
          <summary className="cursor-pointer text-muted">What it understood</summary>
          <ul className="mt-1 flex flex-col gap-0.5">
            {r.scope.map((x) => (
              <li key={x}>· {x}</li>
            ))}
            {r.decisions.map((x) => (
              <li key={x}>✓ {x} <span className="text-dim">(decided in the comments)</span></li>
            ))}
          </ul>
        </details>
      )}
      {r.questions.length > 0 && asking === null && (
        <div>
          <Button disabled={busy} onClick={draft}>
            Ask in Linear…
          </Button>
        </div>
      )}
      {asking !== null && (
        <div className="flex flex-col gap-2">
          <textarea aria-label="comment for Linear" value={asking} onChange={(e) => setAsking(e.target.value)} rows={Math.min(8, asking.split('\n').length + 1)} className="rounded-md border border-line-2 bg-bg px-2 py-1.5 text-xs text-fg outline-none focus:border-accent" />
          <div className="flex gap-2">
            <Button
              variant="primary"
              disabled={busy || !asking.trim()}
              onClick={() =>
                void run(async () => {
                  await actions.askInLinear(t, asking)
                  setAsking(null)
                  notice({ id: t.id, title: 'Posted in Linear', detail: 'It reads the ticket again when someone answers', tone: 'ok' })
                })()
              }
            >
              Post as your comment
            </Button>
            <Button variant="ghost" onClick={() => setAsking(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
      )}
    </div>
  )
}

function StartPanel({ ticket: t, busy, run, budget, engines }: { ticket: Ticket; busy: boolean; run: Run; budget?: BudgetStatus | undefined; engines: NonNullable<Health['lanes']['engines']> }) {
  const est = useEstimates(t)
  const triage = useTriage(t.id)
  const [engine, setEngine] = useState('')
  const [lane, setLane] = useState<StartChoice>(t.suggestedLane)
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

  const chosen = est[lane]
  return (
    <Frame label="Start" lead={`Suggested: ${t.suggestedLane} lane${t.reason ? ` · ${t.reason.replace(/\.$/, '')}` : ''}`}>
      <ReadinessBox ticket={t} busy={busy} run={run} />
      <div className="flex flex-wrap items-center gap-2.5 border-t border-line-2 pt-2.5">
        <span className="inline-flex rounded-md border border-line-2 p-0.5" role="group" aria-label="lane">
          {(['lite', 'full', 'max'] as const).map((l) => (
            <button key={l} type="button" aria-pressed={lane === l} onClick={() => setLane(l)} className={`rounded px-2.5 py-0.5 text-xs whitespace-nowrap ${lane === l ? 'bg-raised text-fg' : 'text-muted hover:text-fg'}`}>
              {LANE_NAME[l]}
              {l === t.suggestedLane && <span className="ml-1 text-[10px] text-accent-fg">suggested</span>}
            </button>
          ))}
        </span>
        <span className="min-w-24 flex-1 truncate text-xs text-fg-2" title={basis ? `Estimates ${basis}. No AI used.` : 'No estimates yet: they show after 5 finished runs like this one.'}>
          {estLine(chosen) ?? (lane === 'max' ? 'full lane at max effort' : 'no estimate yet')}
          <span className="text-muted"> · {chosen ? `clean ${chosen.clean.ok} of ${chosen.clean.of}` : lane === 'max' ? 'slower, deeper; only when you ask' : lane === 'lite' ? 'one pass, quick fixes' : 'review pass + supervisor'}</span>
        </span>
        <EnginePicker engines={engines} value={engine} onChange={setEngine} />
        <Button variant="primary" disabled={busy} onClick={() => start(lane)}>
          Start {lane}
        </Button>
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
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span className="mr-1 text-muted">Safety</span>
        {checks.map((c) => (
          <span key={c.text} title={c.text} className={`max-w-80 truncate rounded-full border px-2 py-px text-[11px] ${c.ok === false ? 'border-[#5a4718] bg-[#2a2312] text-warn' : 'border-line-2 text-fg-2'}`}>
            {c.ok === false ? '⚠' : c.ok === null ? '•' : '✓'} {c.text}
          </span>
        ))}
        <span className="ml-auto flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-muted" title={`asks before starting one estimated over ${rule.minutes} min or ${usd(rule.usd)}`}>
            <input type="checkbox" checked={rule.enabled} onChange={(e) => toggle(e.target.checked)} className="accent-[#7c5cff]" />
            Ask if over {rule.minutes} min or {usd(rule.usd)}
          </label>
          <button type="button" className="text-muted hover:text-fg disabled:opacity-50" disabled={busy} onClick={run(() => actions.skip(t))}>
            Skip
          </button>
        </span>
      </div>
      {triage && <span className="text-[11.5px] text-muted">Triage: {triage.why}</span>}
    </Frame>
  )
}

function ago(iso: string): string {
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  return s < 60 ? `${s}s ago` : `${Math.round(s / 60)}m ago`
}

// The lane's question in markdown, its options as buttons, your own answer, or set it aside.
export function QuestionBox({ ticket: t, busy, run }: { ticket: Ticket; busy: boolean; run: Run }) {
  const [answer, setAnswer] = useState('')
  const [open, setOpen] = useState(false)
  const options = questionOptions(t.question)
  const custom = open || options.length === 0
  return (
    <div className="flex flex-col gap-3">
      <div className="max-h-80 overflow-auto">
        <Markdown source={t.question ?? ''} ticketId={t.id} className="md-sm" />
      </div>
      {options.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {options.map((o) => (
            <button
              key={o.n}
              type="button"
              disabled={busy}
              title={o.text}
              onClick={run(() => actions.answer(t, `Option ${o.n}: ${o.text}`))}
              className={`flex items-start gap-2.5 rounded-lg border px-3 py-2 text-left text-[13px] transition-colors disabled:opacity-50 ${o.recommended ? 'border-accent bg-accent/10 hover:bg-accent/20' : 'border-line-2 bg-panel hover:border-accent'}`}
            >
              <span className="mt-px font-mono text-[11px] text-muted">{o.n}</span>
              <span className="flex-1 text-fg">{o.label}</span>
              {o.recommended && <span className="shrink-0 text-[11px] text-accent-fg">recommended</span>}
            </button>
          ))}
        </div>
      )}
      {custom ? (
        <>
          <label htmlFor={`answer-${t.id}`} className="sr-only">
            Your answer
          </label>
          <textarea
            id={`answer-${t.id}`}
            rows={3}
            value={answer}
            autoFocus={open}
            placeholder={options.length ? 'Your own answer, or add to an option ("2, but only on mobile")' : 'Your answer'}
            onChange={(e) => setAnswer(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && answer.trim()) void run(() => actions.answer(t, answer))()
            }}
            className="rounded-md border border-line-2 bg-bg px-3 py-2 text-[13px] outline-none transition-colors focus:border-accent max-md:text-[16px]"
          />
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={busy || !answer.trim()} onClick={run(() => actions.answer(t, answer))}>
              Send answer
            </Button>
            <Button variant="ghost" disabled={busy} title="parks the ticket as stopped; resume, instruct or dismiss it from there" onClick={run(() => actions.dismissQuestion(t))}>
              Set it aside
            </Button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" onClick={() => setOpen(true)}>
            Something else…
          </Button>
          <Button variant="ghost" disabled={busy} title="parks the ticket as stopped; resume, instruct or dismiss it from there" onClick={run(() => actions.dismissQuestion(t))}>
            Set it aside
          </Button>
        </div>
      )}
    </div>
  )
}

// Post this PR to Slack, choosing the channel right here.
function SlackPost({ ticket: t, busy, run }: { ticket: Ticket; busy: boolean; run: (fn: () => Promise<unknown>) => () => void }) {
  const [open, setOpen] = useState(false)
  const [channel, setChannel] = useState(lastChannel)
  return (
    <span className="relative order-2">
      <Button variant="ghost" disabled={busy} aria-expanded={open} title="post this PR to a Slack channel" onClick={() => setOpen((o) => !o)}>
        Slack ▾
      </Button>
      {open && (
        <span className="absolute right-0 bottom-full z-30 mb-1 flex items-center gap-2 rounded-lg border border-line-2 bg-panel p-2 shadow-xl">
          <ChannelPicker value={channel} onChange={setChannel} />
          <Button
            variant="primary"
            disabled={busy}
            onClick={run(async () => {
              const r = await actions.slackAnnounce(t, channel || undefined)
              notice({ id: t.id, title: `Posted to Slack ${r.channel}`, tone: 'ok' })
              setOpen(false)
            })}
          >
            Post
          </Button>
        </span>
      )}
    </span>
  )
}
