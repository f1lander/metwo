import type { PrComment, Ticket } from '@ticketflow/shared'
import type { Config } from './config.js'
import { log } from './log.js'
import { editPrBody, fetchPrInfo, ghLogin, previewUrl } from './runner/github.js'
import { git } from './runner/shell.js'
import type { Store } from './store.js'

export interface PrNotifier {
  readonly prComments: (ticket: Ticket, comments: readonly PrComment[]) => Promise<void>
  readonly prCi: (ticket: Ticket) => Promise<void>
  readonly prMerged: (ticket: Ticket) => Promise<void>
  readonly greptile: (ticket: Ticket) => Promise<void>
  // commits landed on the PR that metwo did not push (you pushed by hand, or GitHub's "Update branch")
  readonly outsidePush: (ticket: Ticket) => Promise<void>
  // the PR got the QA label (github.qa.label)
  readonly qaRequested: (ticket: Ticket) => Promise<void>
}

// Polls PRs with gh, diffs comments against what we already stored, and reports only what is new.
// Own comments are ignored so a reply from the operator does not bounce back. It also follows
// what happens on GitHub itself: a PR opened or marked ready by hand, merged or closed there.
export class PrSync {
  private me: string | null = null

  constructor(private readonly cfg: Config, private readonly store: Store, private readonly notify: PrNotifier) {}

  onResult: ((ok: boolean, detail: string) => void) | null = null

  async tick(): Promise<void> {
    // anything with a worktree that may have a PR, including one opened outside metwo
    const open = this.store.all().filter((t) => t.worktree && (t.pr || t.prUrl || t.status === 'review_ready') && !['done', 'skipped', 'assigned', 'queued'].includes(t.status))
    if (open.length === 0) {
      this.onResult?.(true, 'no open PRs')
      return
    }
    if (!this.me) this.me = await ghLogin(this.cfg.repo.path).catch(() => '')
    let errors = 0
    for (const ticket of open) {
      await this.syncOne(ticket).catch((e: unknown) => {
        errors += 1
        log.warn(`${ticket.id}: pr sync failed`, e)
      })
    }
    this.onResult?.(errors === 0, errors === 0 ? `${open.length} PR(s) synced` : `${errors}/${open.length} PR syncs failed`)
  }

