import type { StartChoice, Ticket, TicketEvent, Triage } from './index.js'

// Estimates from your own history, no AI: every finished run (a `start` event up to the
// `ready` / `no-change` that ended it) is a sample with its minutes and the lane turns'
// cost in between. Similar tickets (same triage size and kind, else size, else a shared
// label) give the range; fewer than MIN_SAMPLES and there is no estimate.

export const MIN_SAMPLES = 5

export interface RunSample {
  readonly id: string
  readonly lane: StartChoice
  readonly minutes: number
  readonly cost: number | null
  readonly clean: boolean
  readonly size?: Triage['size']
  readonly kind?: Triage['kind']
  readonly labels: readonly string[]
}

export interface Estimate {
  readonly lane: StartChoice
  readonly n: number
  readonly minutes: readonly [number, number]
  readonly cost: readonly [number, number] | null
  // runs that ended clean (review ready without a failing supervisor) out of all that ended
  readonly clean: { readonly ok: number; readonly of: number }
  // what the samples have in common with this ticket, for "from your last 9 similar tickets (M, bug)"
  readonly basis: string
  // dollars per minute over these samples, for the live estimate while it runs
  readonly rate: number | null
}

const laneOf = (t: Ticket): StartChoice => (t.maxEffort ? 'max' : (t.lane ?? 'lite'))
const ms = (iso: string) => new Date(iso).getTime()

// Runs in one ticket's history. A run interrupted by a question still counts its time
// (the question's wait is taken out); stopped or failed runs only count against `clean`.
export function runSamples(t: Ticket, triage?: Triage): { readonly done: readonly RunSample[]; readonly ended: number } {
  const done: RunSample[] = []
  let ended = 0
  let start: number | null = null
  let waiting: number | null = null
  let paused = 0
  const evs = t.events
  for (const e of evs) {
    const at = ms(e.at)
    if (e.kind === 'start' || (e.kind === 'resume' && start === null)) {
      start = at
      paused = 0
      waiting = null
      continue
    }
    if (start === null) continue
    if (e.kind === 'question') waiting = at
    else if (e.kind === 'answer' && waiting !== null) {
      paused += at - waiting
      waiting = null
    } else if (e.kind === 'ready' || e.kind === 'no-change') {
      const minutes = (at - start - paused) / 60000
      const cost = (t.journal ?? []).filter((j) => ms(j.at) >= start! && ms(j.at) <= at + 120_000).reduce((s, j) => s + (Number(j.meta?.cost) || 0), 0)
      const clean = t.supervision ? t.supervision.verdict !== 'fail' : true
      if (minutes > 0.5 && minutes < 600) {
        done.push({ id: t.id, lane: laneOf(t), minutes, cost: cost > 0 ? cost : null, clean, labels: t.labels, ...(triage ? { size: triage.size, kind: triage.kind } : {}) })
        ended++
      }
      start = null
    } else if (e.kind === 'error' || e.kind === 'stop') {
      ended++
      start = null
    }
  }
  return { done, ended }
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return (sorted[lo] ?? 0) + ((sorted[hi] ?? 0) - (sorted[lo] ?? 0)) * (pos - lo)
}

export interface History {
  readonly samples: readonly RunSample[]
  readonly endedBy: Readonly<Record<string, { readonly ended: number; readonly lane: StartChoice }>>
}

export function buildHistory(tickets: readonly Ticket[], triage: Readonly<Record<string, Triage>> = {}): History {
  const samples: RunSample[] = []
  const endedBy: Record<string, { ended: number; lane: StartChoice }> = {}
  for (const t of tickets) {
    const r = runSamples(t, triage[t.id])
    samples.push(...r.done)
    if (r.ended) endedBy[t.id] = { ended: r.ended, lane: laneOf(t) }
  }
  return { samples, endedBy }
}

export function estimateFor(history: History, t: Pick<Ticket, 'id' | 'labels'>, lane: StartChoice, triage?: Triage): Estimate | null {
  const pool = history.samples.filter((s) => s.lane === lane && s.id !== t.id)
  const tiers: [string, (s: RunSample) => boolean][] = []
  if (triage) {
    tiers.push([`${triage.size}, ${triage.kind}`, (s) => s.size === triage.size && s.kind === triage.kind])
    tiers.push([`size ${triage.size}`, (s) => s.size === triage.size])
  }
  if (t.labels.length) tiers.push([t.labels.slice(0, 2).join(', '), (s) => s.labels.some((l) => t.labels.includes(l))])
  tiers.push(['all tickets', () => true])
  for (const [basis, match] of tiers) {
    const picked = pool.filter(match)
    if (picked.length < MIN_SAMPLES) continue
    const mins = picked.map((s) => s.minutes).sort((a, b) => a - b)
    const costs = picked.flatMap((s) => (s.cost === null ? [] : [s.cost])).sort((a, b) => a - b)
    const ids = new Set(picked.map((s) => s.id))
    const of = [...ids].reduce((n, id) => n + (history.endedBy[id]?.ended ?? 0), 0)
    const ok = picked.filter((s) => s.clean).length
    const costed = picked.filter((s) => s.cost !== null)
    const rate = costed.length >= 3 ? costed.reduce((n, s) => n + (s.cost ?? 0), 0) / costed.reduce((n, s) => n + s.minutes, 0) : null
    return {
      lane,
      n: picked.length,
      minutes: [Math.max(1, Math.round(quantile(mins, 0.25))), Math.max(1, Math.round(quantile(mins, 0.75)))],
      cost: costs.length >= 3 ? [quantile(costs, 0.25), quantile(costs, 0.75)] : null,
      clean: { ok, of: Math.max(of, picked.length) },
      basis,
      rate,
    }
  }
  return null
}

