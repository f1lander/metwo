import type { JournalEntry, Ticket, TicketEvent } from './index.js'

// A ticket's history as blocks on rows: who was working (the lane, the review pass, the gates and
// supervisor, GitHub, you) and from when to when. Built only from the events and journal the daemon
// already keeps; nothing new is recorded for it.

export type TimelineRow = 'lane' | 'review' | 'checks' | 'github' | 'you'

export interface TimelineSegment {
  readonly row: TimelineRow
  readonly start: number
  readonly end: number
  readonly label: string
  readonly detail?: string
  readonly cost?: number
  readonly engine?: string
  // still going (the lane is running now, or it is waiting on you now)
  readonly live?: boolean
  // waiting on you
  readonly wait?: boolean
  readonly failed?: boolean
}

export interface TimelineMark {
  readonly row: TimelineRow
  readonly at: number
  readonly label: string
  readonly tone: 'ok' | 'warn' | 'bad' | 'neutral'
}

export interface TicketTimeline {
  readonly segments: readonly TimelineSegment[]
  readonly marks: readonly TimelineMark[]
  readonly start: number | null
  readonly end: number
}

export const TIMELINE_ROWS: readonly { readonly row: TimelineRow; readonly label: string }[] = [
  { row: 'lane', label: 'Lane' },
  { row: 'review', label: 'Review pass' },
  { row: 'checks', label: 'Gates + supervisor' },
  { row: 'github', label: 'GitHub' },
  { row: 'you', label: 'You' },
]

type Item = { readonly at: number; readonly src: 'e'; readonly e: TicketEvent } | { readonly at: number; readonly src: 'j'; readonly j: JournalEntry }

const WAITING: readonly Ticket['status'][] = ['needs_input', 'review_ready', 'no_change', 'stopped', 'failed']
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() && !Number.isNaN(Number(v)) ? Number(v) : undefined)

