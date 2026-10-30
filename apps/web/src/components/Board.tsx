import { fmtMinutes, type LiveLine, openComments, type Ticket, usd } from '@ticketflow/shared'
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { actions, type LiveMap } from '../lib/api.js'
import { href } from '../lib/route.js'
import { estLine, useRunClock } from './NowCard.js'
import { useEstimates, useNow } from '../lib/estimates.js'
import { canMarkReady, currentStep, lastChange, STEPS, pushLine, COLUMNS, compactStat, greptileClear, modelName, plural, prState, priorityLabel, quietMinutes, STATUS_LABEL, STUCK_MINUTES, stageProgress, statusTone, summarySection } from './status.js'
import { useTriage } from '../lib/triage.js'
import { Button, ConfirmButton, Count, Label, LabelDot, Mono, Pill, Progress, timeAgo, TriageChip } from './ui.js'
import { visualState } from './Visual.js'
import { openCycle } from './Cycle.js'
import { failed } from '../lib/notice.js'

const CARD_SPRING = { type: 'spring', stiffness: 340, damping: 32, mass: 0.8 } as const

interface Filter {
  readonly q: string
  readonly labels: readonly string[]
  readonly quick: readonly ('small' | 'autopilot' | 'pr')[]
}

// The board's filters live in the URL (#/board?l=UI,Bug&f=small&q=modal) so a view can be shared or bookmarked.
function readFilter(): Filter {
  const qs = new URLSearchParams(window.location.hash.split('?')[1] ?? '')
  const list = (k: string) => (qs.get(k) ?? '').split(',').filter(Boolean)
  return { q: qs.get('q') ?? '', labels: list('l'), quick: list('f').filter((x): x is Filter['quick'][number] => ['small', 'autopilot', 'pr'].includes(x)) }
}

function writeFilter(f: Filter): void {
  const qs = new URLSearchParams()
  if (f.q) qs.set('q', f.q)
  if (f.labels.length) qs.set('l', f.labels.join(','))
  if (f.quick.length) qs.set('f', f.quick.join(','))
  const base = window.location.hash.split('?')[0] || '#/board'
  window.history.replaceState(null, '', `${base}${qs.size ? `?${qs.toString()}` : ''}`)
}

function matches(t: Ticket, f: Filter): boolean {
  if (f.labels.length && !f.labels.some((l) => t.labels.includes(l))) return false
  if (f.quick.includes('small') && !t.small) return false
  if (f.quick.includes('autopilot') && !t.autopilot) return false
  if (f.quick.includes('pr') && !t.prUrl) return false
  if (f.q) {
    const q = f.q.toLowerCase()
    if (!`${t.id} ${t.title} ${t.labels.join(' ')}`.toLowerCase().includes(q)) return false
  }
  return true
}

const QUICK: readonly [Filter['quick'][number], string][] = [
  ['small', 'Quick fixes'],
  ['autopilot', 'Autopilot'],
  ['pr', 'Has PR'],
]

