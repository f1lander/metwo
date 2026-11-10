import { type AndroidDevice, type BudgetStatus, type Health, type LiveLine, openComments, type Ticket } from '@ticketflow/shared'
import { ReplayCard } from './Replay.js'
import { motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { TELL_EVENT } from '../lib/mascot.js'
import { actions } from '../lib/api.js'
import { useNow } from '../lib/estimates.js'
import { failed, notice } from '../lib/notice.js'
import { href } from '../lib/route.js'
import { desktop } from '../lib/tauri.js'
import { Chat } from './Chat.js'
import { ConflictsCard } from './Conflicts.js'
import { TicketTimeline } from './Timeline.js'
import { CiCard } from './Ci.js'
import { ChecksCard } from './Checks.js'
import { CommentPicker } from './Comments.js'
import { IssueTab, PrTab } from './Context.js'
import { DiffPanel } from './Diff.js'
import { HandTestCard } from './HandTest.js'
import { Instruct } from './Instruct.js'
import { Journal } from './Journal.js'
import { LiveLog } from './Live.js'
import { Markdown } from './Markdown.js'
import { NowCard } from './NowCard.js'
import { PreviewQaCard } from './PreviewQa.js'
import { Stepper } from './Stepper.js'
import { compactStat, lastChange, laneLabel, priorityLabel, prState, STATUS_LABEL, statusTone, summarySections } from './status.js'
import { Supervision } from './Supervision.js'
import { Button, Label, linearAvatar, Mono, Person, Pill, rise, Section, stagger, timeAgo } from './ui.js'
import { VisualTab, visualState } from './Visual.js'

type Left = 'overview' | 'changes' | 'pr' | 'visual' | 'issue'
type Right = 'chat' | 'activity' | 'comments' | 'log'
type Run = (fn: () => Promise<unknown>) => () => Promise<void>

export function TicketView({
  ticket: t,
  live,
  models,
  engines = [],
  budget,
  principles,
  phones = [],
  mo = false,
  replays = [],
}: {
  ticket: Ticket
  live: readonly LiveLine[]
  models?: Health['lanes']['models']
  engines?: NonNullable<Health['lanes']['engines']>
  budget?: BudgetStatus | undefined
  principles?: Health['lanes']['principles']
  phones?: readonly AndroidDevice[]
  // Mo is out: he is the Tell the agent button
  mo?: boolean
  // this ticket's replays (REPLAY-n)
  replays?: readonly Ticket[]
}) {
  const [busy, setBusy] = useState(false)
  const [focus, setFocus] = useState(0)
  const rightCol = useRef<HTMLDivElement>(null)
  const openChat = () => {
    setRight('chat')
    setFocus((n) => n + 1)
    if (window.matchMedia('(max-width: 1023px)').matches) rightCol.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const chatRef = useRef(openChat)
  chatRef.current = openChat
  // a click on Mo opens this ticket's chat
  useEffect(() => {
    if (!t.worktree) return
    const onTell = (e: Event) => {
      ;(e as CustomEvent<{ handled: boolean }>).detail.handled = true
      chatRef.current()
    }
    addEventListener(TELL_EVENT, onTell)
    return () => removeEventListener(TELL_EVENT, onTell)
  }, [t.worktree])
  const [left, setLeft] = useState<Left>('overview')
  // opening a ticket with a PR asks GitHub for its state now, not at the next sync
  const hasPr = Boolean(t.pr || t.prUrl)
  useEffect(() => {
    if (hasPr) void actions.syncPr(t).catch(() => undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.id, hasPr])
  const comments = openComments(t)
  const talked = (t.journal ?? []).some((j) => j.kind === 'question' || j.kind === 'answer' || j.kind === 'ask' || j.title.startsWith('You asked the lane'))
  const [logView, setLogView] = useState<'log' | 'timeline'>(() => {
    try {
      return localStorage.getItem('metwo.logView') === 'timeline' ? 'timeline' : 'log'
    } catch {
      return 'log'
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem('metwo.logView', logView)
    } catch {
      // private mode: the choice just isn't remembered
    }
  }, [logView])
  const [right, setRight] = useState<Right>(t.status === 'running' ? 'log' : t.status === 'needs_input' ? 'chat' : comments.length || t.pr?.greptile?.findings.length ? 'comments' : talked ? 'chat' : 'activity')
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
    ['chat', 'Chat'],
    ['activity', 'Activity'],
    ['comments', 'Comments', comments.length + (t.pr?.greptile?.findings.length ?? 0)],
    ['log', 'Lane log'],
  ]

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,7fr)_minmax(0,5fr)] grid-rows-[minmax(0,1fr)] max-lg:flex max-lg:flex-col max-lg:overflow-y-auto max-md:pb-24">
      <div className="relative flex min-h-0 flex-col border-r border-line max-lg:shrink-0 max-lg:border-r-0">
        <motion.div variants={stagger} initial="hidden" animate="show" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pt-5 pb-20 max-lg:overflow-visible max-md:px-4 [&>*]:shrink-0">
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

          {/* the title flies in from the board card only when you open a ticket, not when a tab below changes the height */}
          <motion.h1 layoutId={`title-${t.id}`} layoutDependency={t.id} variants={rise} className="text-lg leading-snug font-semibold max-md:text-base">
            {t.title}
          </motion.h1>

          <motion.div variants={rise} className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted">
            <Person name={t.createdBy.split('@')[0] ?? t.createdBy} src={linearAvatar(t.creator)} />
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

          {t.worktree && !['assigned', 'queued', 'running'].includes(t.status) && (t.commits || t.pr || t.testPlan || t.humanTests?.length) && (
            <motion.div variants={rise}>
              <HandTestCard ticket={t} phones={phones} />
            </motion.div>
          )}

          {(t.replay || t.events.some((e) => e.kind === 'start')) && (
            <motion.div variants={rise}>
              <ReplayCard ticket={t} replays={replays} />
            </motion.div>
          )}

          <Chips ticket={t} onComments={() => setRight('comments')} onVisual={() => setLeft('visual')} visual={vs} />

          <motion.div variants={rise}>
            <TabBar id="left" items={leftTabs} value={left} onChange={setLeft} />
          </motion.div>

          <TabPanel tab={left}>
            {left === 'overview' && <Overview ticket={t} principles={principles} phones={phones} />}
            {left === 'changes' && <Changes ticket={t} />}
            {left === 'pr' && <PrTab ticket={t} />}
            {left === 'visual' && <VisualTab ticket={t} />}
            {left === 'issue' && <IssueTab ticket={t} />}
          </TabPanel>
        </motion.div>
        {t.worktree && !mo && <TellButton ticket={t} onClick={openChat} />}
      </div>

      <div ref={rightCol} className="flex min-h-0 flex-col gap-3 px-6 py-5 max-lg:shrink-0 max-lg:border-t max-lg:border-line max-md:px-4">
        <TabBar id="right" items={rightTabs} value={right} onChange={setRight} />
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto max-lg:overflow-visible">
          {right === 'chat' && <Chat ticket={t} />}
          {right === 'activity' && <ActivityTab ticket={t} />}
          {right === 'comments' && <CommentsTab ticket={t} busy={busy} run={run} />}
          {right === 'log' && (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              <div className="inline-flex self-end rounded-md border border-line-2 p-0.5 text-xs" role="group" aria-label="lane log view">
                {(['log', 'timeline'] as const).map((v) => (
                  <button key={v} type="button" aria-pressed={logView === v} onClick={() => setLogView(v)} className={`rounded px-2 py-0.5 capitalize ${logView === v ? 'bg-raised text-fg' : 'text-muted hover:text-fg'}`}>
                    {v}
                  </button>
                ))}
              </div>
              {logView === 'timeline' ? <TicketTimeline ticket={t} /> : <LiveLog id={t.id} lines={live} running={t.status === 'running'} className="min-h-[320px] flex-1" />}
            </div>
          )}
        </div>
        {right === 'chat' && t.worktree && (
          <div className="shrink-0 border-t border-line pt-3">
            <Instruct ticket={t} docked focusKey={focus} />
          </div>
        )}
      </div>
    </div>
  )
}

