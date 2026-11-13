import { compressTime, type Ticket, TIMELINE_ROWS, type TimelineMark, type TimelineRow, type TimelineSegment, ticketTimeline, usd } from '@ticketflow/shared'
import { useEffect, useMemo, useState } from 'react'
import { href } from '../lib/route.js'
import { COLUMNS } from './status.js'

// Who was working on a ticket and when: the lane, the review pass, the gates and supervisor, GitHub,
// and you. On the board one row per ticket; in a ticket one row per actor.

const COLOR: Record<TimelineRow, string> = {
  lane: '#7c5cff',
  review: '#4f8ff7',
  checks: '#3fb6c9',
  github: '#c4924a',
  you: '#f2c94c',
}
const LEGEND: Record<TimelineRow, string> = { lane: 'Lane', review: 'Review pass', checks: 'Gates + supervisor', github: 'GitHub', you: 'Waiting on you' }
const MARK: Record<TimelineMark['tone'], string> = { ok: 'bg-ok', warn: 'bg-warn', bad: 'bg-bad', neutral: 'bg-fg-2' }

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
const day = (t: number) => new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' })
const when = (t: number) => (new Date(t).toDateString() === new Date().toDateString() ? clock(t) : `${day(t)} ${clock(t)}`)
const dur = (ms: number) => {
  const m = Math.round(ms / 60_000)
  if (m < 1) return '<1m'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h${m % 60 ? ` ${m % 60}m` : ''}` : `${Math.round(h / 24)}d`
}

function useNow(ms = 30_000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(i)
  }, [ms])
  return now
}

function Block({ seg, left, width, picked, onPick, label, band = false }: { seg: TimelineSegment; left: number; width: number; picked: boolean; onPick: () => void; label: string; band?: boolean }) {
  const wait = seg.row === 'you'
  return (
    <button
      type="button"
      aria-pressed={picked}
      aria-label={`${label}: ${seg.label}, ${dur(seg.end - seg.start)}`}
      title={`${seg.label} · ${dur(seg.end - seg.start)}${seg.cost ? ` · ${usd(seg.cost)}` : ''}`}
      onClick={onPick}
      className={`absolute ${band ? 'bottom-0.5 h-1.5' : 'top-1.5 bottom-1.5'} overflow-hidden rounded-[4px] px-1.5 text-left font-mono text-[10.5px] font-medium whitespace-nowrap shadow-[inset_0_0_0_1px_#ffffff1f] ${wait ? 'text-[#2b2612]' : 'text-white'} ${picked ? 'outline-2 outline-offset-1 outline-fg' : ''} ${seg.failed ? 'opacity-80' : ''}`}
      style={{
        left: `${left * 100}%`,
        width: `max(3px, ${width * 100}%)`,
        background: wait ? `repeating-linear-gradient(135deg, ${COLOR.you} 0 6px, #f2c94ccc 6px 12px)` : seg.row === 'github' ? `${COLOR.github}55` : COLOR[seg.row],
        boxShadow: seg.row === 'github' ? `inset 0 0 0 1px ${COLOR.github}` : undefined,
      }}
    >
      {!band && <span className={`block truncate ${seg.row === 'github' ? 'text-fg-2' : ''}`}>{width > 0.07 ? seg.label : ''}</span>}
      {seg.live && <span className="absolute inset-y-0 right-0 w-[3px] animate-pulse bg-white" aria-hidden="true" />}
    </button>
  )
}

function Legend({ rows }: { rows: readonly TimelineRow[] }) {
  return (
    <div className="flex flex-wrap gap-3 text-[11px] text-muted">
      {rows.map((r) => (
        <span key={r} className="inline-flex items-center gap-1.5">
          <i className="inline-block size-2.5 rounded-[3px]" style={{ background: r === 'you' ? `repeating-linear-gradient(135deg, ${COLOR.you} 0 3px, transparent 3px 6px)` : r === 'github' ? `${COLOR.github}55` : COLOR[r], boxShadow: r === 'you' || r === 'github' ? `inset 0 0 0 1px ${COLOR[r]}` : undefined }} />
          {LEGEND[r]}
        </span>
      ))}
    </div>
  )
}