  private async syncOne(current: Ticket): Promise<void> {
    let ticket = current
    const worktree = ticket.worktree
    if (!worktree) return
    // by number once known, so a renamed head branch still finds its PR
    const pr = await fetchPrInfo(worktree, ticket.pr?.number ? String(ticket.pr.number) : ticket.branch, this.cfg.github.greptile.bot)
    if (!pr) return

    const known = new Set((ticket.pr?.comments ?? []).map((c) => c.id))
    // bots (Greptile, preview deploys) have their own path; only people land here
    const fresh = pr.comments.filter((c) => !known.has(c.id) && c.author !== this.me && !c.bot)
    const greptileNew = pr.greptile && pr.greptile.key !== ticket.pr?.greptile?.key
    const ciFlipped = ticket.pr && ticket.pr.ci !== pr.ci && pr.ci === 'failure'

    if (pr.head && pr.head !== ticket.branch) {
      this.store.patch(ticket.id, { branch: pr.head }, { kind: 'pr', message: `branch is now ${pr.head}` })
      this.store.journal(ticket.id, { kind: 'pr', title: `Branch renamed to ${pr.head}`, meta: { from: ticket.branch } })
      ticket = this.store.get(ticket.id) ?? ticket
    }
    // the preview deploy comments after the push; drop its link into the body's marker once
    const preview = pr.body?.includes('<!-- preview -->') ? previewUrl(pr.comments) : null
    if (preview && pr.body) {
      await editPrBody(worktree, String(pr.number), pr.body.replace('<!-- preview -->', `[Open preview](${preview})`)).catch((e: unknown) => log.warn(`${ticket.id}: preview link not added`, e))
      this.store.journal(ticket.id, { kind: 'pr', title: 'Added the preview link to the PR', meta: { url: preview } })
    }
    const before = ticket.pr?.headSha
    if (before && pr.headSha && pr.headSha !== before && pr.headSha !== ticket.pushedSha) {
      this.store.journal(ticket.id, { kind: 'pr', title: 'New commits on the PR from outside metwo', meta: { sha: pr.headSha.slice(0, 8) } })
      if (ticket.visual) this.store.patch(ticket.id, { visualStale: true })
      await this.notify.outsidePush(this.store.get(ticket.id) ?? ticket)
    }
    if (!ticket.prUrl && pr.url) {
      this.store.patch(ticket.id, { prUrl: pr.url }, { kind: 'pr', message: `found PR #${pr.number} on GitHub` })
      ticket = this.store.get(ticket.id) ?? ticket
    }
    // the PR already has every local commit (pushed by hand, or by an older run): it is open, not waiting for a push
    if (ticket.status === 'review_ready' && pr.state === 'OPEN' && pr.headSha) {
      const head = await git(['rev-parse', 'HEAD'], worktree).catch(() => '')
      if (head === pr.headSha) {
        this.store.patch(ticket.id, { status: 'pr_draft', pushedSha: head }, { kind: 'pr', message: `PR #${pr.number} already has these commits` })
        this.store.journal(ticket.id, { kind: 'pr', title: `PR #${pr.number} is up to date on GitHub`, body: pr.isDraft ? 'Still a draft.' : 'Ready for review on GitHub.', meta: { url: pr.url } })
        ticket = this.store.get(ticket.id) ?? ticket
      }
    }
    if (ticket.pr && ticket.pr.isDraft && !pr.isDraft && pr.state === 'OPEN') {
      this.store.journal(ticket.id, { kind: 'pr', title: 'Marked ready for review on GitHub', meta: { url: pr.url } })
    }
    if (pr.state === 'CLOSED' && ticket.pr?.state !== 'CLOSED') {
      this.store.journal(ticket.id, { kind: 'pr', title: `PR #${pr.number} was closed on GitHub`, meta: { url: pr.url } })
    }
    if (pr.state === 'MERGED') {
      const done = this.store.patch(ticket.id, { pr, status: 'done' }, { kind: 'merged', message: `PR #${pr.number} merged` })
      await this.notify.prMerged(done)
      return
    }
    const qaLabel = this.cfg.github.qa.label.toLowerCase()
    const qaNew = Boolean(ticket.pr) && (pr.labels ?? []).some((l) => l.toLowerCase() === qaLabel) && !(ticket.pr?.labels ?? []).some((l) => l.toLowerCase() === qaLabel)
    const updated = this.store.patch(
      ticket.id,
      { pr },
      fresh.length > 0 ? { kind: 'pr-comment', message: `${fresh.length} new comment(s) on PR #${pr.number}` } : undefined,
    )
    if (fresh.length > 0) await this.notify.prComments(updated, fresh)
    if (greptileNew && pr.greptile) {
      const g = pr.greptile
      this.store.journal(ticket.id, {
        kind: 'review',
        title: `Greptile ${g.score ?? '?'}/5 · ${g.findings.length} finding(s)`,
        body: g.findings.map((f) => `- ${f.level ? `[${f.level}] ` : ''}${f.title}${f.path ? ` (${f.path}${f.line ? `:${f.line}` : ''})` : ''}`).join('\n'),
        meta: { url: g.url },
      })
      await this.notify.greptile(this.store.get(ticket.id) ?? updated)
    }
    if (ciFlipped) await this.notify.prCi(updated)
    if (qaNew) {
      this.store.journal(ticket.id, { kind: 'pr', title: `${this.cfg.github.qa.label} on the PR`, meta: { url: pr.url } })
      await this.notify.qaRequested(this.store.get(ticket.id) ?? updated)
    }
  }
}

export function formatComments(comments: readonly PrComment[]): string {
  return comments
    .map((c) => `- ${c.author}${c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ''}` : ''}: ${c.body.trim()}\n  (${c.url})`)
    .join('\n')
}
