// The review conversation on a PR as GitHub has it: threads (resolved or not), who reviewed what
// on which commit, and who is asked to review now. Used both ways: your own PRs (what reviewers
// are waiting on) and PRs you review (did the author deal with your comments).

export interface PrThreadComment {
  readonly id: number
  readonly author: string
  readonly body: string
  readonly at: string
  readonly url: string
}

export interface PrThread {
  // GraphQL node id, for resolving
  readonly id: string
  readonly resolved: boolean
  // the line moved since it was written
  readonly outdated: boolean
  readonly path?: string
  readonly line?: number
  readonly comments: readonly PrThreadComment[]
}

export interface PrReviewerState {
  readonly login: string
  // the reviewer's latest review that counts (approved, changes requested, or only comments)
  readonly state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'NONE'
  readonly at: string | null
  readonly sha: string | null
  // asked to review (again) right now
  readonly requested: boolean
}

export interface PrConversation {
  readonly author: string
  readonly headSha: string
  // when the head commit was pushed (committed), to tell what came after a review
  readonly headAt: string | null
  readonly threads: readonly PrThread[]
  readonly reviewers: readonly PrReviewerState[]
  readonly at: string
}

// --- your PR: what each reviewer who asked for changes is waiting on

export type FollowUpNext = 'fix' | 'tell' | 'waiting' | 'done'

export interface ReviewerFollowUp {
  readonly login: string
  readonly state: PrReviewerState['state']
  // their threads still open on GitHub
  readonly open: readonly PrThread[]
  // open threads you dealt with (mevo addressed them, or you replied after them) but left open
  readonly answered: readonly PrThread[]
  readonly pushedSince: boolean
  readonly requested: boolean
  // fix: comments still to address · tell: addressed, but GitHub doesn't show it (no re-review
  // asked) · waiting: re-review asked · done: approved or nothing open
  readonly next: FollowUpNext
}

const bots = /\[bot\]$|^(greptile|coderabbit|copilot|github-actions|vercel|cloudflare)/i

export function reviewerFollowUps(c: PrConversation, handled: Readonly<Record<string, { readonly how: string }>> = {}): ReviewerFollowUp[] {
  const me = c.author.toLowerCase()
  const out: ReviewerFollowUp[] = []
  for (const r of c.reviewers) {
    if (bots.test(r.login) || r.login.toLowerCase() === me) continue
    const theirs = c.threads.filter((t) => t.comments[0]?.author.toLowerCase() === r.login.toLowerCase())
    const open = theirs.filter((t) => !t.resolved)
    const answered = open.filter((t) => {
      const first = t.comments[0]
      if (!first) return false
      if (handled[`inline-${first.id}`]?.how === 'addressed' || handled[`inline-${first.id}`]?.how === 'replied') return true
      const last = t.comments.at(-1)
      return Boolean(last && last.author.toLowerCase() === me)
    })
    const pushedSince = Boolean(r.at && c.headAt && c.headAt > r.at) || Boolean(r.sha && r.sha !== c.headSha)
    let next: FollowUpNext
    if (r.state === 'APPROVED' && !r.requested) next = 'done'
    else if (r.requested) next = 'waiting'
    else if (r.state === 'CHANGES_REQUESTED') next = open.length > answered.length ? 'fix' : 'tell'
    else next = open.length > answered.length ? 'fix' : 'done'
    if (r.state !== 'CHANGES_REQUESTED' && !open.length && !r.requested) continue
    out.push({ login: r.login, state: r.state, open, answered, pushedSince, requested: r.requested, next })
  }
  return out
}

// --- a PR you reviewed: what happened to your comments

export interface MyThreadsSummary {
  readonly total: number
  readonly resolved: number
  // open, and the author replied
  readonly replied: number
  // open, the code under it changed
  readonly outdated: number
  // open, no reply, line unchanged
  readonly untouched: number
}

export function myThreads(c: PrConversation, me: string): { threads: PrThread[]; summary: MyThreadsSummary } {
  const lower = me.toLowerCase()
  const threads = c.threads.filter((t) => t.comments[0]?.author.toLowerCase() === lower)
  const open = threads.filter((t) => !t.resolved)
  const replied = open.filter((t) => t.comments.slice(1).some((x) => x.author.toLowerCase() === c.author.toLowerCase()))
  const outdated = open.filter((t) => t.outdated && !replied.includes(t))
  return {
    threads,
    summary: { total: threads.length, resolved: threads.length - open.length, replied: replied.length, outdated: outdated.length, untouched: open.length - replied.length - outdated.length },
  }
}
