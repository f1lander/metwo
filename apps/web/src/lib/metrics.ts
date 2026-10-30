import type { Effort, JournalEntry, Ticket } from '@ticketflow/shared'

// Personal metrics, computed in the browser from the tickets and their journals.
// Spend is what the CLIs report: Claude reports an API-priced cost even on a flat plan,
// Codex and Cursor report none, so their work shows in minutes and tokens only.

export type Grain = 'day' | 'week' | 'month'

export interface Bucket {
  readonly start: Date
  readonly label: string
  readonly shipped: number
  readonly prs: number
  readonly cost: number
}

// One ticket, reduced to the facts the dashboard needs.
export interface TicketFacts {
  readonly t: Ticket
  readonly assignedAt: number
  readonly prAt: number | null
  readonly shippedAt: number | null
  readonly runs: readonly { at: number; cost: number; tokens: number; minutes: number }[]
  readonly cost: number
  readonly minutes: number
  readonly followUps: number
  readonly greptile: number | null
  readonly supervision: 'pass' | 'concerns' | 'fail' | null
  readonly lines: number | null
  readonly engine: string
  readonly lane: 'lite' | 'full' | 'max' | null
  readonly effort: string | null
}

const ms = (iso: string) => new Date(iso).getTime()
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0)

function shippedAt(t: Ticket): number | null {
  if (t.status !== 'done') return null
  const e = t.events.find((x) => x.kind === 'merged' || x.kind === 'linear' || (x.kind === 'decision' && /marked done/.test(x.message)))
  return e ? ms(e.at) : ms(t.updatedAt)
}

const isRun = (j: JournalEntry) => j.kind === 'run' || (j.kind === 'review' && (j.meta?.cost !== undefined || j.meta?.tokens !== undefined))

export function facts(t: Ticket): TicketFacts {
  const journal = t.journal ?? []
  const runs = journal.filter(isRun).map((j) => ({ at: ms(j.at), cost: num(j.meta?.cost), tokens: num(j.meta?.tokens), minutes: num(j.meta?.minutes) }))
  const pr = journal.find((j) => j.kind === 'pr' && j.title.startsWith('Opened a draft PR'))
  const g = journal.map((j) => (j.kind === 'review' ? /^Greptile (\d)\/5/.exec(j.title) : null)).find(Boolean)
  const stat = t.diffStat ? [...t.diffStat.matchAll(/(\d+) (?:insertion|deletion)/g)].reduce((n, m) => n + Number(m[1]), 0) : null
  return {
    t,
    assignedAt: ms(t.seenAt),
    prAt: pr ? ms(pr.at) : null,
    shippedAt: shippedAt(t),
    runs,
    cost: runs.reduce((n, r) => n + r.cost, 0),
    minutes: runs.reduce((n, r) => n + r.minutes, 0),
    followUps: journal.filter((j) => j.kind === 'run' && j.title.startsWith('Lane resumed')).length,
    greptile: g ? Number(g[1]) : null,
    supervision: t.supervision?.verdict ?? null,
    lines: stat,
    engine: (t.engine ?? t.sessionEngine ?? 'claude').split(':')[0] ?? 'claude',
    lane: t.maxEffort ? 'max' : (t.lane ?? null),
    effort: t.maxEffort ? 'max' : (t.effort ?? null),
  }
}

// Period boundaries in local time. Weeks start on Monday.
function startOf(grain: Grain, d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  if (grain === 'week') x.setDate(x.getDate() - ((x.getDay() + 6) % 7))
  if (grain === 'month') x.setDate(1)
  return x
}

function shift(grain: Grain, d: Date, n: number): Date {
  const x = new Date(d)
  if (grain === 'day') x.setDate(x.getDate() + n)
  if (grain === 'week') x.setDate(x.getDate() + 7 * n)
  if (grain === 'month') x.setMonth(x.getMonth() + n)
  return x
}

const COUNT: Record<Grain, number> = { day: 14, week: 12, month: 6 }

function label(grain: Grain, d: Date): string {
  if (grain === 'month') return d.toLocaleDateString([], { month: 'short' })
  if (grain === 'week') return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  return `${d.toLocaleDateString([], { weekday: 'short' })} ${d.getDate()}`
}