function Inspector({ seg, ticket, link }: { seg: TimelineSegment | null; ticket?: Ticket | undefined; link?: boolean }) {
  if (!seg) return <div className="rounded-lg border border-line bg-panel px-3.5 py-3 text-xs text-dim">Pick a block to see what happened, how long it took and what it cost.</div>
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-1.5 rounded-lg border border-line bg-panel px-3.5 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
          {ticket && <span className="text-muted">{ticket.id}</span>}
          <span>{seg.label}</span>
          {seg.live && <span className={`rounded-full border px-1.5 text-[10.5px] ${seg.wait ? 'border-[#4a4020] bg-[#2b2612] text-warn' : 'border-[#3b2f6b] bg-[#1f1836] text-accent-fg'}`}>{seg.wait ? 'waiting now' : 'running'}</span>}
          {seg.failed && <span className="rounded-full border border-[#4a2a2f] bg-[#2a1a1d] px-1.5 text-[10.5px] text-bad">{seg.row === 'checks' ? 'concerns' : 'failed'}</span>}
        </div>
        {seg.detail && seg.detail !== seg.label && <p className="text-xs text-fg-2">{seg.detail}</p>}
        <div className="flex flex-wrap gap-3 font-mono text-[11px] text-muted">
          <span>
            {when(seg.start)} → {seg.live ? 'now' : when(seg.end)}
          </span>
          <span>{dur(seg.end - seg.start)}</span>
          {seg.cost ? <span>{usd(seg.cost)}</span> : null}
          {seg.engine && <span>{seg.engine}</span>}
        </div>
      </div>
      {link && ticket && (
        <a href={href.ticket(ticket.id)} className="shrink-0 rounded-md border border-line-2 bg-raised px-2.5 py-1 text-xs hover:text-fg">
          Open ticket
        </a>
      )}
    </div>
  )
}