function FilterBar({ tickets, filter, set, shown, onRefresh }: { tickets: readonly Ticket[]; filter: Filter; set: (f: Filter) => void; shown: number; onRefresh?: (() => Promise<void>) | undefined }) {
  const [spinning, setSpinning] = useState(false)
  const counts = new Map<string, number>()
  for (const t of tickets) for (const l of t.labels) counts.set(l, (counts.get(l) ?? 0) + 1)
  const labels = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const toggle = <T,>(list: readonly T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])
  const any = filter.q || filter.labels.length || filter.quick.length
  return (
    <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-line px-4 py-2 text-xs">
      <input
        value={filter.q}
        onChange={(e) => set({ ...filter, q: e.target.value })}
        placeholder="Filter"
        aria-label="filter tickets"
        className="w-36 shrink-0 rounded-md border border-line-2 bg-panel px-2 py-1 text-fg outline-none placeholder:text-dim focus:border-accent"
      />
      {QUICK.map(([key, label]) => (
        <Chip key={key} on={filter.quick.includes(key)} onClick={() => set({ ...filter, quick: toggle(filter.quick, key) })}>
          {label}
        </Chip>
      ))}
      {labels.length > 0 && <span className="h-4 w-px shrink-0 bg-line-2" />}
      {labels.map(([name, n]) => (
        <Chip key={name} on={filter.labels.includes(name)} onClick={() => set({ ...filter, labels: toggle(filter.labels, name) })}>
          <LabelDot name={name} />
          {name}
          <span className="text-dim">{n}</span>
        </Chip>
      ))}
      {any ? (
        <button type="button" onClick={() => set({ q: '', labels: [], quick: [] })} className="ml-auto shrink-0 text-muted hover:text-fg">
          {shown} shown · clear
        </button>
      ) : null}
      {onRefresh && (
        <button
          type="button"
          title="load the board again from the daemon"
          disabled={spinning}
          onClick={async () => {
            setSpinning(true)
            try {
              await onRefresh()
            } catch (err) {
              failed(err)
            } finally {
              setSpinning(false)
            }
          }}
          className={`${any ? '' : 'ml-auto '}flex shrink-0 items-center gap-1.5 rounded-md border border-line-2 px-2 py-1 text-muted hover:text-fg disabled:opacity-60`}
        >
          <motion.span aria-hidden="true" animate={spinning ? { rotate: 360 } : { rotate: 0 }} transition={spinning ? { duration: 0.8, repeat: Infinity, ease: 'linear' } : { duration: 0 }}>
            ↻
          </motion.span>
          Refresh
        </button>
      )}
    </div>
  )
}

function Chip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={`flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 whitespace-nowrap transition-colors ${on ? 'border-accent/60 bg-[#1f1836] text-fg' : 'border-line-2 text-muted hover:text-fg'}`}
    >
      {children}
    </button>
  )
}

