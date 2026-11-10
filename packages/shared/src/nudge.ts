// Nudges: a short DM to a reviewer when your PR waits on them. Either you addressed what they
// asked and pushed (look again), or they were asked and never looked (have a look).
import { reviewerFollowUps } from './conversation.js'
import type { Ticket } from './index.js'

export type NudgeKind = 'rereview' | 'review'

export interface Nudge {
  readonly id: string
  readonly login: string
  readonly kind: NudgeKind
  readonly number: number
  readonly url: string
  readonly title: string
  readonly sha: string
  // since when it has waited on them: your last push, or the review request
  readonly since: string | null
  // the last nudge you sent them about this PR
  readonly last: string | null
  // waited long enough, and not nudged in the last day: shown in Today and the board
  readonly due: boolean
}

export const NUDGE_WAIT_HOURS = 4
export const NUDGE_COOLDOWN_HOURS = 24
const bots = /\[bot\]$|^(greptile|coderabbit|copilot|github-actions|vercel|cloudflare)/i
const hours = (from: string | null, now: number) => (from ? (now - Date.parse(from)) / 3_600_000 : 0)

export function nudges(t: Ticket, now = Date.now()): Nudge[] {
  const c = t.conversation
  const pr = t.pr
  if (!c || !pr || pr.state !== 'OPEN' || pr.isDraft) return []
  const me = c.author.toLowerCase()
  const follow = reviewerFollowUps(c, t.commentsHandled ?? {})
  const out: Nudge[] = []
  for (const r of c.reviewers) {
    if (!r.requested || bots.test(r.login) || r.login.toLowerCase() === me) continue
    let kind: NudgeKind
    if (r.state === 'NONE') kind = 'review'
    else {
      const f = follow.find((x) => x.login === r.login)
      // only once every thread of theirs has your answer and the code moved since their review
      if (!f || f.open.length > f.answered.length || !f.pushedSince) continue
      kind = 'rereview'
    }
    const since = kind === 'rereview' ? (c.headAt ?? r.at) : (c.headAt ?? null)
    const last = t.nudges?.[r.login.toLowerCase()]?.at ?? null
    const due = hours(since, now) >= NUDGE_WAIT_HOURS && (!last || hours(last, now) >= NUDGE_COOLDOWN_HOURS)
    out.push({ id: t.id, login: r.login, kind, number: pr.number, url: pr.url, title: t.title, sha: c.headSha, since, last, due })
  }
  return out
}

// In your voice: casual, lowercase. Several PRs for the same person go in one message.
export function nudgeText(name: string, list: readonly Nudge[]): string {
  const who = name.trim().split(/\s+/)[0]?.toLowerCase() || 'hey'
  const one = list[0]
  if (!one) return ''
  const ref = (n: Nudge) => `#${n.number} (${n.id}: ${n.title})`
  if (list.length === 1) {
    return one.kind === 'rereview'
      ? `hey ${who}, i addressed your comments on ${ref(one)} in ${one.sha.slice(0, 7)}, could you take another look when you get a chance? ${one.url}`
      : `hey ${who}, when you get a chance could you review ${ref(one)}? ${one.url}`
  }
  const lines = list.map((n) => `• ${ref(n)}${n.kind === 'rereview' ? ', addressed your comments' : ''} ${n.url}`)
  return `hey ${who}, a few PRs waiting on you when you get a chance:\n${lines.join('\n')}`
}