export function ticketTimeline(t: Ticket, now = Date.now()): TicketTimeline {
  const items: Item[] = [
    ...t.events.map((e) => ({ at: Date.parse(e.at), src: 'e' as const, e })),
    ...(t.journal ?? []).map((j) => ({ at: Date.parse(j.at), src: 'j' as const, j })),
  ]
    .filter((i) => !Number.isNaN(i.at))
    // at the same instant the journal (what happened) goes before the event (what it led to)
    .sort((a, b) => a.at - b.at || (a.src === b.src ? 0 : a.src === 'j' ? -1 : 1))

  const segments: TimelineSegment[] = []
  const marks: TimelineMark[] = []
  // set inside the helpers below too, so typed by assertion (an annotation would be narrowed to null)
  type Open = { start: number; label: string }
  let lane = null as Open | null
  let you = null as Open | null
  let gh = null as Open | null
  let update = null as number | null
  // end of the last piece of work in the current run: the review pass and the supervisor start there
  let last = null as number | null
  let laneCost = undefined as number | undefined
  // a resumed session reports its running total, so a turn's own cost is the difference
  let sessionCost = 0
  const turnCost = (reported: number | undefined): number | undefined => {
    if (reported === undefined) return undefined
    const own = reported >= sessionCost ? reported - sessionCost : reported
    sessionCost = reported
    return Math.round(own * 100) / 100
  }

  const closeLane = (at: number, extra: Partial<TimelineSegment> = {}) => {
    const start = lane?.start ?? last
    const cost = turnCost(laneCost)
    if (start !== null && start !== undefined && at >= start) segments.push({ row: 'lane', start, end: at, label: lane?.label ?? 'Lane turn', ...(cost ? { cost } : {}), ...extra })
    lane = null
    laneCost = undefined
    last = at
  }
  const openLane = (at: number, label: string) => {
    if (lane) return
    if (you) {
      segments.push({ row: 'you', start: you.start, end: at, label: you.label, wait: true })
      you = null
    }
    lane = { start: at, label }
    last = at
  }
  const openYou = (at: number, label: string) => {
    if (!you) you = { start: at, label }
  }

  for (const it of items) {
    const at = it.at
    if (it.src === 'e') {
      const { kind, message } = it.e
      if (kind === 'start') {
        sessionCost = 0
        openLane(at, 'Implementing')
      }
      else if (kind === 'resume') openLane(at, 'Resumed')
      else if (kind === 'answer') openLane(at, 'After your answer')
      else if (kind === 'fix-comments') openLane(at, /greptile/i.test(message) ? 'Greptile findings' : /^fixing CI/i.test(message) ? 'Fixing CI' : 'Addressing comments')
      else if (kind === 'update' && /^merging /.test(message)) {
        update = at
        openLane(at, 'Update from main')
      } else if (kind === 'update' && /^merged /.test(message)) {
        if (lane) closeLane(at)
        else if (update !== null) segments.push({ row: 'lane', start: update, end: at, label: 'Update from main' })
        update = null
      } else if (kind === 'lane') {
        // the journal's run entry at the same instant already closed the turn with its cost
        if (lane) laneCost = laneCost ?? num(/\(\$([\d.]+)\)/.exec(message)?.[1])
      } else if (kind === 'question') {
        if (lane) closeLane(at)
        openYou(at, 'Question from the lane')
      } else if (kind === 'ready' || kind === 'no-change') {
        if (lane) closeLane(at)
        openYou(at, kind === 'ready' ? 'Your review' : 'No change needed')
        last = null
      } else if (kind === 'error' || kind === 'stop') {
        if (lane) closeLane(at, kind === 'error' ? { failed: true, detail: message } : { detail: 'stopped' })
        openYou(at, kind === 'error' ? 'Failed: your call' : 'Stopped')
        last = null
      } else if (kind === 'pr' && /^(draft PR|pushed to existing PR)/.test(message)) {
        if (you) {
          segments.push({ row: 'you', start: you.start, end: at, label: you.label, wait: true })
          you = null
        }
        if (!gh) gh = { start: at, label: t.pr?.isDraft === false ? 'In review' : 'Draft PR' }
        marks.push({ row: 'github', at, label: /^draft/.test(message) ? 'PR opened' : 'Pushed', tone: 'neutral' })
      } else if (kind === 'pr' && /ready for review/i.test(message)) {
        marks.push({ row: 'github', at, label: 'Ready for review', tone: 'ok' })
      } else if (kind === 'pr-comment') {
        marks.push({ row: 'github', at, label: message, tone: 'warn' })
      } else if (kind === 'merged') {
        if (gh) segments.push({ row: 'github', start: gh.start, end: at, label: 'PR' })
        gh = null
        marks.push({ row: 'github', at, label: 'Merged', tone: 'ok' })
      }
    } else {
      const { kind, title, meta } = it.j
      if (kind === 'run') {
        const minutes = num(meta?.minutes)
        const cost = num(meta?.cost) ?? laneCost
        if (!lane && last === null && minutes) lane = { start: at - minutes * 60_000, label: 'Lane turn' }
        if (!lane && last !== null) lane = { start: last, label: /supervisor round/i.test(title) ? 'Supervisor fixes' : 'Lane turn' }
        if (cost !== undefined) laneCost = cost
        closeLane(at, { engine: String(meta?.model ?? meta?.engine ?? '') || undefined, detail: title } as Partial<TimelineSegment>)
      } else if (kind === 'review' && /^Review pass/.test(title) && last !== null) {
        const cost = num(meta?.cost)
        segments.push({ row: 'review', start: last, end: at, label: 'Review pass', detail: title, ...(cost ? { cost } : {}) })
        last = at
      } else if (kind === 'review' && /^Supervisor/.test(title) && last !== null) {
        const fail = /concerns|fail/i.test(title) && !/pass/i.test(title)
        segments.push({ row: 'checks', start: last, end: at, label: fail ? 'Supervisor: concerns' : 'Gates + supervisor', detail: title, ...(fail ? { failed: true } : {}) })
        last = at
      } else if (kind === 'review' && /^Greptile/.test(title)) {
        marks.push({ row: 'github', at, label: title, tone: /0 finding/.test(title) ? 'ok' : 'warn' })
      } else if (kind === 'review' && /^CI red/.test(title)) {
        marks.push({ row: 'github', at, label: title, tone: 'bad' })
      } else if (kind === 'failure') {
        marks.push({ row: lane ? 'lane' : 'github', at, label: title, tone: 'bad' })
      }
    }
  }

  const live = t.status === 'running' || t.status === 'queued'
  const lastAt = items.at(-1)?.at ?? now
  if (lane) {
    const l = lane
    const cost = turnCost(laneCost)
    segments.push({ row: 'lane', start: l.start, end: live ? now : lastAt, label: live && t.stage?.name ? t.stage.name : l.label, ...(live ? { live: true } : {}), ...(cost ? { cost } : {}) })
  }
  if (you) {
    const y = you
    const still = WAITING.includes(t.status)
    segments.push({ row: 'you', start: y.start, end: still ? now : lastAt, label: y.label, wait: true, ...(still ? { live: true } : {}) })
  }
  if (gh) {
    const g = gh
    const open = t.pr?.state === 'OPEN' || (!t.pr && t.status === 'pr_draft')
    segments.push({ row: 'github', start: g.start, end: open ? now : lastAt, label: t.pr?.isDraft === false ? 'In review' : g.label, ...(open ? { live: true } : {}) })
  }
  segments.sort((a, b) => a.start - b.start)
  const start = segments.length ? Math.min(...segments.map((s) => s.start)) : null
  return { segments, marks, start, end: Math.max(now, ...segments.map((s) => s.end)) }
}

