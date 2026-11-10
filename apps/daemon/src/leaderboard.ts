import type { Leaderboard, LeaderRow } from '@ticketflow/shared'
import type { Linear } from './linear.js'
import { ghLogin, mergedSince } from './runner/github.js'

// The team's week or month: tickets done in Linear, PRs merged and reviews given on GitHub.
// Read-only and cheap (one Linear query, one gh call), cached for a while.
const TTL = 15 * 60_000

export class Leaders {
  private readonly cache = new Map<string, Leaderboard>()
  private me = ''
  constructor(private readonly repo: string, private readonly linear: Linear) {}

  async get(period: 'week' | 'month', fresh = false): Promise<Leaderboard> {
    const hit = this.cache.get(period)
    if (hit && !fresh && Date.now() - Date.parse(hit.at) < TTL) return hit
    const since = start(period)
    const errors: string[] = []
    if (!this.me) this.me = await ghLogin(this.repo).catch(() => '')
    const me = this.me.toLowerCase()
    const [tickets, merged, started] = await Promise.all([
      this.linear.doneSince(since).catch((e: unknown) => {
        errors.push(`Linear: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
        return []
      }),
      mergedSince(this.repo, since).catch((e: unknown) => {
        errors.push(`GitHub: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)
        return []
      }),
      this.linear.startedNow().catch(() => []),
    ])
    const prs = new Map<string, { count: number; lines: number }>()
    const reviews = new Map<string, number>()
    for (const pr of merged) {
      const row = prs.get(pr.author) ?? { count: 0, lines: 0 }
      prs.set(pr.author, { count: row.count + 1, lines: row.lines + pr.lines })
      for (const r of pr.reviewers) reviews.set(r, (reviews.get(r) ?? 0) + 1)
    }
    const gh = (login: string, count: number, extra?: number): LeaderRow => ({ name: login, login, count, ...(extra !== undefined ? { extra } : {}), you: login.toLowerCase() === me })
    const board: Leaderboard = {
      period,
      since,
      // the GitHub picture when the person linked GitHub in Linear, else their Linear avatar
      tickets: tickets.map((t) => ({ name: t.name, avatar: t.github ? `/api/avatar/id/${t.github}` : t.avatar, count: t.count, you: t.you })),
      progress: started.map((t) => ({ name: t.name, avatar: t.github ? `/api/avatar/id/${t.github}` : t.avatar, count: t.count, you: t.you })),
      prs: [...prs].map(([login, r]) => gh(login, r.count, r.lines)).sort((a, b) => b.count - a.count || (b.extra ?? 0) - (a.extra ?? 0)),
      reviews: [...reviews].map(([login, n]) => gh(login, n)).sort((a, b) => b.count - a.count),
      at: new Date().toISOString(),
      errors,
    }
    if (!errors.length) this.cache.set(period, board)
    return board
  }
}

// Monday 00:00 local for the week, the 1st for the month.
function start(period: 'week' | 'month'): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  if (period === 'month') d.setDate(1)
  else d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d.toISOString()
}
