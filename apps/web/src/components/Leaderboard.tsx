import type { Leaderboard as Board, Health, LeaderRow, PrReview, Ticket } from '@ticketflow/shared'
import { animate, AnimatePresence, motion, useMotionValue, useReducedMotion, useTransform } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { loadLeaderboard } from '../lib/api.js'
import { href } from '../lib/route.js'
import { openCycle } from './Cycle.js'
import { Avatar, rise, timeAgo } from './ui.js'

type Period = 'week' | 'month'
const MEDAL = ['#e2b43c', '#b4bcc7', '#c4824e'] as const
const SHOWN = 5
const SPRING = { type: 'spring', stiffness: 420, damping: 34 } as const

function readPeriod(): Period {
  try {
    return localStorage.getItem('metwo.home.leaders') === 'month' ? 'month' : 'week'
  } catch {
    return 'week'
  }
}

// A little friendly competition: who closed the most tickets, merged the most PRs and reviewed the
// most PRs this week or month. Tickets come from Linear, PRs and reviews from GitHub. Rows keep
// their identity across refreshes and periods, so people slide to their new place and counts roll.
export function Leaderboard({ tickets = [], reviews = [], health = null }: { tickets?: readonly Ticket[]; reviews?: readonly PrReview[]; health?: Health | null }) {
  const [period, setPeriodState] = useState<Period>(readPeriod)
  const [board, setBoard] = useState<Board | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const setPeriod = (p: Period) => {
    setPeriodState(p)
    try {
      localStorage.setItem('metwo.home.leaders', p)
    } catch {}
  }
  const load = async (fresh = false) => {
    setLoading(true)
    try {
      setBoard(await loadLeaderboard(period, fresh))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load()
  }, [period])

  const cols = board
    ? ([
        { title: 'Tickets done', lead: 'tickets done', unit: 'ticket', rows: board.tickets },
        { title: 'PRs merged', lead: 'PRs merged', unit: 'PR', rows: board.prs, extra: (r: LeaderRow) => (r.extra ? `${r.extra >= 1000 ? `${(r.extra / 1000).toFixed(1)}k` : r.extra} lines` : '') },
        { title: 'Reviews given', lead: 'reviews given', unit: 'review', rows: board.reviews },
      ] as const)
    : []

  return (
    <motion.section variants={rise} className="col-span-4 flex flex-col gap-3 overflow-hidden rounded-xl border border-line bg-panel p-4 max-xl:col-span-2 max-sm:col-span-1">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-xs font-medium text-muted">Leaderboard</h2>
          <p className="text-[11px] text-dim">
            {period === 'week' ? 'Since Monday' : 'Since the 1st'} · tickets from Linear, PRs and reviews from GitHub{board ? ` · updated ${timeAgo(board.at)} ago` : ''}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" className="text-xs text-muted hover:text-fg disabled:opacity-50" disabled={loading} onClick={() => void load(true)}>
            <motion.span className="inline-block" animate={loading ? { rotate: 360 } : { rotate: 0 }} transition={loading ? { duration: 0.8, repeat: Infinity, ease: 'linear' } : { duration: 0 }}>
              ↻
            </motion.span>{' '}
            Refresh
          </button>
          <div className="flex overflow-hidden rounded-md border border-line-2 text-xs" role="radiogroup" aria-label="leaderboard period">
            {(['week', 'month'] as const).map((p) => (
              <button key={p} type="button" role="radio" aria-checked={period === p} onClick={() => setPeriod(p)} className={`relative px-3 py-1 max-md:min-h-9 ${period === p ? 'text-fg' : 'text-muted hover:text-fg'}`}>
                {period === p && <motion.span layoutId="leader-pill" className="absolute inset-0 bg-raised" transition={{ type: 'spring', stiffness: 500, damping: 36 }} />}
                <span className="relative">This {p}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
      {error && <p className="text-xs text-bad">{error}</p>}
      {board?.errors.map((e) => (
        <p key={e} className="text-[11px] text-warn">
          {e}
        </p>
      ))}
      {!board && !error && <SkeletonBoard />}
      {board && <Plan board={board} period={period} tickets={tickets} reviews={reviews} health={health} />}
      {board && (
        <div className="grid grid-cols-3 gap-5 max-lg:grid-cols-1">
          {cols.map((c, i) => (
            <Column key={c.title} index={i} period={period} title={c.title} lead={c.lead} unit={c.unit} rows={c.rows} {...('extra' in c ? { extra: c.extra } : {})} {...(i === 0 ? { inFlight: board.progress } : {})} />
          ))}
        </div>
      )}
    </motion.section>
  )
}

function SkeletonBoard() {
  return (
    <div className="grid grid-cols-3 gap-5 max-lg:grid-cols-1">
      {[0, 1, 2].map((c) => (
        <div key={c} className="flex flex-col gap-1.5">
          {[0, 1, 2, 3].map((r) => (
            <motion.div key={r} className="h-8 rounded-md bg-sunk" animate={{ opacity: [0.35, 0.75, 0.35] }} transition={{ duration: 1.4, repeat: Infinity, delay: (c * 4 + r) * 0.06 }} />
          ))}
        </div>
      ))}
    </div>
  )
}

const keyOf = (r: LeaderRow) => r.login ?? r.name

function Column({ index, period, title, lead, unit, rows, extra, inFlight }: { index: number; period: Period; title: string; lead: string; unit: string; rows: readonly LeaderRow[]; extra?: (r: LeaderRow) => string; inFlight?: readonly LeaderRow[] }) {
  const flight = new Map((inFlight ?? []).map((r) => [r.name, r.count]))
  const top = rows.slice(0, SHOWN)
  const mine = rows.findIndex((r) => r.you)
  const max = Math.max(1, rows[0]?.count ?? 1)
  const ahead = mine > 0 ? rows[mine - 1] : null
  const total = rows.reduce((n, r) => n + r.count, 0)
  // places gained since the last load of the same period, for the little ▲
  const prev = useRef<{ period: Period; ranks: Map<string, number> } | null>(null)
  const moved = useMemo(() => {
    const before = prev.current?.period === period ? prev.current.ranks : null
    const out = new Map<string, number>()
    if (before) rows.forEach((r, i) => {
      const was = before.get(keyOf(r))
      if (was !== undefined && was > i) out.set(keyOf(r), was - i)
    })
    return out
  }, [rows, period])
  useEffect(() => {
    prev.current = { period, ranks: new Map(rows.map((r, i) => [keyOf(r), i])) }
  }, [rows, period])

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.08, ...SPRING }} className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[13px] font-medium text-fg">{title}</h3>
        <span className="text-[11px] text-dim">
          <Count value={total} /> total
        </span>
      </div>
      {rows.length === 0 && <p className="py-4 text-center text-xs text-dim">Nobody yet. First one wins.</p>}
      <motion.ol layout className="flex flex-col gap-0.5">
        <AnimatePresence initial={true} mode="popLayout">
          {top.map((r, i) => (
            <Line key={keyOf(r)} row={r} rank={i + 1} max={max} unit={unit} extra={extra?.(r) ?? (flight.get(r.name) ? `${flight.get(r.name)} in flight` : '')} delay={index * 0.08 + i * 0.05} gained={moved.get(keyOf(r)) ?? 0} />
          ))}
          {mine >= SHOWN && (
            <motion.li key="gap" layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="px-2 text-[11px] leading-3 text-dim">
              ⋯
            </motion.li>
          )}
          {mine >= SHOWN && <Line key={keyOf(rows[mine] as LeaderRow)} row={rows[mine] as LeaderRow} rank={mine + 1} max={max} unit={unit} extra={extra?.(rows[mine] as LeaderRow) ?? (flight.get((rows[mine] as LeaderRow).name) ? `${flight.get((rows[mine] as LeaderRow).name)} in flight` : '')} delay={index * 0.08 + SHOWN * 0.05} gained={moved.get(keyOf(rows[mine] as LeaderRow)) ?? 0} />}
        </AnimatePresence>
      </motion.ol>
      <AnimatePresence mode="wait" initial={false}>
        <motion.p key={`${period}-${mine}-${ahead?.name ?? ''}`} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.2 }} className="text-[11px] text-muted">
          {mine === 0 ? `You lead in ${lead}.` : mine > 0 && ahead ? `You are #${mine + 1}, ${ahead.count - (rows[mine]?.count ?? 0) + 1} more to pass ${ahead.name}.` : rows.length ? 'None of yours yet this period.' : ''}
        </motion.p>
      </AnimatePresence>
    </motion.div>
  )
}