export interface Period {
  readonly shipped: number
  readonly prs: number
  readonly cost: number
  readonly tokens: number
  readonly minutes: number
  readonly turns: number
  readonly medianHoursToPr: number | null
  readonly firstPass: { readonly clean: number; readonly of: number }
  readonly followUps: number | null
  readonly visual: { readonly verified: number; readonly of: number }
}

function median(xs: readonly number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2
}

function period(all: readonly TicketFacts[], from: number, to: number): Period {
  const inside = (x: number | null) => x !== null && x >= from && x < to
  const runs = all.flatMap((f) => f.runs.filter((r) => inside(r.at)))
  const opened = all.filter((f) => inside(f.prAt))
  const reviewed = opened.filter((f) => f.greptile !== null || f.supervision !== null)
  const visualAsked = opened.filter((f) => f.t.visual && f.t.visual.verdict !== 'not_applicable')
  return {
    shipped: all.filter((f) => inside(f.shippedAt)).length,
    prs: opened.length,
    cost: runs.reduce((n, r) => n + r.cost, 0),
    tokens: runs.reduce((n, r) => n + r.tokens, 0),
    minutes: runs.reduce((n, r) => n + r.minutes, 0),
    turns: runs.length,
    medianHoursToPr: median(opened.map((f) => ((f.prAt as number) - f.assignedAt) / 3_600_000)),
    firstPass: { clean: reviewed.filter(clean).length, of: reviewed.length },
    followUps: opened.length ? opened.reduce((n, f) => n + f.followUps, 0) / opened.length : null,
    visual: { verified: visualAsked.filter((f) => f.t.visual?.verdict === 'verified').length, of: visualAsked.length },
  }
}

// Came back clean the first time: Greptile 4+ and no supervisor fail, without being asked twice.
function clean(f: TicketFacts): boolean {
  return (f.greptile === null || f.greptile >= 4) && f.supervision !== 'fail' && f.followUps <= 1
}

export function buckets(all: readonly TicketFacts[], grain: Grain, now = new Date()): Bucket[] {
  const first = shift(grain, startOf(grain, now), -(COUNT[grain] - 1))
  return Array.from({ length: COUNT[grain] }, (_, i) => {
    const start = shift(grain, first, i)
    const p = period(all, start.getTime(), shift(grain, start, 1).getTime())
    return { start, label: label(grain, start), shipped: p.shipped, prs: p.prs, cost: p.cost }
  })
}

export function current(all: readonly TicketFacts[], grain: Grain, now = new Date()): { now: Period; prev: Period } {
  const start = startOf(grain, now)
  return {
    now: period(all, start.getTime(), shift(grain, start, 1).getTime()),
    // the same stretch of the previous period, so Tuesday compares with last Tuesday, not a whole week
    prev: period(all, shift(grain, start, -1).getTime(), shift(grain, now, -1).getTime()),
  }
}

export interface Mix {
  readonly key: string
  readonly tickets: number
  readonly cost: number
  readonly minutes: number
}

export function mix(all: readonly TicketFacts[], by: (f: TicketFacts) => string | null, from: number): Mix[] {
  const out = new Map<string, { tickets: number; cost: number; minutes: number }>()
  for (const f of all) {
    const runs = f.runs.filter((r) => r.at >= from)
    if (!runs.length) continue
    const key = by(f)
    if (!key) continue
    const m = out.get(key) ?? { tickets: 0, cost: 0, minutes: 0 }
    m.tickets++
    m.cost += runs.reduce((n, r) => n + r.cost, 0)
    m.minutes += runs.reduce((n, r) => n + r.minutes, 0)
    out.set(key, m)
  }
  return [...out.entries()].map(([key, m]) => ({ key, ...m })).sort((a, b) => b.tickets - a.tickets)
}

export interface Advice {
  readonly id: string
  readonly tone: 'save' | 'quality' | 'info'
  readonly title: string
  readonly detail: string
  readonly tickets: readonly string[]
  readonly effort?: Effort
}

const SMALL_DIFF = 80
export const money = (n: number) => (n === 0 ? '$0' : n < 10 ? `$${n.toFixed(2)}` : `$${Math.round(n).toLocaleString()}`)