// Engines that report no cost (Codex, Cursor on a plan): time and tokens only.
export const reportsCost = (t: Pick<Ticket, 'engine'>): boolean => !/^(codex|cursor)/.test(t.engine ?? '')

// An update from main is a run only when the lane merges locally ("merging main" … "merged N commit(s)").
// The GitHub update-branch button runs no lane, so it neither starts nor ends one.
const startsRun = (e: TicketEvent) => ['start', 'resume', 'answer', 'fix-comments'].includes(e.kind) || (e.kind === 'update' && /^merging /.test(e.message ?? ''))
const endsRun = (e: TicketEvent) => ['ready', 'no-change', 'error', 'stop', 'merged'].includes(e.kind) || (e.kind === 'update' && /^merged /.test(e.message ?? ''))

// The current run: when it started and how long it waited on your answers. A question and its
// answer stay inside the run, so the clock does not restart when you reply.
export function currentRun(t: Ticket): { readonly start: string; readonly pausedMs: number } | null {
  let start: string | null = null
  let paused = 0
  let waiting: string | null = null
  for (const e of t.events) {
    if (e.kind === 'question' && start) waiting = e.at
    else if (e.kind === 'answer' && waiting) {
      paused += ms(e.at) - ms(waiting)
      waiting = null
    } else if (startsRun(e)) {
      if (!start) {
        start = e.at
        paused = 0
      }
    } else if (endsRun(e)) {
      start = null
      waiting = null
    }
  }
  return start ? { start, pausedMs: paused } : null
}

export function runStartedAt(t: Ticket): string | null {
  return currentRun(t)?.start ?? null
}

// Minutes the current run has been working, not counting the wait for your answers.
export function runMinutes(t: Ticket, now = Date.now()): number | null {
  const r = currentRun(t)
  return r ? Math.max(0, (now - ms(r.start) - r.pausedMs) / 60000) : null
}

// Spend so far in the current run: the lane turns that already reported a cost, plus the
// time since the last of them at the historical $/min. `approx` is false when nothing is guessed.
export function liveSpend(t: Ticket, rate: number | null, now = Date.now()): { readonly usd: number; readonly approx: boolean } | null {
  if (!reportsCost(t)) return null
  const since = runStartedAt(t)
  if (!since) return null
  const costed = (t.journal ?? []).filter((j) => ms(j.at) >= ms(since) && Number(j.meta?.cost) > 0)
  const known = costed.reduce((s, j) => s + Number(j.meta?.cost), 0)
  if (t.status !== 'running' || rate === null) return known > 0 ? { usd: known, approx: false } : null
  const from = Math.max(ms(since), ...costed.map((j) => ms(j.at)))
  return { usd: known + Math.max(0, (now - from) / 60000) * rate, approx: true }
}

export function fmtMinutes(m: number): string {
  const r = Math.round(m)
  return r < 60 ? `${r}m` : `${Math.floor(r / 60)}h ${r % 60}m`
}

// "~18–26 min", "~1h–1h 20m", "~$0.7–2.1"
export function minutesRange(r: readonly [number, number]): string {
  const [a, b] = r.map(Math.round) as [number, number]
  if (a === b) return `~${fmtMinutes(a)}`
  return b < 60 ? `~${a}–${b} min` : `~${fmtMinutes(a)}–${fmtMinutes(b)}`
}
export function usdRange(r: readonly [number, number]): string {
  const f = (n: number) => (n < 10 ? n.toFixed(1).replace(/\.0$/, '') : String(Math.round(n)))
  return f(r[0]) === f(r[1]) ? `~$${f(r[0])}` : `~$${f(r[0])}–${f(r[1])}`
}
export const usd = (n: number) => (n < 10 ? `$${n.toFixed(n < 1 ? 2 : 1).replace(/\.0$/, '')}` : `$${Math.round(n)}`)
