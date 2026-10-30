import { type BudgetStatus, type Health, type LiveLine, openComments, type Ticket } from '@ticketflow/shared'
import { motion } from 'motion/react'
import { useState } from 'react'
import { actions } from '../lib/api.js'
import { useNow } from '../lib/estimates.js'
import { failed, notice } from '../lib/notice.js'
import { href } from '../lib/route.js'
import { desktop } from '../lib/tauri.js'
import { CommentPicker } from './Comments.js'
import { IssueTab, PrTab } from './Context.js'
import { DiffPanel } from './Diff.js'
import { Instruct } from './Instruct.js'
import { Journal } from './Journal.js'
import { LiveLog } from './Live.js'
import { NowCard } from './NowCard.js'
import { PreviewQaCard } from './PreviewQa.js'
import { Stepper } from './Stepper.js'
import { compactStat, lastChange, laneLabel, priorityLabel, prState, STATUS_LABEL, statusTone, summarySections } from './status.js'
import { Supervision } from './Supervision.js'
import { Button, Label, Mono, Pill, rise, Section, stagger, timeAgo } from './ui.js'
import { VisualTab, visualState } from './Visual.js'

type Left = 'overview' | 'changes' | 'pr' | 'visual' | 'issue'
type Right = 'activity' | 'comments' | 'log'
type Run = (fn: () => Promise<unknown>) => () => Promise<void>

export function TicketView({
  ticket: t,
  live,
  models,
  engines = [],
  budget,
}: {
  ticket: Ticket
  live: readonly LiveLine[]
  models?: Health['lanes']['models']
  engines?: NonNullable<Health['lanes']['engines']>
  budget?: BudgetStatus | undefined
}) {
  const [busy, setBusy] = useState(false)
  const [left, setLeft] = useState<Left>('overview')
  const comments = openComments(t)
  const [right, setRight] = useState<Right>(t.status === 'running' ? 'log' : comments.length || t.pr?.greptile?.findings.length ? 'comments' : 'activity')
  const run: Run = (fn) => async () => {
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
  const total = (t.journal ?? []).reduce((sum, j) => sum + (Number(j.meta?.cost) || 0), 0)
  const vs = visualState(t)
  const leftTabs: readonly [Left, string, number?][] = [
    ['overview', 'Overview'],
    ['changes', 'Changes'],
    ['pr', t.pr ? 'PR description' : 'PR draft'],
    ['visual', 'Visual'],
    ['issue', 'Linear issue'],
  ]
  const rightTabs: readonly [Right, string, number?][] = [
    ['activity', 'Activity'],
    ['comments', 'Comments', comments.length + (t.pr?.greptile?.findings.length ?? 0)],
    ['log', 'Lane log'],
  ]

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,7fr)_minmax(0,5fr)] grid-rows-[minmax(0,1fr)] max-lg:flex max-lg:flex-col max-lg:overflow-y-auto max-md:pb-24">
      <div className="flex min-h-0 flex-col border-r border-line max-lg:shrink-0 max-lg:border-r-0">
        <motion.div variants={stagger} initial="hidden" animate="show" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-5 max-lg:overflow-visible max-md:px-4">
          <motion.div variants={rise} className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <a href={href.board} className="hover:text-fg max-md:flex max-md:min-h-9 max-md:items-center">
              Board
            </a>
            <span className="text-dim">›</span>
            <span className="font-semibold text-fg">{t.id}</span>
            <Pill tone={statusTone(t.status)}>{STATUS_LABEL[t.status]}</Pill>
            <Updated ticket={t} />
            <span className="ml-auto">
              {laneLabel(t, models)}
              {total > 0 ? ` · $${total.toFixed(2)} spent` : ''}
            </span>
          </motion.div>

          <motion.h1 layoutId={`title-${t.id}`} variants={rise} className="text-lg leading-snug font-semibold max-md:text-base">
            {t.title}
          </motion.h1>

          <motion.div variants={rise} className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted">
            <span>{t.createdBy.split('@')[0]}</span>
            {priority && <Pill>{priority}</Pill>}
            {t.labels.map((l) => (
              <Label key={l} name={l} />
            ))}
            <Mono className="text-dim">
              {t.branch}
              {t.port ? ` · :${t.port}` : ''}
            </Mono>
          </motion.div>

          <motion.div variants={rise}>
            <Links ticket={t} busy={busy} run={run} />
          </motion.div>

          <motion.div variants={rise}>
            <Stepper ticket={t} />
          </motion.div>

          <motion.div variants={rise}>
            <NowCard ticket={t} busy={busy} run={run} budget={budget} engines={engines} last={live.at(-1)} />
          </motion.div>

          <Chips ticket={t} onComments={() => setRight('comments')} onVisual={() => setLeft('visual')} visual={vs} />

          <motion.div variants={rise}>
            <TabBar id="left" items={leftTabs} value={left} onChange={setLeft} />
          </motion.div>

          {left === 'overview' && <Overview ticket={t} />}
          {left === 'changes' && <Changes ticket={t} />}
          {left === 'pr' && <PrTab ticket={t} />}
          {left === 'visual' && <VisualTab ticket={t} />}
          {left === 'issue' && <IssueTab ticket={t} />}
        </motion.div>
        {t.worktree && (
          <div className="shrink-0 border-t border-line bg-sunk/60 px-6 py-3 max-md:px-4">
            <Instruct ticket={t} />
          </div>
        )}
      </div>

      <div className="flex min-h-0 flex-col gap-3 px-6 py-5 max-lg:shrink-0 max-lg:border-t max-lg:border-line max-md:px-4">
        <TabBar id="right" items={rightTabs} value={right} onChange={setRight} />
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto max-lg:overflow-visible">
          {right === 'activity' && <ActivityTab ticket={t} />}
          {right === 'comments' && <CommentsTab ticket={t} busy={busy} run={run} />}
          {right === 'log' && <LiveLog id={t.id} lines={live} running={t.status === 'running'} className="min-h-[320px] flex-1" />}
        </div>
      </div>
    </div>
  )
}