// Rule-based and conservative: every suggestion names the tickets it comes from.
export function advise(all: readonly TicketFacts[], effort: Effort | undefined, since: number): Advice[] {
  const done = all.filter((f) => f.prAt !== null && f.prAt >= since && f.runs.length)
  if (done.length < 5) return []
  const out: Advice[] = []

  // heavy setup on small, clean work
  const heavy = done.filter((f) => (f.lane === 'full' || f.lane === 'max' || f.effort === 'high' || f.effort === 'max') && f.lines !== null && f.lines <= SMALL_DIFF && clean(f))
  if (heavy.length >= 2) {
    const spent = heavy.reduce((n, f) => n + f.cost, 0)
    out.push({
      id: 'heavy',
      tone: 'save',
      title: `${heavy.length} small tickets ran on full or high effort`,
      detail: `Each changed under ${SMALL_DIFF} lines and came back clean${spent ? `, ${money(spent)} together` : ''}. Start tickets like these on lite at medium or low effort.`,
      tickets: heavy.map((f) => f.t.id),
    })
  }

  // effort can go down a notch when almost everything comes back clean
  const rate = done.filter(clean).length / done.length
  if (effort === 'high' && rate >= 0.8) {
    out.push({ id: 'effort', tone: 'save', title: 'Try medium as the default effort', detail: `${Math.round(rate * 100)}% of the last ${done.length} PRs came back clean at high. Medium thinks less per turn, so it is cheaper and faster.`, tickets: [], effort: 'medium' })
  } else if (effort === 'low' && rate < 0.6) {
    out.push({ id: 'effort-up', tone: 'quality', title: 'Low effort is costing you rounds', detail: `Only ${Math.round(rate * 100)}% of the last ${done.length} PRs came back clean. Medium usually saves the follow-ups it costs.`, tickets: [], effort: 'medium' })
  }

  // lite that needed rescuing
  const weak = done.filter((f) => f.lane === 'lite' && (f.followUps >= 2 || f.supervision === 'fail' || (f.greptile !== null && f.greptile <= 2)))
  if (weak.length >= 2) {
    const labels = topLabels(weak)
    out.push({
      id: 'weak',
      tone: 'quality',
      title: `${weak.length} lite tickets needed extra rounds`,
      detail: `${labels ? `Mostly ${labels}. ` : ''}Starting these on full costs more per turn but usually less than two follow-ups.`,
      tickets: weak.map((f) => f.t.id),
    })
  }

  // labels that are consistently cheap and clean
  const byLabel = new Map<string, TicketFacts[]>()
  for (const f of done) for (const l of f.t.labels) byLabel.set(l, [...(byLabel.get(l) ?? []), f])
  for (const [l, fs] of byLabel) {
    if (fs.length < 3 || !fs.every(clean) || !fs.every((f) => f.lines !== null && f.lines <= SMALL_DIFF)) continue
    if (fs.every((f) => f.lane === 'lite' && f.effort === 'low')) continue
    out.push({ id: `label-${l}`, tone: 'save', title: `"${l}" tickets: lite, low effort`, detail: `The last ${fs.length} were small and came back clean. A low-effort lite lane is enough for this label.`, tickets: fs.map((f) => f.t.id) })
    break
  }

  // one ticket that ate the budget
  const costs = done.map((f) => f.cost).filter((c) => c > 0)
  const mid = median(costs)
  const worst = [...done].sort((a, b) => b.cost - a.cost)[0]
  if (worst && mid && costs.length >= 5 && worst.cost > 3 * mid && worst.followUps >= 2) {
    out.push({
      id: 'outlier',
      tone: 'info',
      title: `${worst.t.id} cost ${money(worst.cost)}, ${Math.round(worst.cost / mid)}× your median`,
      detail: `${worst.followUps} follow-up rounds. When a ticket starts going in circles, a short instruction with what you expect usually ends it sooner.`,
      tickets: [worst.t.id],
    })
  }

  return out.slice(0, 4)
}

function topLabels(fs: readonly TicketFacts[]): string {
  const n = new Map<string, number>()
  for (const f of fs) for (const l of f.t.labels) n.set(l, (n.get(l) ?? 0) + 1)
  return [...n.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .filter(([, c]) => c >= 2)
    .map(([l]) => `"${l}"`)
    .join(' and ')
}