function Line({ row: r, rank, max, unit, extra, delay, gained }: { row: LeaderRow; rank: number; max: number; unit: string; extra: string; delay: number; gained: number }) {
  const reduce = useReducedMotion()
  const medal = rank <= 3 ? MEDAL[rank - 1] : null
  const first = rank === 1
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
      transition={{ ...SPRING, delay, layout: SPRING }}
      whileHover={reduce ? {} : { x: 2 }}
      className={`group relative flex items-center gap-2.5 overflow-hidden rounded-md px-2 py-1.5 text-xs ${r.you ? 'ring-1 ring-accent/45' : ''}`}
    >
      {/* the bar: grows to its share of the leader, the leader's one shimmers */}
      <motion.span aria-hidden="true" className={`absolute inset-y-1 left-0 overflow-hidden rounded-r-md ${r.you ? 'bg-accent/15' : 'bg-raised'}`} initial={{ width: 0 }} animate={{ width: `${(r.count / max) * 100}%` }} transition={{ type: 'spring', stiffness: 70, damping: 18, delay: delay + 0.1 }}>
        {first && !reduce && (
          <motion.span className="absolute inset-y-0 w-1/3" style={{ background: 'linear-gradient(90deg, transparent, rgba(226,180,60,.16), transparent)' }} initial={{ x: '-120%' }} animate={{ x: '360%' }} transition={{ duration: 1.6, repeat: Infinity, repeatDelay: 2.4, ease: 'easeInOut', delay: delay + 0.8 }} />
        )}
      </motion.span>
      {r.you && !reduce && (
        <motion.span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-md" initial={{ boxShadow: '0 0 0 0 rgba(124,92,255,.55)' }} animate={{ boxShadow: ['0 0 0 0 rgba(124,92,255,.55)', '0 0 0 6px rgba(124,92,255,0)'] }} transition={{ duration: 1.4, delay: delay + 0.4, repeat: 1 }} />
      )}

      <span className="relative w-4 shrink-0 text-center font-semibold tabular-nums" style={medal ? { color: medal } : undefined}>
        {rank}
      </span>

      <span className="relative flex shrink-0 items-center justify-center">
        {first && (
          <>
            <span aria-hidden="true" className={`crown-ring absolute -inset-[3px] rounded-full ${reduce ? '' : 'crown-spin'}`} />
            <motion.svg aria-hidden="true" viewBox="0 0 16 10" className="absolute -top-[9px] h-[7px] w-[11px]" initial={{ y: -6, opacity: 0, rotate: -20 }} animate={reduce ? { y: 0, opacity: 1, rotate: 0 } : { y: [0, -1.5, 0], opacity: 1, rotate: 0 }} transition={reduce ? { delay } : { y: { duration: 2.2, repeat: Infinity, ease: 'easeInOut', delay: delay + 0.6 }, opacity: { delay: delay + 0.3 }, rotate: { ...SPRING, delay: delay + 0.3 } }}>
              <path d="M1 9 L2 2 L5.5 5.5 L8 0.8 L10.5 5.5 L14 2 L15 9 Z" fill={MEDAL[0]} />
            </motion.svg>
          </>
        )}
        <span className="relative rounded-full transition-transform duration-200 group-hover:scale-110" style={medal && !first ? { boxShadow: `0 0 0 1.5px ${medal}` } : undefined}>
          <Avatar login={r.login ?? null} src={r.avatar ?? null} name={r.name} size={20} />
        </span>
        {r.you && first && <Confetti />}
      </span>

      <span className="relative min-w-0 flex-1 truncate text-fg-2">
        {r.name}
        {r.you && <span className="ml-1.5 text-[10px] text-accent-fg">you</span>}
        <AnimatePresence>
          {gained > 0 && (
            <motion.span key={gained} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="ml-1.5 text-[10px] text-ok" title={`up ${gained} since the last refresh`}>
              ▲{gained}
            </motion.span>
          )}
        </AnimatePresence>
      </span>
      {extra && <span className="relative shrink-0 text-[11px] text-dim">{extra}</span>}
      <span className="relative shrink-0 font-semibold text-fg tabular-nums" title={`${r.count} ${unit}${r.count === 1 ? '' : 's'}`}>
        <Count value={r.count} delay={delay} />
      </span>
    </motion.li>
  )
}