// Long quiet stretches (nights, weekends) squeezed so a ticket that ran over days stays readable:
// returns a time → 0..1 mapping and the gaps it squeezed.
export function compressTime(busy: readonly (readonly [number, number])[], from: number, to: number, opts: { readonly gapMs?: number; readonly gapShare?: number } = {}): { readonly x: (t: number) => number; readonly gaps: readonly { readonly from: number; readonly to: number; readonly x: number }[] } {
  const gapMs = opts.gapMs ?? 45 * 60_000
  const spans = [...busy].map(([a, b]) => [Math.max(from, a), Math.min(to, b)] as [number, number]).filter(([a, b]) => b >= a).sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const s of spans) {
    const prev = merged.at(-1)
    if (prev && s[0] <= prev[1] + gapMs) prev[1] = Math.max(prev[1], s[1])
    else merged.push([s[0], s[1]])
  }
  // pieces of the axis: real time inside busy stretches, a fixed slot for each long gap
  const pieces: { from: number; to: number; gap: boolean }[] = []
  let cursor = from
  for (const [a, b] of merged) {
    if (a - cursor > gapMs) pieces.push({ from: cursor, to: a, gap: true })
    else if (a > cursor) pieces.push({ from: cursor, to: a, gap: false })
    pieces.push({ from: a, to: b, gap: false })
    cursor = b
  }
  if (to - cursor > gapMs) pieces.push({ from: cursor, to, gap: true })
  else if (to > cursor) pieces.push({ from: cursor, to, gap: false })
  const real = pieces.filter((p) => !p.gap).reduce((s, p) => s + (p.to - p.from), 0)
  const gapCount = pieces.filter((p) => p.gap).length
  const share = Math.min(0.4, gapCount * (opts.gapShare ?? 0.04))
  const gapW = gapCount ? share / gapCount : 0
  const realW = real > 0 ? (1 - share) / real : 0
  const starts: number[] = []
  let acc = 0
  for (const p of pieces) {
    starts.push(acc)
    acc += p.gap ? gapW : (p.to - p.from) * realW
  }
  const x = (t: number) => {
    if (!pieces.length) return 0
    if (t <= from) return 0
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i] as { from: number; to: number; gap: boolean }
      if (t <= p.to) {
        const w = p.gap ? gapW : (p.to - p.from) * realW
        return (starts[i] as number) + (p.to === p.from ? 0 : ((t - p.from) / (p.to - p.from)) * w)
      }
    }
    return 1
  }
  return { x: (t) => Math.min(1, Math.max(0, x(t))), gaps: pieces.flatMap((p, i) => (p.gap ? [{ from: p.from, to: p.to, x: starts[i] as number }] : [])) }
}