// A tab's content keeps the old tab's height while the new one loads, so the page doesn't shrink,
// scroll back up and pull the header down under you; it lets go once the new content settles.
function TabPanel({ tab, children }: { tab: string; children: React.ReactNode }) {
  const inner = useRef<HTMLDivElement>(null)
  const last = useRef(tab)
  const height = useRef(0)
  const [hold, setHold] = useState(0)
  if (last.current !== tab) {
    last.current = tab
    if (height.current && hold !== height.current) setHold(height.current)
  }
  useEffect(() => {
    const el = inner.current
    if (!el) return
    let quiet: ReturnType<typeof setTimeout> | undefined
    const ro = new ResizeObserver(() => {
      const h = el.offsetHeight
      if (!hold) {
        height.current = h
        return
      }
      clearTimeout(quiet)
      // let go when the new content reaches the old height, or stops growing
      quiet = setTimeout(() => setHold(0), h >= hold ? 0 : 700)
    })
    ro.observe(el)
    const giveUp = hold ? setTimeout(() => setHold(0), 2500) : undefined
    return () => {
      ro.disconnect()
      clearTimeout(quiet)
      clearTimeout(giveUp)
    }
  }, [hold, tab])
  return (
    <div style={hold ? { minHeight: hold } : undefined}>
      <div ref={inner} className="flex flex-col gap-4">
        {children}
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
      {t.port && (t.status === 'running' || t.status === 'review_ready') && (
        <button type="button" className={link} onClick={() => void desktop.open(`http://localhost:${t.port}`)}>
          Dev server :{t.port}
        </button>
      )}
      {t.worktree && <MoreLinks ticket={t} busy={busy} run={run} className={link} />}
    </div>
  )
}