// Rolls from where it was to the new value.
function Count({ value, delay = 0 }: { value: number; delay?: number }) {
  const reduce = useReducedMotion()
  const mv = useMotionValue(reduce ? value : 0)
  const text = useTransform(mv, (v) => String(Math.round(v)))
  useEffect(() => {
    if (reduce) {
      mv.set(value)
      return
    }
    const a = animate(mv, value, { duration: 0.9, delay, ease: [0.22, 1, 0.36, 1] })
    return () => a.stop()
  }, [value, reduce])
  return <motion.span>{text}</motion.span>
}

// When you lead a board: a short burst from your avatar, once per session.
function Confetti() {
  const reduce = useReducedMotion()
  const [show] = useState(() => {
    try {
      if (sessionStorage.getItem('metwo.confetti')) return false
      sessionStorage.setItem('metwo.confetti', '1')
    } catch {}
    return true
  })
  const bits = useMemo(
    () =>
      Array.from({ length: 16 }, (_, i) => {
        const angle = (i / 16) * Math.PI * 2 + (i % 3) * 0.2
        const dist = 26 + (i % 4) * 9
        return { x: Math.cos(angle) * dist, y: Math.sin(angle) * dist - 8, color: ['#e2b43c', '#7c5cff', '#6fd19d', '#f08c8c', '#a08bff'][i % 5], rotate: (i % 2 ? 1 : -1) * (90 + i * 20), w: i % 3 ? 4 : 6 }
      }),
    [],
  )
  if (!show || reduce) return null
  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-0 z-10">
      {bits.map((b, i) => (
        <motion.span
          key={i}
          className="absolute top-1/2 left-1/2 rounded-[1px]"
          style={{ width: b.w, height: 3, background: b.color }}
          initial={{ x: 0, y: 0, opacity: 1, rotate: 0, scale: 0.6 }}
          animate={{ x: b.x, y: [0, b.y, b.y + 18], opacity: [1, 1, 0], rotate: b.rotate, scale: 1 }}
          transition={{ duration: 1.3, delay: 0.9, ease: 'easeOut', times: [0, 0.55, 1] }}
        />
      ))}
    </span>
  )
}