function TabBar<K extends string>({ id, items, value, onChange }: { id: string; items: readonly (readonly [K, string, number?])[]; value: K; onChange: (k: K) => void }) {
  return (
    <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-line text-xs" role="tablist">
      {items.map(([key, label, count]) => (
        <button key={key} type="button" role="tab" aria-selected={value === key} onClick={() => onChange(key)} className={`relative shrink-0 px-2.5 pt-1 pb-2 max-md:min-h-10 ${value === key ? 'text-fg' : 'text-muted hover:text-fg'}`}>
          {label}
          {count ? <span className="ml-1.5 rounded-full bg-raised px-1.5 text-[10.5px] text-fg-2">{count}</span> : null}
          {value === key && <motion.span layoutId={`tab-${id}`} className="absolute inset-x-1 -bottom-px h-[2px] rounded-full bg-accent-fg" transition={{ type: 'spring', stiffness: 500, damping: 36 }} />}
        </button>
      ))}
    </div>
  )
}

// Everywhere this ticket lives, always in the same spot.
function Links({ ticket: t, busy, run }: { ticket: Ticket; busy: boolean; run: Run }) {
  const link = 'rounded-md border border-line-2 bg-panel px-2.5 py-1 text-xs text-fg-2 transition-colors hover:border-accent hover:text-fg disabled:opacity-50 max-md:min-h-9'
  return (
    <div className="flex flex-wrap gap-1.5">
      <button type="button" className={link} onClick={() => void desktop.open(t.url)}>
        Linear ↗
      </button>
      {t.pr && (
        <button type="button" className={link} onClick={() => void desktop.open(t.pr?.url ?? '')}>
          GitHub #{t.pr.number} ↗
        </button>
      )}
      {t.worktree && (
        <button
          type="button"
          className={link}
          disabled={busy}
          title="Claude Code in your terminal, in this worktree, to ask about the work"
          onClick={run(async () => {
            const r = await actions.openClaude(t)
            notice({ id: t.id, title: `Opened in ${r.app}`, detail: r.resumed ? "the lane's own session" : 'a new session that reads the work first', tone: 'accent' })
          })}
        >
          Open in Claude
        </button>
      )}
      {t.worktree && (
        <button type="button" className={link} disabled={busy} onClick={run(() => actions.openEditor(t))}>
          Editor
        </button>
      )}
      {t.worktree && (
        <button type="button" className={link} onClick={() => void desktop.open(t.worktree ?? '')}>
          Folder
        </button>
      )}
      {t.port && (t.status === 'running' || t.status === 'review_ready') && (
        <button type="button" className={link} onClick={() => void desktop.open(`http://localhost:${t.port}`)}>
          Dev server :{t.port}
        </button>
      )}
    </div>
  )
}