// The worktree's tools, out of the way until you want them.
function MoreLinks({ ticket: t, busy, run, className }: { ticket: Ticket; busy: boolean; run: Run; className: string }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])
  const item = 'flex w-full flex-col items-start rounded-md px-2.5 py-1.5 text-left text-xs text-fg hover:bg-raised disabled:opacity-50'
  const pick = (fn: () => Promise<void>) => () => {
    setOpen(false)
    void fn()
  }
  return (
    <div ref={box} className="relative">
      <button type="button" className={className} aria-haspopup="menu" aria-expanded={open} aria-label="More: Claude, editor, folder" onClick={() => setOpen((o) => !o)}>
        ···
      </button>
      {open && (
        <div role="menu" className="absolute top-full left-0 z-30 mt-1 flex w-60 flex-col rounded-lg border border-line-2 bg-panel p-1 shadow-xl">
          <button
            type="button"
            role="menuitem"
            className={item}
            disabled={busy}
            onClick={pick(
              run(async () => {
                const r = await actions.openClaude(t)
                notice({ id: t.id, title: `Opened in ${r.app}`, detail: r.resumed ? "the lane's own session" : 'a new session that reads the work first', tone: 'accent' })
              }),
            )}
          >
            Open in Claude
            <span className="text-[11px] text-muted">Claude Code in your terminal, in this worktree</span>
          </button>
          <button type="button" role="menuitem" className={item} disabled={busy} onClick={pick(run(() => actions.openEditor(t)))}>
            Open in the editor
          </button>
          <button type="button" role="menuitem" className={item} onClick={pick(async () => void desktop.open(t.worktree ?? ''))}>
            Show the folder
            <span className="truncate font-mono text-[11px] text-muted">{t.worktree}</span>
          </button>
        </div>
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

// Whether this ticket's lanes read the pstack principles; applies from the next run or review pass.
function PrinciplesLine({ ticket: t, pack }: { ticket: Ticket; pack: NonNullable<Health['lanes']['principles']> }) {
  const [busy, setBusy] = useState(false)
  const on = t.principles ?? pack.enabled
  const set = (v: boolean | null) => async () => {
    setBusy(true)
    try {
      await actions.principles(t, v)
    } catch (err) {
      failed(err, t.id)
    } finally {
      setBusy(false)
    }
  }
  return (
    <motion.div variants={rise} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line bg-panel px-4 py-2.5 text-xs">
      <span className="font-medium text-fg">Engineering principles</span>
      <span className="text-muted">
        pstack <Mono>{pack.ref.slice(0, 7)}</Mono> · {on ? 'on' : 'off'}
        {t.principles === undefined ? ' (from Settings)' : ' for this ticket'}
      </span>
      <span className="ml-auto flex gap-2">
        {t.principles !== undefined && (
          <button type="button" disabled={busy} className="text-muted hover:text-fg disabled:opacity-50" onClick={() => void set(null)()}>
            Follow Settings
          </button>
        )}
        <Button disabled={busy} onClick={() => void set(!on)()}>
          {on ? 'Turn off here' : 'Turn on here'}
        </Button>
      </span>
    </motion.div>
  )
}

// The ticket's description as Linear renders it: long ones fold, with a toggle to read all of it.
function TicketText({ ticket: t }: { ticket: Ticket }) {
  const long = t.description.length > 900 || t.description.split('\n').length > 18
  const [open, setOpen] = useState(!long)
  return (
    <div className="relative rounded-lg border border-line bg-panel px-4 py-3">
      <div className={open ? '' : 'max-h-64 overflow-hidden'}>
        <Markdown source={t.description} ticketId={t.id} className="md-sm" />
      </div>
      {long && (
        <>
          {!open && <div aria-hidden="true" className="pointer-events-none absolute inset-x-px bottom-9 h-16 rounded-b-lg bg-gradient-to-t from-panel to-transparent" />}
          <button type="button" className="mt-2 text-xs text-accent-fg hover:underline" onClick={() => setOpen((o) => !o)}>
            {open ? 'Show less' : 'Show all of it'}
          </button>
        </>
      )}
    </div>
  )
}

function Overview({ ticket: t, principles }: { ticket: Ticket; principles?: Health['lanes']['principles'] | undefined; phones: readonly AndroidDevice[] }) {
  const sections = summarySections(t.summary).filter((s) => !/^(commits|files touched|gate output)$/i.test(s.title))
  const empty = !sections.length && !t.supervision && !t.pr && !t.testPlan && !t.humanTests?.length && !(t.status === 'assigned' && t.description)
  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="flex flex-col gap-4">
      {t.status === 'assigned' && t.description && (
        <Section title="From the ticket">
          <TicketText ticket={t} />
        </Section>
      )}
      <ConflictsCard ticket={t} />
      <CiCard ticket={t} />
      {(sections.length > 0 || t.supervision) && (
        <Folds
          key={t.id}
          items={[
            ...sections.map((s) => ({ id: s.title, title: s.title, summary: oneLine(s.body), warn: /manual test|known risks|regression|start here/i.test(s.title), body: <Markdown source={s.body} ticketId={t.id} className="md-sm" /> })),
            ...(t.supervision
              ? [{ id: '__supervisor', title: 'Supervisor', summary: `${t.supervision.verdict} · ${t.supervision.gates.filter((g) => g.ok).length}/${t.supervision.gates.length} gates${t.supervision.findings.length ? ` · ${t.supervision.findings.length} finding${t.supervision.findings.length === 1 ? '' : 's'}` : ''} · ${t.supervision.engine}`, warn: t.supervision.verdict === 'fail', body: <Supervision report={t.supervision} /> }]
              : []),
          ]}
        />
      )}
      <ChecksCard ticket={t} />
      {t.pr && <PreviewQaCard ticket={t} />}
      {principles && (principles.enabled || t.principles !== undefined) && <PrinciplesLine ticket={t} pack={principles} />}
      {empty && <div className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs text-dim">Nothing here yet. The lane's summary, the supervisor's check and the preview QA land here.</div>}
    </motion.div>
  )
}

// The first line of a section, as plain text, for its folded row.
function oneLine(md: string): string {
  const line = md
    .split('\n')
    .map((l) => l.replace(/^\s*(#+|[-*+]|\d+[.)]|>)\s*/, '').replace(/[*_`]/g, '').trim())
    .find((l) => l && !/^(must hold|must not break)/i.test(l))
  return (line ?? '').slice(0, 200)
}

// The lane's summary as rows that fold: a title and its first line, opened when it needs you.
function Folds({ items }: { items: readonly { id: string; title: string; summary: string; warn?: boolean; body: React.ReactNode }[] }) {
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(items.map((i) => [i.id, Boolean(i.warn)])))
  const anyClosed = items.some((i) => !open[i.id])
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center text-xs text-muted">
        <span>Summary from the lane</span>
        <button type="button" className="ml-auto hover:text-fg" onClick={() => setOpen(Object.fromEntries(items.map((i) => [i.id, anyClosed])))}>
          {anyClosed ? 'Open all' : 'Fold all'}
        </button>
      </div>
      <div className="rounded-xl border border-line bg-panel">
        {items.map((i, n) => (
          <div key={i.id} className={n ? 'border-t border-line' : ''}>
            <button type="button" aria-expanded={Boolean(open[i.id])} onClick={() => setOpen((o) => ({ ...o, [i.id]: !o[i.id] }))} className="flex w-full items-baseline gap-2.5 px-4 py-2.5 text-left text-[13px]">
              <span aria-hidden="true" className="w-3 shrink-0 text-[11px] text-muted">{open[i.id] ? '▾' : '▸'}</span>
              <span className={`shrink-0 font-medium ${i.warn ? 'text-warn' : 'text-fg'}`}>{i.title}</span>
              {!open[i.id] && <span className="min-w-0 truncate text-muted">{i.summary}</span>}
            </button>
            {open[i.id] && <div className="pr-4 pb-3.5 pl-[42px] text-[13px] leading-relaxed text-fg-2">{i.body}</div>}
          </div>
        ))}
      </div>
    </section>
  )
}

function Changes({ ticket: t }: { ticket: Ticket }) {
  if (!t.worktree || t.status === 'queued') return <div className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs text-dim">No changes yet.</div>
  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="flex flex-col gap-4">
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
        <span className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={run(() => actions.fixGreptile(t, false))}>
            Fix with the lane
          </Button>
          <Button variant="ghost" disabled={busy} title="a fresh session on a cheaper model, no screenshots or e2e; you check it by hand" onClick={run(() => actions.fixGreptile(t, true))}>
            Quick fix
          </Button>
        </span>
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

// Always on screen: opens the chat with the composer focused. The ring spins while the lane
// works and turns amber when it is asking you.
function TellButton({ ticket: t, onClick }: { ticket: Ticket; onClick: () => void }) {
  const working = t.status === 'running' || t.status === 'queued'
  const asking = t.status === 'needs_input'
  const queued = Boolean(t.queuedInstruction)
  return (
    <div className="pointer-events-none absolute right-6 bottom-5 z-20 max-md:fixed max-md:right-4 max-md:bottom-24">
      <button type="button" onClick={onClick} className={`vibe pointer-events-auto ${working ? 'vibe-fast' : ''} ${asking ? 'vibe-warn' : ''}`} aria-label="Tell the agent: open the chat">
        <span className="flex items-center gap-2 px-4 py-2 text-[13px] font-medium text-fg">
          <span aria-hidden="true" className={asking ? 'text-warn' : 'text-accent-fg'}>
            ✦
          </span>
          {asking ? 'The agent is asking' : queued ? 'Instruction queued' : 'Tell the agent'}
          {working && !queued && <span className="text-[11px] font-normal text-muted">working…</span>}
        </span>
      </button>
    </div>
  )
}