// Mon–Fri left in the period, today included until 6 pm.
function workdaysLeft(period: Period): number {
  const d = new Date()
  if (d.getHours() >= 18) d.setDate(d.getDate() + 1)
  d.setHours(12, 0, 0, 0)
  const end = new Date()
  if (period === 'week') end.setDate(end.getDate() + ((5 - end.getDay() + 7) % 7))
  else end.setMonth(end.getMonth() + 1, 0)
  end.setHours(23, 0, 0, 0)
  let n = 0
  for (const x = new Date(d); x <= end; x.setDate(x.getDate() + 1)) if (x.getDay() !== 0 && x.getDay() !== 6) n++
  return n
}

interface Goal {
  readonly key: string
  readonly title: string
  readonly line: string
  readonly hint: string
  readonly tone: 'ok' | 'warn' | 'accent'
  readonly action?: { readonly label: string; readonly go: () => void }
}

// What it takes to be #1 in each board before the period ends, from where you are and what is already
// moving: tickets in flight, your PRs in review, reviews waiting on you. Plain math, no AI.
function Plan({ board, period, tickets, reviews, health }: { board: Board; period: Period; tickets: readonly Ticket[]; reviews: readonly PrReview[]; health: Health | null }) {
  const days = workdaysLeft(period)
  const when = period === 'week' ? 'this week' : 'this month'
  const per = (n: number) => (days > 0 ? Math.ceil(n / days) : n)
  const standing = (rows: readonly LeaderRow[]) => {
    const i = rows.findIndex((r) => r.you)
    const mine = i >= 0 ? (rows[i]?.count ?? 0) : 0
    const top = rows[0]
    const leading = i === 0 && rows.length > 0
    const target = leading ? (rows[1]?.count ?? 0) : (top?.count ?? 0)
    return { rank: i >= 0 ? i + 1 : null, mine, leading, need: leading ? 0 : Math.max(1, target - mine + 1), margin: leading ? mine - target : 0, top: top?.name ?? '' }
  }
  const myFlight = board.progress.find((r) => r.you)?.count ?? 0
  const inReview = tickets.filter((t) => t.status === 'pr_draft' && t.pr?.state === 'OPEN' && t.pr.isDraft === false).length
  const drafts = tickets.filter((t) => t.status === 'pr_draft' && t.pr?.state === 'OPEN' && t.pr.isDraft).length
  const waiting = tickets.filter((t) => ['review_ready', 'needs_input', 'stopped', 'failed'].includes(t.status)).length
  const assigned = tickets.filter((t) => t.status === 'assigned').length
  const running = tickets.filter((t) => t.status === 'running' || t.status === 'queued').length
  const toReview = reviews.filter((r) => ['new', 'reviewed'].includes(r.status)).length
  const engines = (health?.lanes.engines ?? []).filter((e) => e.installed).map((e) => e.label)
  const lanes = health?.lanes.max ?? 2

  const t = standing(board.tickets)
  const p = standing(board.prs)
  const r = standing(board.reviews)
  const goals: Goal[] = [
    {
      key: 'tickets',
      title: 'Tickets done',
      tone: t.leading ? 'ok' : 'warn',
      line: t.leading ? `You lead by ${t.margin}. Keep ${per(1)} a day to hold it.` : `${t.need} more done ${when} to pass ${t.top}: ~${per(t.need)} a day over ${days} workday${days === 1 ? '' : 's'}.`,
      hint: `${myFlight} of yours are in progress in Linear (review and QA count as in progress). They only score when they reach Done, so closing those is the cheapest win${myFlight >= t.need && !t.leading ? `: that alone gets you there` : ''}.`,
      action: { label: 'See your board', go: () => (window.location.hash = href.board) },
    },
    {
      key: 'prs',
      title: 'PRs merged',
      tone: p.leading ? 'ok' : 'warn',
      line: p.leading ? `You lead by ${p.margin}.` : `${p.need} more merged ${when} to pass ${p.top}: ~${per(p.need)} a day.`,
      hint: `${inReview} PR${inReview === 1 ? '' : 's'} of yours in review${drafts ? `, ${drafts} still draft (mark them ready)` : ''}${waiting ? `, ${waiting} ticket${waiting === 1 ? '' : 's'} waiting on you to push or answer` : ''}. Ask for reviews early; merges are what count.`,
    },
    {
      key: 'reviews',
      title: 'Reviews given',
      tone: r.leading ? 'ok' : 'accent',
      line: r.leading ? `You lead by ${r.margin}.` : `${r.need} more reviews ${when} to pass ${r.top}: ~${per(r.need)} a day.`,
      hint: `${toReview} on your review list. Reviews count once the PR merges, so start with PRs that already have an approval. A code review is cheap; save full reviews for UI changes.`,
      action: { label: 'Pick PRs to review', go: () => (window.location.hash = href.reviews) },
    },
    {
      key: 'take',
      title: 'Taking tickets',
      tone: 'accent',
      line: `${running} running, ${assigned} assigned waiting to start, ${lanes} lane${lanes === 1 ? '' : 's'} at once.`,
      hint: [
        assigned ? `Start the ${assigned} assigned now so they run while you review` : 'Take the easy ones from the cycle so lanes are never idle',
        running < lanes ? `${lanes - running} lane${lanes - running === 1 ? '' : 's'} free` : 'all lanes busy: raise "Lanes at once" in Settings if the Mac keeps up',
        engines.length > 1 ? `spread them across ${engines.join(', ')} (pick the engine on each ticket) to run more in parallel within the budget` : 'install Codex or Cursor in Settings → Engines to run more in parallel',
        health?.lanes.autopilot?.enabled ? '' : 'turn on autopilot so small tickets start by themselves',
      ]
        .filter(Boolean)
        .join('; ')
        .concat('.'),
      action: { label: 'Take tickets', go: openCycle },
    },
  ]
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="grid grid-cols-4 gap-2 max-xl:grid-cols-2 max-sm:grid-cols-1">
      {goals.map((g, i) => (
        <motion.div key={g.key} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 * i, ...SPRING }} className={`flex flex-col gap-1 rounded-lg border px-3 py-2.5 text-xs ${g.tone === 'ok' ? 'border-ok/25 bg-ok/5' : g.tone === 'warn' ? 'border-warn/25 bg-warn/5' : 'border-accent/25 bg-accent/5'}`}>
          <span className="text-[11px] font-medium text-muted">{g.title}</span>
          <span className="leading-snug font-medium text-fg">{g.line}</span>
          <span className="leading-snug text-muted">{g.hint}</span>
          {g.action && (
            <button type="button" className="mt-auto self-start pt-1 text-accent-fg hover:underline" onClick={g.action.go}>
              {g.action.label} →
            </button>
          )}
        </motion.div>
      ))}
    </motion.div>
  )
}