// What the PR looks like from outside: only once there is a PR, only what has an answer.
function Chips({ ticket: t, onComments, onVisual, visual }: { ticket: Ticket; onComments: () => void; onVisual: () => void; visual: ReturnType<typeof visualState> }) {
  const pr = t.pr
  const g = pr?.greptile
  const open = openComments(t).length
  const chips: React.ReactNode[] = []
  if (pr) {
    if (pr.ci === 'success' || pr.ci === 'failure') chips.push(<Pill key="ci" tone={pr.ci === 'success' ? 'ok' : 'bad'}>CI {pr.ci === 'success' ? 'green' : 'failing'}</Pill>)
    if (pr.reviewDecision && pr.reviewDecision !== 'none') chips.push(<Pill key="rv" tone={pr.reviewDecision === 'APPROVED' ? 'ok' : 'warn'}>{pr.reviewDecision.toLowerCase().replace('_', ' ')}</Pill>)
    if (g)
      chips.push(
        <button key="g" type="button" onClick={onComments}>
          <Pill tone={g.score === null ? 'neutral' : g.score >= 5 ? 'ok' : g.score >= 4 ? 'warn' : 'bad'}>
            Greptile {g.score ?? '?'}/5{g.findings.length ? ` · ${g.findings.length}` : ''}
          </Pill>
        </button>,
      )
    if (open)
      chips.push(
        <button key="c" type="button" onClick={onComments}>
          <Pill tone="warn">
            {open} comment{open === 1 ? '' : 's'}
          </Pill>
        </button>,
      )
    if (t.previewQa?.status === 'done') chips.push(<Pill key="qa" tone={t.previewQa.verdict === 'pass' ? 'ok' : 'warn'}>preview QA {t.previewQa.verdict}</Pill>)
    if (t.behindMain) chips.push(<Pill key="main" tone={t.behindMain.conflicts ? 'bad' : 'neutral'}>↓ {t.behindMain.commits} behind main</Pill>)
  }
  if (visual)
    chips.push(
      <button key="v" type="button" onClick={onVisual}>
        <Pill tone={visual.tone}>👁 {visual.label}</Pill>
      </button>,
    )
  if (t.autopilot && t.status !== 'done') chips.push(<Pill key="ap" tone={t.autopilot.held ? 'warn' : 'neutral'}>{t.autopilot.held ? `autopilot held: ${t.autopilot.held}` : 'autopilot'}</Pill>)
  if (!chips.length) return null
  return (
    <motion.div variants={rise} className="flex flex-wrap items-center gap-1.5 text-xs">
      {pr && <span className="text-dim">#{pr.number} {prState(t)} · synced {timeAgo(pr.syncedAt)} ago</span>}
      {chips}
    </motion.div>
  )
}

function Overview({ ticket: t }: { ticket: Ticket }) {
  const sections = summarySections(t.summary).filter((s) => !/^(commits|files touched|gate output)$/i.test(s.title))
  const empty = !sections.length && !t.supervision && !t.pr && !(t.status === 'assigned' && t.description)
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-4">
      {t.status === 'assigned' && t.description && (
        <Section title="From the ticket">
          <p className="line-clamp-6 rounded-lg border border-line bg-panel px-4 py-3 text-[13px] leading-relaxed whitespace-pre-wrap text-fg-2">{t.description}</p>
        </Section>
      )}
      {sections.length > 0 && (
        <Section title="Summary from the lane">
          <div className="flex flex-col gap-3 rounded-lg border border-line bg-panel px-4 py-3.5 text-[13px] leading-relaxed text-fg-2">
            {sections.map((s) => (
              <div key={s.title} className={/manual test|known risks|regression|start here/i.test(s.title) ? 'border-l-2 border-warn pl-3' : ''}>
                <div className="mb-0.5 font-medium text-fg">{s.title}</div>
                <div className="whitespace-pre-wrap">{s.body.replace(/\*\*/g, '').replace(/`/g, '')}</div>
              </div>
            ))}
          </div>
        </Section>
      )}
      {t.supervision && <Supervision report={t.supervision} />}
      {t.pr && <PreviewQaCard ticket={t} />}
      {empty && <div className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs text-dim">Nothing here yet. The lane's summary, the supervisor's check and the preview QA land here.</div>}
    </motion.div>
  )
}

function Changes({ ticket: t }: { ticket: Ticket }) {
  if (!t.worktree || t.status === 'queued') return <div className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs text-dim">No changes yet.</div>
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-4">
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
      <DiffPanel ticket={t} />
    </motion.div>
  )
}

function ActivityTab({ ticket: t }: { ticket: Ticket }) {
  return (
    <div className="flex flex-col gap-4">
      <Journal ticket={t} />
      <details className="shrink-0 text-xs">
        <summary className="cursor-pointer text-muted">Raw events · {t.events.length}</summary>
        <div className="mt-2 font-mono text-[11px] leading-[1.7] text-muted">
          {[...t.events].reverse().map((e) => (
            <div key={e.at + e.kind + e.message} className="flex gap-3 max-md:flex-wrap max-md:gap-x-3 max-md:gap-y-0">
              <span className="shrink-0 text-dim">{new Date(e.at).toLocaleString([], { hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
              <span className="w-20 shrink-0">{e.kind}</span>
              <span className="break-words">{e.message}</span>
            </div>
          ))}
        </div>
      </details>
    </div>
  )
}

function CommentsTab({ ticket: t, busy, run }: { ticket: Ticket; busy: boolean; run: Run }) {
  if (!t.pr)
    return (
      <div className="rounded-lg border border-line bg-panel px-4 py-3 text-[13px] leading-relaxed text-fg-2">
        No PR yet. It opens as a <strong className="font-medium text-fg">draft</strong> with your GitHub account when you push.
        <div className="mt-1 text-xs text-muted">
          Title <span className="text-fg-2">{`${t.id}: ${t.title}`}</span> · body ends with <Mono>Ref: {t.id}</Mono>
        </div>
      </div>
    )
  const people = t.pr.comments.filter((c) => !c.bot)
  return (
    <div className="flex flex-col gap-3">
      {t.pr.greptile && <GreptileCard ticket={t} busy={busy} run={run} />}
      {people.length > 0 ? <CommentPicker ticket={t} canAddress={t.status === 'pr_draft'} /> : <div className="text-xs text-dim">No comments from people on the PR.</div>}
    </div>
  )
}

function GreptileCard({ ticket: t, busy, run }: { ticket: Ticket; busy: boolean; run: Run }) {
  const g = t.pr?.greptile
  if (!g) return null
  const tone = g.score === null ? 'neutral' : g.score >= 5 ? 'ok' : g.score >= 4 ? 'warn' : 'bad'
  return (
    <motion.div layout className="flex flex-col gap-2 rounded-lg border border-line bg-panel px-3 py-2.5">
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
                  {f.path && (
                    <Mono className="text-dim">
                      {f.path.split('/').pop()}
                      {f.line ? `:${f.line}` : ''}
                    </Mono>
                  )}
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

function Updated({ ticket: t }: { ticket: Ticket }) {
  useNow(30_000)
  const c = lastChange(t)
  return (
    <span className="min-w-0 truncate text-dim" title={`${c.what} · ${new Date(c.at).toLocaleString()}`}>
      updated {timeAgo(c.at)} ago · {c.what}
    </span>
  )
}