// One ticket, one row per actor. Quiet stretches (nights, weekends) are squeezed.
export function TicketTimeline({ ticket: t }: { ticket: Ticket }) {
  const now = useNow()
  const tl = useMemo(() => ticketTimeline(t, now), [t, now])
  const [picked, setPicked] = useState<number | null>(null)
  const rows = TIMELINE_ROWS.filter((r) => r.row === 'lane' || tl.segments.some((s) => s.row === r.row))
  if (tl.start === null) return <p className="py-8 text-center text-xs text-dim">Nothing has run on this ticket yet.</p>
  const from = tl.start
  const scale = compressTime(
    // waits and the open PR span nights too; only work keeps real width
    tl.segments.filter((s) => s.row !== 'github' && s.row !== 'you').map((s) => [s.start, s.end] as const),
    from,
    tl.end,
  )
  const sum = (row: TimelineRow) => tl.segments.filter((s) => s.row === row).reduce((a, s) => a + (s.end - s.start), 0)
  const cost = tl.segments.reduce((a, s) => a + (s.cost ?? 0), 0)
  const rounds = tl.segments.filter((s) => s.row === 'checks').length
  const sel = picked !== null ? (tl.segments[picked] ?? null) : (tl.segments.find((s) => s.live && s.row !== 'github') ?? null)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
        <span>
          <b className="font-medium text-fg">{dur(tl.end - from)}</b> since start
        </span>
        <span>
          <b className="font-medium text-fg">{dur(sum('lane'))}</b> lane working
        </span>
        <span>
          <b className="font-medium text-warn">{dur(sum('you'))}</b> waiting on you
        </span>
        {rounds > 0 && (
          <span>
            <b className="font-medium text-fg">{rounds}</b> supervisor round{rounds === 1 ? '' : 's'}
          </span>
        )}
        {cost > 0 && (
          <span>
            <b className="font-medium text-fg">{usd(cost)}</b> in turns
          </span>
        )}
      </div>
      <div className="overflow-x-auto">
        <div className="grid min-w-[560px] grid-cols-[136px_1fr] pr-2">
          <div />
          <div className="relative h-5 font-mono text-[10px] text-dim tabular-nums">
            <span className="absolute left-0">{when(from)}</span>
            {scale.gaps
              .filter((g) => g.x > 0.14 && g.x < 0.88)
              .map((g) => (
                <span key={g.from} className="absolute -translate-x-1/2 whitespace-nowrap text-muted" style={{ left: `${(g.x + 0.02) * 100}%` }} title={`${when(g.from)} → ${when(g.to)}`}>
                  ⋯ {dur(g.to - g.from)}
                </span>
              ))}
            <span className="absolute right-0">now</span>
          </div>
          {rows.map((r) => (
            <div key={r.row} className="contents">
              <div className="flex items-center gap-1.5 border-t border-line pr-2 text-[11.5px] whitespace-nowrap text-fg-2">
                <i className="inline-block size-2 shrink-0 rounded-full" style={{ background: COLOR[r.row] }} />
                {r.label}
              </div>
              <div className="relative h-9 border-t border-line">
                {scale.gaps.map((g) => (
                  <div key={g.from} className="absolute inset-y-0 w-[4%] bg-[repeating-linear-gradient(90deg,transparent_0_3px,#26272b_3px_4px)] opacity-60" style={{ left: `${g.x * 100}%` }} aria-hidden="true" />
                ))}
                {tl.segments.map((s, i) =>
                  s.row === r.row ? <Block key={i} seg={s} label={r.label} left={scale.x(s.start)} width={scale.x(s.end) - scale.x(s.start)} picked={sel === s} onPick={() => setPicked(i)} /> : null,
                )}
                {tl.marks
                  .filter((m) => m.row === r.row)
                  .map((m, i) => (
                    <span key={i} title={`${m.label} · ${when(m.at)}`} className={`absolute top-1/2 z-10 size-2 -translate-x-1/2 -translate-y-1/2 rotate-45 ring-2 ring-bg ${MARK[m.tone]}`} style={{ left: `${Math.min(0.985, scale.x(m.at)) * 100}%` }} />
                  ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      <Legend rows={rows.map((r) => r.row)} />
      <Inspector seg={sel} />
    </div>
  )
}

const WINDOWS = [
  ['6h', 6 * 3600_000],
  ['24h', 24 * 3600_000],
  ['3d', 72 * 3600_000],
] as const

// Every ticket on the board over the last hours, grouped like the columns.
export function BoardTimeline({ tickets }: { tickets: readonly Ticket[] }) {
  const now = useNow()
  const [win, setWin] = useState<(typeof WINDOWS)[number][0]>('24h')
  const [picked, setPicked] = useState<{ id: string; i: number } | null>(null)
  const span = WINDOWS.find((w) => w[0] === win)?.[1] ?? 24 * 3600_000
  const from = now - span
  const x = (t: number) => Math.min(1, Math.max(0, (t - from) / span))
  const rows = useMemo(
    () =>
      tickets
        .filter((t) => t.status !== 'skipped')
        .map((t) => ({ t, tl: ticketTimeline(t, now) }))
        .map((r) => ({ ...r, segs: r.tl.segments.filter((s) => s.end >= from) }))
        .filter((r) => r.segs.some((s) => s.row !== 'github') || r.t.status === 'running' || r.t.status === 'queued'),
    [tickets, now, from],
  )
  const groups = COLUMNS.map((c) => ({ ...c, rows: rows.filter((r) => c.statuses.includes(r.t.status) && (c.match?.(r.t) ?? true)) })).filter((g) => g.rows.length)
  const inWin = (s: TimelineSegment) => s.start >= from
  const spent = rows.reduce((a, r) => a + r.segs.filter(inWin).reduce((b, s) => b + (s.cost ?? 0), 0), 0)
  const working = rows.filter((r) => r.segs.some((s) => s.live && s.row === 'lane')).length
  const waiting = rows.filter((r) => r.segs.some((s) => s.live && s.wait)).length
  const ticks = Array.from({ length: 7 }, (_, i) => from + (span / 6) * i)
  const sel = picked ? rows.find((r) => r.t.id === picked.id) : null
  const selSeg = sel ? (sel.segs[picked?.i ?? -1] ?? null) : null
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 max-md:pb-24">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted">
        <span>
          <b className="font-medium text-fg">{working}</b> lane{working === 1 ? '' : 's'} working
        </span>
        <span>
          <b className="font-medium text-warn">{waiting}</b> waiting on you
        </span>
        <span>
          <b className="font-medium text-fg">{rows.length}</b> ticket{rows.length === 1 ? '' : 's'} active
        </span>
        <span>
          <b className="font-medium text-fg">{usd(spent)}</b> in turns
        </span>
        <div className="ml-auto inline-flex rounded-md border border-line-2 p-0.5" role="group" aria-label="time window">
          {WINDOWS.map(([k]) => (
            <button key={k} type="button" aria-pressed={win === k} onClick={() => setWin(k)} className={`rounded px-2 py-0.5 ${win === k ? 'bg-raised text-fg' : 'text-muted hover:text-fg'}`}>
              {k}
            </button>
          ))}
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="py-10 text-center text-xs text-dim">Nothing ran in the last {win}.</p>
      ) : (
        <div className="overflow-x-auto">
          <div className="grid min-w-[760px] grid-cols-[240px_1fr]">
            <div />
            <div className="relative h-5 font-mono text-[10px] text-dim tabular-nums">
              {ticks.map((t, i) => (
                <span key={t} className="absolute" style={{ left: `${(i / 6) * 100}%`, transform: i === 0 ? 'none' : i === 6 ? 'translateX(-100%)' : 'translateX(-50%)' }}>
                  {i === 6 ? 'now' : span > 24 * 3600_000 ? `${day(t)} ${clock(t)}` : clock(t)}
                </span>
              ))}
            </div>
            {groups.map((g) => (
              <div key={g.title} className="contents">
                <div className="col-span-2 flex items-center gap-2 pt-3 pb-1.5 text-[11px] text-muted">
                  <span className={`size-2 rounded-full ${g.dot}`} aria-hidden="true" />
                  {g.title}
                  <span className="text-dim">{g.rows.length}</span>
                </div>
                {g.rows.map(({ t, segs }) => {
                  const cost = segs.filter(inWin).reduce((a, s) => a + (s.cost ?? 0), 0)
                  return (
                    <div key={t.id} className="contents">
                      <a href={href.ticket(t.id)} className="flex min-w-0 flex-col justify-center gap-0.5 border-t border-line py-1.5 pr-3 hover:bg-raised/40">
                        <span className="flex items-center gap-2 text-[11px] text-muted">
                          {t.id}
                          {cost > 0 && <span className="ml-auto font-mono text-fg-2 tabular-nums">{usd(cost)}</span>}
                        </span>
                        <span className="truncate text-[12.5px] text-fg">{t.title}</span>
                      </a>
                      <div className="relative h-11 border-t border-line bg-[linear-gradient(90deg,#26272b_1px,transparent_1px)] bg-[length:calc(100%/6)_100%]">
                        {segs.map((s, i) => (s.row === 'github' ? <Block key={i} band seg={s} label={t.id} left={x(s.start)} width={x(s.end) - x(s.start)} picked={selSeg === s} onPick={() => setPicked({ id: t.id, i })} /> : null))}
                        {segs.map((s, i) => (s.row !== 'github' ? <Block key={i} seg={s} label={t.id} left={x(s.start)} width={x(s.end) - x(s.start)} picked={selSeg === s} onPick={() => setPicked({ id: t.id, i })} /> : null))}
                        <div className="pointer-events-none absolute inset-y-0 right-0 w-px bg-fg/40" aria-hidden="true" />
                      </div>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      )}
      <Legend rows={['lane', 'review', 'checks', 'github', 'you']} />
      <p className="-mt-1 text-[11px] text-dim">GitHub is the thin band under a ticket while its PR is open.</p>
      <Inspector seg={selSeg} ticket={sel?.t} link />
    </div>
  )
}
