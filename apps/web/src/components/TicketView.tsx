import type { Health, LiveLine, StartChoice, Ticket } from '@ticketflow/shared'
import { motion } from 'motion/react'
import { useState } from 'react'
import { actions } from '../lib/api.js'
import { href } from '../lib/route.js'
import { desktop } from '../lib/tauri.js'
import { IssueTab, PrTab, type Tab, Tabs } from './Context.js'
import { DiffPanel } from './Diff.js'
import { Instruct } from './Instruct.js'
import { Supervision } from './Supervision.js'
import { VisualTab, visualState } from './Visual.js'
import { Journal } from './Journal.js'
import { LiveLog } from './Live.js'
import { Stepper } from './Stepper.js'
import { canMarkReady, canMoveInLinear, compactStat, greptileClear, laneLabel, prState, priorityLabel, STATUS_LABEL, statusTone, summarySections } from './status.js'
import { CommentPicker } from './Comments.js'
import { PreviewQaCard } from './PreviewQa.js'
import { Button, ConfirmButton, Label, Mono, Pill, rise, Section, stagger } from './ui.js'
import { failed, notice } from '../lib/notice.js'

export function TicketView({ ticket: t, live, models, engines = [] }: { ticket: Ticket; live: readonly LiveLine[]; models?: Health['lanes']['models']; engines?: NonNullable<Health['lanes']['engines']> }) {
  const [busy, setBusy] = useState(false)
  const [answer, setAnswer] = useState('')
  const [tab, setTab] = useState<Tab>('work')
  const run = (fn: () => Promise<unknown>) => async () => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      failed(err, t.id)
    } finally {
      setBusy(false)
    }
  }
  const p = priorityLabel(t.priority)
  const priority = p && !t.labels.includes(p) ? p : null
  const sections = summarySections(t.summary).filter((s) => !/^(commits|files touched|gate output)$/i.test(s.title))
  // every lane turn, review and visual check that reported a cost
  const total = (t.journal ?? []).reduce((sum, j) => sum + (Number(j.meta?.cost) || 0), 0)

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,7fr)_minmax(0,5fr)] grid-rows-[minmax(0,1fr)] max-lg:flex max-lg:flex-col max-lg:overflow-y-auto max-md:pb-24">
      <motion.div variants={stagger} initial="hidden" animate="show" className="flex min-h-0 flex-col gap-4 overflow-y-auto border-r border-line px-6 py-5 max-lg:shrink-0 max-lg:overflow-visible max-lg:border-r-0 max-md:px-4">
        <motion.div variants={rise} className="flex items-center gap-2 text-xs text-muted">
          <a href={href.board} className="hover:text-fg max-md:flex max-md:min-h-9 max-md:items-center">
            Board
          </a>
          <span className="text-dim">›</span>
          <span className="font-semibold text-fg">{t.id}</span>
          <Pill tone={statusTone(t.status)}>{STATUS_LABEL[t.status]}</Pill>
          {visualState(t) && (
            <button type="button" onClick={() => setTab('visual')} className="contents">
              <Pill tone={visualState(t)?.tone ?? 'neutral'}>👁 {visualState(t)?.label}</Pill>
            </button>
          )}
          <span className="ml-auto">
            {laneLabel(t, models)}
            {total > 0 ? ` · $${total.toFixed(2)}` : ''}
          </span>
        </motion.div>

        <motion.h1 layoutId={`title-${t.id}`} variants={rise} className="text-lg leading-snug font-semibold max-md:text-base">
          {t.title}
        </motion.h1>

        <motion.div variants={rise} className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span>{t.createdBy.split('@')[0]}</span>
          {priority && <Pill>{priority}</Pill>}
          {t.labels.map((l) => (
            <Label key={l} name={l} />
          ))}
          <button type="button" onClick={() => void desktop.open(t.url)} className="text-accent-fg hover:underline">
            Open in Linear
          </button>
          <Mono>
            {t.branch}
            {t.port ? ` · :${t.port}` : ''}
          </Mono>
        </motion.div>

        <motion.div variants={rise}>
          <Stepper ticket={t} />
        </motion.div>

        <motion.div variants={rise}>
          <Actions ticket={t} busy={busy} run={run} engines={engines} />
          <div className="mt-2">
            <Instruct ticket={t} />
          </div>
        </motion.div>

        <motion.div variants={rise}>
          <Tabs tab={tab} onChange={setTab} hasPr={Boolean(t.prUrl)} />
        </motion.div>

        {tab === 'visual' && <VisualTab ticket={t} />}
        {tab === 'issue' && <IssueTab ticket={t} />}
        {tab === 'pr' && <PrTab ticket={t} />}
        {tab === 'work' && (
          <>
        {t.status === 'failed' && t.failure && (
          <motion.div
            variants={rise}
            animate={{ opacity: 1, y: 0, x: [0, -6, 6, -3, 3, 0] }}
            transition={{ x: { duration: 0.5, delay: 0.25 } }}
            className="rounded-lg border border-[#4a2a2f] bg-[#1b1416] px-4 py-3"
          >
            <div className="font-medium text-bad">{t.failure.title}</div>
            <p className="mt-1 text-xs leading-relaxed text-fg-2">{t.failure.hint}</p>
            <pre className="mt-2 max-h-28 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-muted">{t.failure.detail}</pre>
          </motion.div>
        )}

        {t.status === 'needs_input' && (
          <motion.div
            variants={rise}
            className="relative flex flex-col gap-2 overflow-hidden rounded-lg border border-[#3d3522] bg-[#1a1812] px-4 py-3"
          >
            <motion.span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 rounded-lg"
              animate={{ boxShadow: ['inset 0 0 0 1px rgba(242,201,76,0)', 'inset 0 0 0 1px rgba(242,201,76,.5)', 'inset 0 0 0 1px rgba(242,201,76,0)'] }}
              transition={{ duration: 2, repeat: Infinity }}
            />
            <div className="text-xs font-medium text-warn">The lane is asking</div>
            <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-fg-2">{t.question}</p>
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
          </motion.div>
        )}

        {t.supervision && <Supervision report={t.supervision} />}

        {t.commits && (
          <Section title="Commits">
            <div className="rounded-lg border border-line bg-sunk px-3 py-2.5 font-mono text-xs leading-[1.7] text-fg-2">
              {t.commits
                .split('\n')
                .filter(Boolean)
                .map((c) => (
                  <div key={c}>
                    <span className="text-muted">{c.slice(0, 7)}</span> {c.slice(8)}
                  </div>
                ))}
              {t.diffStat && <div className="mt-1 text-muted">{compactStat(t.diffStat)}</div>}
            </div>
          </Section>
        )}

        {t.worktree && t.status !== 'queued' && <DiffPanel ticket={t} />}

        {sections.length > 0 && (
          <Section title="Summary from the lane">
            <div className="flex flex-col gap-3 rounded-lg border border-line bg-panel px-4 py-3.5 text-[13px] leading-relaxed text-fg-2">
              {sections.map((s) => (
                <div key={s.title} className={/manual test|known risks/i.test(s.title) ? 'border-l-2 border-warn pl-3' : ''}>
                  <div className="mb-0.5 font-medium text-fg">{s.title}</div>
                  <div className="whitespace-pre-wrap">{s.body.replace(/\*\*/g, '').replace(/`/g, '')}</div>
                </div>
              ))}
            </div>
          </Section>
        )}

        <Journal ticket={t} />

        <motion.details variants={rise} className="shrink-0 text-xs">
          <summary className="cursor-pointer text-muted">Raw activity · {t.events.length}</summary>
          <div className="mt-2 font-mono text-[11px] leading-[1.7] text-muted">
            {[...t.events].reverse().map((e) => (
              <div key={e.at + e.kind} className="flex gap-3 max-md:flex-wrap max-md:gap-x-3 max-md:gap-y-0">
                <span className="shrink-0 text-dim">{new Date(e.at).toLocaleString([], { hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                <span className="w-20 shrink-0">{e.kind}</span>
                <span className="break-words">{e.message}</span>
              </div>
            ))}
          </div>
        </motion.details>
          </>
        )}
      </motion.div>

      <motion.div variants={stagger} initial="hidden" animate="show" className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 py-5 max-lg:shrink-0 max-lg:overflow-visible max-lg:border-t max-lg:border-line max-md:px-4">
        <PrPanel ticket={t} busy={busy} run={run} />
        <motion.div variants={rise} className="flex min-h-[260px] flex-1 flex-col max-lg:min-h-[320px]">
          <LiveLog id={t.id} lines={live} running={t.status === 'running'} className="flex-1" />
        </motion.div>
      </motion.div>
    </div>
  )
}

function Actions({ ticket: t, busy, run, engines }: { ticket: Ticket; busy: boolean; run: (fn: () => Promise<unknown>) => () => Promise<void>; engines: NonNullable<Health['lanes']['engines']> }) {
  const [engine, setEngine] = useState('')
  const startable = t.status === 'assigned' || t.status === 'failed' || t.status === 'no_change' || t.status === 'skipped'
  const picker = startable && engines.length > 1 && (
    <label className="flex items-center gap-1.5 text-xs text-muted">
      on
      <select value={engine} onChange={(e) => setEngine(e.target.value)} className="rounded-md border border-line-2 bg-bg px-2 py-1.5 text-xs text-fg outline-none focus:border-accent">
        <option value="">default (lane setting)</option>
        {engines
          .filter((e) => e.installed)
          .map((e) => (
            <option key={e.id} value={e.id}>
              {e.label}
            </option>
          ))}
      </select>
    </label>
  )
  const go = (lane: StartChoice) => run(() => actions.start(t, lane, engine || undefined))
  return (
    <div className="flex flex-wrap items-center gap-2">
      {t.status === 'assigned' && (
        <>
          <Button variant="primary" disabled={busy} onClick={go('lite')}>
            Start lite
          </Button>
          <Button disabled={busy} onClick={go('full')}>
            Start full
          </Button>
          <Button disabled={busy} title="full lane at max effort: slower, deeper" onClick={go('max')}>
            Start max
          </Button>
          {picker}
          <Button variant="ghost" disabled={busy} onClick={run(() => actions.skip(t))}>
            Skip
          </Button>
        </>
      )}
      {(t.status === 'running' || t.status === 'queued') && (
        <ConfirmButton variant="default" label="Stop" confirm={`Stop ${t.id}: kill the lane, keep a resume note`} disabled={busy} onConfirm={() => void run(() => actions.stop(t))()} />
      )}
      {t.status === 'stopped' && (
        <Button variant="primary" disabled={busy} title="continues the same session from RESUME.md" onClick={run(() => actions.resume(t))}>
          Resume
        </Button>
      )}
      {t.status === 'review_ready' && (
        <Button variant="primary" disabled={busy || Boolean(t.pushing && !t.pushing.error)} onClick={run(() => actions.push(t))}>
          {t.pushing && !t.pushing.error ? 'Pushing…' : t.pushing?.error ? 'Try the push again' : t.prUrl || t.pr ? 'Push to the PR' : 'Push + draft PR'}
        </Button>
      )}
      {t.pushing && <p className={`w-full text-xs leading-snug ${t.pushing.error ? 'text-bad' : 'text-muted'}`}>{t.pushing.error ?? `${t.pushing.step}…`}</p>}
      {t.behindMain && t.status !== 'running' && t.status !== 'queued' && (
        <Button
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
      {canMoveInLinear(t) && (
        <>
          <Button variant={t.status === 'pr_draft' && !canMarkReady(t) ? 'primary' : 'default'} disabled={busy} onClick={run(() => actions.moveInLinear(t, 'qa'))}>
            Move to QA
          </Button>
          <Button variant={t.status === 'no_change' ? 'primary' : 'default'} disabled={busy} onClick={run(() => actions.moveInLinear(t, 'done'))}>
            Done in Linear
          </Button>
        </>
      )}
      {(t.status === 'failed' || t.status === 'no_change' || t.status === 'skipped') && (
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
          {picker}
        </>
      )}
      {(t.status === 'failed' || t.status === 'no_change' || t.status === 'stopped') && (
        <Button variant="ghost" disabled={busy} onClick={run(() => actions.done(t))}>
          Dismiss
        </Button>
      )}
      {t.worktree && (
        <Button
          variant="ghost"
          disabled={busy}
          title="Claude Code in your terminal, in this worktree, to ask about the work"
          onClick={run(async () => {
            const r = await actions.openClaude(t)
            notice({ id: t.id, title: `Opened in ${r.app}`, detail: r.resumed ? "the lane's own session" : 'a new session that reads the work first', tone: 'accent' })
          })}
        >
          Open in Claude
        </Button>
      )}
      {t.worktree && (
        <Button variant="ghost" disabled={busy} onClick={run(() => actions.openEditor(t))}>
          Open in editor
        </Button>
      )}
      {t.worktree && (
        <Button variant="ghost" onClick={() => void desktop.open(t.worktree ?? '')}>
          Open folder
        </Button>
      )}
      {t.port && (t.status === 'running' || t.status === 'review_ready') && (
        <Button variant="ghost" onClick={() => void desktop.open(`http://localhost:${t.port}`)}>
          Open dev server
        </Button>
      )}
      {t.status === 'review_ready' && (
        <Button variant="ghost" disabled={busy} onClick={run(() => actions.skip(t))}>
          Discard
        </Button>
      )}
    </div>
  )
}

function PrPanel({ ticket: t, busy, run }: { ticket: Ticket; busy: boolean; run: (fn: () => Promise<unknown>) => () => Promise<void> }) {
  if (!t.pr && t.status !== 'review_ready') return null
  const people = t.pr?.comments.filter((c) => !c.bot) ?? []
  return (
    <Section title="Pull request">
      {!t.pr ? (
        <div className="rounded-lg border border-line bg-panel px-4 py-3 text-[13px] leading-relaxed text-fg-2">
          Not pushed yet. Opens as a <strong className="font-medium text-fg">draft</strong> with your GitHub account.
          <div className="mt-1 text-xs text-muted">
            Title <span className="text-fg-2">{`${t.id}: ${t.title}`}</span> · body ends with <Mono>Ref: {t.id}</Mono>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-lg border border-line bg-panel px-4 py-3">
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            <button type="button" onClick={() => void desktop.open(t.pr?.url ?? '')} className="font-medium text-accent-fg hover:underline">
              #{t.pr.number}
            </button>
            <Pill>{prState(t)}</Pill>
            <Pill tone={t.pr.ci === 'success' ? 'ok' : t.pr.ci === 'failure' ? 'bad' : 'warn'}>CI {t.pr.ci}</Pill>
            <Pill tone={t.pr.reviewDecision === 'APPROVED' ? 'ok' : 'neutral'}>{t.pr.reviewDecision === 'none' ? 'review pending' : t.pr.reviewDecision.toLowerCase().replace('_', ' ')}</Pill>
            <span className="ml-auto text-dim">synced {new Date(t.pr.syncedAt).toLocaleTimeString([], { hour12: false })}</span>
          </div>
          {t.pr.greptile && <GreptileCard ticket={t} busy={busy} run={run} />}
          {people.length > 0 && <CommentPicker ticket={t} canAddress={t.status === 'pr_draft'} />}
          <PreviewQaCard ticket={t} />
        </div>
      )}
    </Section>
  )
}

function GreptileCard({ ticket: t, busy, run }: { ticket: Ticket; busy: boolean; run: (fn: () => Promise<unknown>) => () => Promise<void> }) {
  const g = t.pr?.greptile
  if (!g) return null
  const tone = g.score === null ? 'neutral' : g.score >= 5 ? 'ok' : g.score >= 4 ? 'warn' : 'bad'
  return (
    <motion.div layout className="flex flex-col gap-2 rounded-md border border-line bg-bg px-3 py-2.5">
      <div className="flex items-center gap-2 text-xs">
        <strong className="font-medium text-fg">Greptile</strong>
        <Pill tone={tone}>{g.score ?? '?'}/5</Pill>
        {g.impact && <span className="text-muted">{g.impact}</span>}
        <button type="button" onClick={() => void desktop.open(g.url)} className="ml-auto text-accent-fg hover:underline">
          Open
        </button>
      </div>
      {g.findings.length === 0 ? (
        <div className="text-xs text-muted">Nothing to fix.</div>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {g.findings.map((f, i) => (
            <li key={`${f.title}-${i}`}>
              <details className="group text-xs">
                <summary className="flex cursor-pointer items-start gap-2 text-fg-2">
                  {f.level && <span className={`font-mono text-[11px] font-semibold ${f.level === 'P0' || f.level === 'P1' ? 'text-bad' : 'text-warn'}`}>{f.level}</span>}
                  <span className="flex-1">{f.title}</span>
                  {f.path && <Mono className="text-dim">{f.path.split('/').pop()}{f.line ? `:${f.line}` : ''}</Mono>}
                </summary>
                <div className="mt-1 ml-7 whitespace-pre-wrap text-muted">{f.body}</div>
              </details>
            </li>
          ))}
        </ol>
      )}
      {g.findings.length > 0 && t.status === 'pr_draft' && (
        <Button className="self-start" disabled={busy} onClick={run(() => actions.fixGreptile(t))}>
          Fix with the lane
        </Button>
      )}
      {t.status === 'running' && t.greptileFixing && <div className="text-xs text-accent-fg">The lane is working on these…</div>}
    </motion.div>
  )
}