export function Board({ tickets: all, live, onRefresh }: { tickets: readonly Ticket[]; live: LiveMap; onRefresh?: () => Promise<void> }) {
  const [filter, setFilter] = useState<Filter>(readFilter)
  const set = (f: Filter) => {
    setFilter(f)
    writeFilter(f)
  }
  const tickets = all.filter((t) => matches(t, filter))
  const columns = COLUMNS.map((col) => ({
    ...col,
    items: tickets.filter((t) => col.statuses.includes(t.status)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  }))
  const scroller = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(0)

  // Phone: open on the column that matters most right now.
  useEffect(() => {
    const el = scroller.current
    if (!el || el.scrollWidth <= el.clientWidth + 4) return
    const first = [2, 1, 0, 3].find((i) => (columns[i]?.items.length ?? 0) > 0) ?? 0
    el.scrollTo({ left: first * el.clientWidth * 0.88, behavior: 'instant' as ScrollBehavior })
    setActive(first)
    // only on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const jump = (i: number) => {
    const el = scroller.current
    const target = el?.children[i] as HTMLElement | undefined
    if (el && target) el.scrollTo({ left: target.offsetLeft - 16, behavior: 'smooth' })
  }
  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const kids = [...el.children] as HTMLElement[]
    const center = el.scrollLeft + el.clientWidth / 2
    const i = kids.findIndex((k) => k.offsetLeft <= center && k.offsetLeft + k.offsetWidth >= center)
    if (i >= 0 && i !== active) setActive(i)
  }

  return (
    <LayoutGroup>
      <div className="flex min-h-0 flex-1 flex-col">
        <FilterBar tickets={all.filter((t) => t.status !== 'done' && t.status !== 'skipped')} filter={filter} set={set} shown={tickets.length} onRefresh={onRefresh} />
        {/* phone: column tabs */}
        <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-line px-3 py-2 md:hidden" aria-label="columns">
          {columns.map((col, i) => (
            <button
              key={col.title}
              type="button"
              onClick={() => jump(i)}
              className={`relative flex min-h-9 shrink-0 items-center gap-1.5 rounded-md px-3 text-xs ${active === i ? 'text-fg' : 'text-muted'}`}
            >
              {active === i && <motion.span layoutId="col-tab" className="absolute inset-0 rounded-md bg-raised" transition={{ type: 'spring', stiffness: 500, damping: 36 }} />}
              <span className={`relative size-2 rounded-full ${col.dot}`} aria-hidden="true" />
              <span className="relative">{col.title}</span>
              <Count value={col.items.length} className="relative text-dim" />
            </button>
          ))}
        </nav>

        <motion.div
          ref={scroller}
          layoutScroll
          onScroll={onScroll}
          className="flex min-h-0 flex-1 snap-x snap-mandatory items-start gap-3 overflow-auto scroll-px-4 p-4 max-md:pb-24 md:grid md:auto-cols-[minmax(250px,1fr)] md:grid-flow-col md:snap-none"
        >
          {columns.map((col) => (
            <section key={col.title} className="flex w-[88vw] max-w-[420px] shrink-0 snap-start flex-col gap-2 md:w-auto md:max-w-none md:min-w-0">
              <h2 className={`mb-1 flex items-center gap-2 text-xs font-medium max-md:hidden ${col.title === 'Needs me' && col.items.length ? 'text-fg' : 'text-muted'}`}>
                <span className="relative flex size-2">
                  {col.title === 'Needs me' && col.items.length > 0 && (
                    <motion.span className={`absolute inset-0 rounded-full ${col.dot}`} animate={{ scale: [1, 2.4], opacity: [0.6, 0] }} transition={{ duration: 1.6, repeat: Infinity }} />
                  )}
                  <span className={`relative size-2 rounded-full ${col.dot}`} aria-hidden="true" />
                </span>
                {col.title}
                <Count value={col.items.length} className="text-dim" />
              </h2>
              {/* no overflow here: a clipping column would hide cards flying between columns */}
              <motion.div layout className="flex min-h-24 flex-col gap-2 pb-2">
                <AnimatePresence mode="popLayout" initial={false}>
                  {col.items.map((t) => (col.title === 'Closed' ? <ClosedRow key={t.id} ticket={t} /> : <TicketCard key={t.id} ticket={t} last={live[t.id]?.at(-1)} />))}
                </AnimatePresence>
                {col.items.length === 0 && (
                  <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs text-dim">
                    {col.title === 'Needs me' ? 'Nothing waiting on you' : 'Empty'}
                    {col.title === 'Assigned' && (
                      <button type="button" onClick={openCycle} className="mt-2 block w-full text-accent-fg hover:underline">
                        Take issues from the cycle
                      </button>
                    )}
                  </motion.div>
                )}
              </motion.div>
            </section>
          ))}
        </motion.div>
      </div>
    </LayoutGroup>
  )
}

function ClosedRow({ ticket }: { ticket: Ticket }) {
  return (
    <motion.a
      layoutId={ticket.id}
      layout
      initial={{ opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={CARD_SPRING}
      href={href.ticket(ticket.id)}
      className="flex items-center justify-between gap-2 rounded-lg border border-[#1f2024] bg-[#131416] px-3 py-2 text-xs text-muted hover:border-line-2 max-md:min-h-11"
    >
      <span className="truncate">
        {ticket.id} · {ticket.title}
      </span>
      <span className={ticket.status === 'done' ? 'text-ok-dot' : 'text-dim'}>
        {ticket.status === 'done' ? (ticket.pr?.state === 'MERGED' ? 'Merged' : /^(qa|done)$/i.test(ticket.linearState) ? ticket.linearState : 'Closed') : 'Skipped'}
      </span>
    </motion.a>
  )
}

function TicketCard({ ticket: t, last }: { ticket: Ticket; last: LiveLine | undefined }) {
  const reduce = useReducedMotion()
  const [busy, setBusy] = useState(false)
  const people = openComments(t)
  const triage = useTriage(t.id)
  const [reply, setReply] = useState('')
  const act = (fn: () => Promise<unknown>) => async (e?: React.MouseEvent | React.FormEvent) => {
    e?.preventDefault()
    e?.stopPropagation()
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      failed(err, t.id)
    } finally {
      setBusy(false)
    }
  }

  const warm = t.status === 'needs_input' || t.status === 'review_ready' || t.status === 'no_change' || t.status === 'stopped'
  const quiet = quietMinutes(t, last)
  const border = t.status === 'failed' ? 'border-[#4a2a2f] bg-[#1b1416]' : warm ? 'border-[#3d3522] bg-[#1a1812]' : t.status === 'running' ? 'border-[#3b2f6b] bg-panel' : 'border-line bg-panel'
  const flash = t.status === 'failed' ? 'rgba(240,140,140,.35)' : warm ? 'rgba(242,201,76,.32)' : t.status === 'pr_draft' ? 'rgba(111,209,157,.3)' : 'rgba(124,134,232,.35)'
  const p = priorityLabel(t.priority)
  const priority = p && !t.labels.includes(p) ? p : null
  const manual = summarySection(t.summary, /needs manual test/i)

  return (
    <motion.article
      layoutId={t.id}
      layout
      initial={{ opacity: 0, y: 14, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.18 } }}
      transition={CARD_SPRING}
      {...(reduce ? {} : { whileHover: { y: -2 } })}
      className={`group relative flex flex-col gap-2 rounded-lg border p-3 transition-colors duration-500 hover:border-line-2 max-md:p-3.5 ${border}`}
    >
      {/* a glow that fires every time the status changes */}
      <motion.span
        key={t.status}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-lg"
        initial={{ boxShadow: `0 0 0 1px ${flash}, 0 0 28px 0 ${flash}` }}
        animate={{ boxShadow: '0 0 0 0px rgba(0,0,0,0), 0 0 0px 0 rgba(0,0,0,0)' }}
        transition={{ duration: 1.6, ease: 'easeOut' }}
      />
      {t.status === 'running' && !reduce && (
        <motion.span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-lg border border-accent-fg/40"
          animate={{ opacity: [0.15, 0.6, 0.15] }}
          transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
        />
      )}
      <a href={href.ticket(t.id)} className="absolute inset-0 rounded-lg" aria-label={`open ${t.id}`} />

      <motion.div layout="position" className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted">{t.id}</span>
          {t.status === 'assigned' && (
            <span className="text-dim">
              {t.createdBy.split('@')[0]}
            </span>
          )}
          {(t.status === 'running' || t.status === 'queued') && (
            <span className="text-accent-fg">
              {t.status === 'queued' ? 'queued' : [t.lane, t.model ? modelName(t.model) : null, t.effort].filter(Boolean).join(' · ')}
            </span>
          )}
          {quiet !== null && quiet >= 3 && (
            <span className={quiet >= STUCK_MINUTES ? 'text-warn' : 'text-dim'} title="minutes since the lane last said anything">
              quiet {quiet}m
            </span>
          )}
          {(warm || t.status === 'failed') && <Pill tone={statusTone(t.status)}>{STATUS_LABEL[t.status]}</Pill>}
          {t.status === 'pr_draft' && t.pr && (
            <span className="text-dim">
              #{t.pr.number} · {prState(t)}
            </span>
          )}
        </div>

        <div className="leading-snug font-medium">{t.title}</div>
        {t.status !== 'assigned' && t.labels.length > 0 && (
          <div className="flex flex-wrap gap-x-2.5 gap-y-1 text-[11px] text-muted">
            {t.labels.slice(0, 4).map((l) => (
              <span key={l} className="flex items-center gap-1">
                <LabelDot name={l} />
                {l}
              </span>
            ))}
          </div>
        )}
        {t.behindMain && t.status !== 'running' && t.status !== 'queued' && (
          <div className="relative z-10 flex items-center gap-1.5">
            <Pill tone={t.behindMain.conflicts ? 'bad' : 'neutral'}>
              ↓ {t.behindMain.commits} behind main{t.behindMain.conflicts ? ' · conflicts' : ''}
            </Pill>
            <button type="button" className="text-[11px] text-muted underline-offset-2 hover:text-fg hover:underline" disabled={busy} onClick={act(() => actions.updateMain(t))}>
              Update
            </button>
          </div>
        )}
        {(() => {
          const vs = visualState(t)
          const sup = t.supervision && (t.status === 'review_ready' || t.status === 'pr_draft') ? t.supervision : null
          const ap = t.autopilot && t.status !== 'done' ? t.autopilot : null
          return vs || sup || ap ? (
            <div className="flex flex-wrap gap-1.5">
              {ap && (
                <span title={ap.held ? `autopilot stopped before the PR: ${ap.held}` : 'started by autopilot'}>
                  <Pill tone={ap.held ? 'warn' : 'neutral'}>{ap.held ? 'autopilot · held' : 'autopilot'}</Pill>
                </span>
              )}
              {vs && <Pill tone={vs.tone}>👁 {vs.label}</Pill>}
              {sup && <Pill tone={sup.verdict === 'pass' ? 'ok' : sup.verdict === 'fail' ? 'bad' : 'warn'}>✓ {sup.engine.split(':')[0]}: {sup.verdict}</Pill>}
            </div>
          ) : null
        })()}

        {t.status === 'assigned' && (
          <>
            {(t.labels.length > 0 || priority || triage) && (
              <div className="flex flex-wrap gap-1.5">
                <TriageChip triage={triage} />
                {t.labels.map((l) => (
                  <Label key={l} name={l} />
                ))}
                {priority && <Pill>{priority}</Pill>}
              </div>
            )}
            <p className="text-xs leading-snug text-muted">
              Suggested <strong className="font-medium text-fg">{t.suggestedLane}</strong> · {t.reason}
            </p>
            <CardEstimate ticket={t} />
            <div className="relative z-10 flex gap-1.5">
              <Button variant={t.suggestedLane === 'lite' ? 'primary' : 'default'} className="flex-1" disabled={busy} onClick={act(() => actions.start(t, 'lite'))}>
                {t.suggestedLane === 'lite' ? 'Start lite' : 'Lite'}
              </Button>
              <Button variant={t.suggestedLane === 'full' ? 'primary' : 'default'} className={t.suggestedLane === 'full' ? 'flex-1' : ''} disabled={busy} onClick={act(() => actions.start(t, 'full'))}>
                {t.suggestedLane === 'full' ? 'Start full' : 'Full'}
              </Button>
              <Button disabled={busy} title="full lane at max effort: slower, deeper" onClick={act(() => actions.start(t, 'max'))}>
                Max
              </Button>
              <Button variant="ghost" disabled={busy} onClick={act(() => actions.skip(t))}>
                Skip
              </Button>
            </div>
          </>
        )}

        {(t.status === 'running' || t.status === 'queued') && (
          <>
            <RunLine ticket={t} />
            <div className="relative h-4 overflow-hidden">
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.div
                  key={last?.at ?? t.status}
                  initial={{ y: 14, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: -14, opacity: 0 }}
                  transition={{ duration: 0.25 }}
                  className="absolute inset-x-0 truncate font-mono text-[11px] text-muted"
                >
                  {last ? `→ ${last.text.split('\n')[0]}` : t.status === 'queued' ? 'waiting for a free slot' : 'starting…'}
                </motion.div>
              </AnimatePresence>
            </div>
            <RunButtons ticket={t} busy={busy} act={act} />
          </>
        )}

        {t.status === 'stopped' && (
          <>
            <p className="text-xs leading-snug text-fg-2">
              {t.stopped?.reason ?? 'Stopped'}
              {t.stopped?.at ? ` · ${timeAgo(t.stopped.at)} ago` : ''}. Where it was is saved in RESUME.md.
            </p>
            <div className="relative z-10 flex gap-1.5">
              <Button variant="primary" className="flex-1" disabled={busy} onClick={act(() => actions.resume(t))}>
                Resume
              </Button>
              <Button variant="ghost" disabled={busy} onClick={act(() => actions.done(t))}>
                Dismiss
              </Button>
            </div>
          </>
        )}

        {t.status === 'review_ready' && (
          <>
            <Mono className="text-muted">
              {plural(t.commits?.split('\n').filter(Boolean).length ?? 0, 'commit')} · {compactStat(t.diffStat)}
            </Mono>

            {manual && <p className="line-clamp-2 text-xs leading-snug text-fg">Manual test: {manual.replace(/\n/g, ' ')}</p>}
            <Button variant="primary" className="relative z-10" disabled={busy || Boolean(t.pushing && !t.pushing.error)} onClick={act(() => actions.push(t))}>
              {t.pushing && !t.pushing.error ? 'Pushing…' : t.pushing?.error ? 'Try the push again' : t.prUrl || t.pr ? 'Push to the PR' : 'Push + draft PR'}
            </Button>
            {pushLine(t) && <p className={`line-clamp-4 text-xs leading-snug ${pushLine(t)?.bad ? 'text-bad' : 'text-muted'}`}>{pushLine(t)?.text}</p>}
          </>
        )}

        {t.status === 'needs_input' && (
          <>
            <p className="line-clamp-4 rounded-md border border-line bg-panel px-2.5 py-2 text-xs leading-snug text-fg-2">{t.question}</p>
            <form className="relative z-10 flex flex-col gap-1" onSubmit={act(() => actions.answer(t, reply))}>
              <label htmlFor={`reply-${t.id}`} className="text-[11px] text-muted">
                Reply
              </label>
              <input
                id={`reply-${t.id}`}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                placeholder="Your answer, then Enter"
                className="rounded-md border border-line-2 bg-bg px-2.5 py-1.5 text-xs text-fg outline-none transition-colors focus:border-accent max-md:min-h-10 max-md:text-[16px]"
              />
            </form>
          </>
        )}

        {t.status === 'no_change' && (
          <>
            <p className="line-clamp-3 text-xs leading-snug text-fg-2">{(t.events.at(-1)?.message ?? '').replace(/[*`]/g, '')}</p>
            <div className="relative z-10 flex gap-1.5">
              <Button variant="primary" className="flex-1" disabled={busy} onClick={act(() => actions.moveInLinear(t, 'done'))}>
                Done in Linear
              </Button>
              <Button disabled={busy} onClick={act(() => actions.start(t, 'full'))}>
                Retry
              </Button>
              <Button variant="ghost" disabled={busy} onClick={act(() => actions.done(t))}>
                Dismiss
              </Button>
            </div>
          </>
        )}

        {t.status === 'failed' && (
          <>
            <p className="text-xs leading-snug text-bad">{t.failure?.title ?? 'Failed'}</p>
            {t.failure?.hint && <p className="text-xs leading-snug text-muted">{t.failure.hint}</p>}
            <div className="relative z-10 flex gap-1.5">
              <Button disabled={busy} onClick={act(() => actions.start(t, t.lane ?? 'lite'))}>
                Retry
              </Button>
              <Button variant="ghost" disabled={busy} onClick={act(() => actions.done(t))}>
                Dismiss
              </Button>
            </div>
          </>
        )}

        {t.status === 'pr_draft' && t.pr && (
          <>
            <div className="flex flex-wrap gap-1.5">
              <Pill tone={t.pr.ci === 'success' ? 'ok' : t.pr.ci === 'failure' ? 'bad' : t.pr.ci === 'pending' ? 'warn' : 'neutral'}>
                CI {t.pr.ci === 'success' ? 'passing' : t.pr.ci === 'failure' ? 'failing' : t.pr.ci}
              </Pill>
              <Pill tone={t.pr.reviewDecision === 'APPROVED' ? 'ok' : t.pr.reviewDecision === 'CHANGES_REQUESTED' ? 'bad' : 'neutral'}>
                {t.pr.reviewDecision === 'none' ? 'Review pending' : t.pr.reviewDecision.toLowerCase().replace('_', ' ')}
              </Pill>
              {t.pr.greptile && (
                <Pill tone={t.pr.greptile.findings.length === 0 ? 'ok' : 'warn'}>
                  Greptile {t.pr.greptile.score ?? '?'}/5{t.pr.greptile.findings.length ? ` · ${t.pr.greptile.findings.length}` : ''}
                </Pill>
              )}
              {people.length > 0 && <Pill tone="warn">{plural(people.length, 'comment')}</Pill>}
            </div>
            {people.at(-1) && (
              <p className="line-clamp-2 text-xs leading-snug text-fg-2">
                <strong className="font-medium">{people.at(-1)?.author}</strong>{' '}
                {people.at(-1)?.path && (
                  <Mono className="text-muted">
                    {people.at(-1)?.path}:{people.at(-1)?.line}{' '}
                  </Mono>
                )}
                {people.at(-1)?.body}
              </p>
            )}
            <div className="relative z-10 flex gap-1.5">
              {(t.pr.greptile?.findings.length ?? 0) > 0 ? (
                <Button className="flex-1" disabled={busy} onClick={act(() => actions.fixGreptile(t))}>
                  Fix Greptile findings
                </Button>
              ) : canMarkReady(t) && greptileClear(t) ? (
                <Button variant="primary" className="flex-1" disabled={busy} onClick={act(() => actions.ready(t))}>
                  Ready for review
                </Button>
              ) : people.length > 0 ? (
                <a href={href.ticket(t.id)} className="flex flex-1 items-center justify-center rounded-md border border-line-2 bg-raised px-3 py-1.5 text-xs font-medium text-fg hover:border-accent/50">
                  Pick what to address
                </a>
              ) : null}
              <Button variant={people.length > 0 || t.pr.greptile ? 'ghost' : 'default'} className={people.length > 0 || t.pr.greptile ? '' : 'flex-1'} disabled={busy} onClick={act(() => actions.moveInLinear(t, 'qa'))}>
                Move to QA
              </Button>
            </div>
          </>
        )}
        <LastChange ticket={t} />
      </motion.div>
    </motion.article>
  )
}

function CardEstimate({ ticket: t }: { ticket: Ticket }) {
  const line = estLine(useEstimates(t)[t.suggestedLane])
  if (!line) return null
  return (
    <span className="self-start rounded-full border border-line-2 px-2 py-px text-[11px] text-fg-2" title={`${t.suggestedLane} lane, from your past runs on similar tickets`}>
      ⏱ {line}
    </span>
  )
}

// The step it is on, time against the estimate and the spend so far; amber once over.
function RunLine({ ticket: t }: { ticket: Ticket }) {
  const { est, elapsed, spend, over } = useRunClock(t)
  const step = t.stage ? STEPS[currentStep(t)] : null
  const pct = elapsed !== null && est ? Math.min(1, elapsed / est.minutes[1]) : stageProgress(t)
  return (
    <>
      {t.status === 'running' && (
        <div className="flex items-baseline justify-between gap-2 text-[11px] text-muted">
          <span className="min-w-0 truncate">
            {step && <strong className="font-medium text-fg">{step}</strong>}
            {t.stage ? ` · ${t.stage.name}` : ''}
          </span>
          <span className="shrink-0">
            <strong className={`font-medium ${over ? 'text-warn' : 'text-fg'}`}>{elapsed !== null ? fmtMinutes(elapsed) : ''}</strong>
            {est ? ` / ~${fmtMinutes(est.minutes[1])}` : ''}
            {spend ? (
              <>
                {' · '}
                <strong className="font-medium text-fg">
                  {spend.approx ? '≈ ' : ''}
                  {usd(spend.usd)}
                </strong>
              </>
            ) : null}
          </span>
        </div>
      )}
      <Progress value={pct} active={t.status === 'running'} warn={over} />
    </>
  )
}

function RunButtons({ ticket: t, busy, act }: { ticket: Ticket; busy: boolean; act: (fn: () => Promise<unknown>) => (e?: React.MouseEvent) => Promise<void> }) {
  const { over } = useRunClock(t)
  return (
    <div className="relative z-10 flex justify-end gap-1.5">
      {t.status === 'running' && (over || t.pauseAfter) && (
        <Button disabled={busy} onClick={act(() => actions.pauseAfter(t, !t.pauseAfter))}>
          {t.pauseAfter ? 'Pausing · undo' : 'Pause after this step'}
        </Button>
      )}
      <ConfirmButton label="Stop" confirm={`Stop ${t.id}`} disabled={busy} onConfirm={() => void act(() => actions.stop(t))()} />
    </div>
  )
}

// When the ticket last changed and what it was, at the foot of every open card.
function LastChange({ ticket: t }: { ticket: Ticket }) {
  useNow(30_000)
  const c = lastChange(t)
  return (
    <div className="flex items-baseline gap-1.5 text-[11px] text-dim" title={`${c.what} · ${new Date(c.at).toLocaleString()}`}>
      <span className="min-w-0 flex-1 truncate">{c.what}</span>
      <span className="shrink-0">{timeAgo(c.at)} ago</span>
    </div>
  )
}
