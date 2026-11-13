import type { PrComment, PrConversation, PrInfo, Ticket } from '@ticketflow/shared'
import type { Config } from './config.js'
import { log } from './log.js'
import { editPrBody, fetchPrInfo, ghLogin, prConversation, previewUrl } from './runner/github.js'
import { pullPrBranch } from './runner/pull.js'
import { unpushedSince } from './runner/worktree.js'
import { git, sh } from './runner/shell.js'
import type { Store } from './store.js'
import { loadStoryIndex, storiesBlock, storiesForChange, storybookPreview, tidyShots, withStories } from './storybook.js'

export interface PrNotifier {
  readonly prComments: (ticket: Ticket, comments: readonly PrComment[]) => Promise<void>
  readonly prCi: (ticket: Ticket) => Promise<void>
  readonly prMerged: (ticket: Ticket) => Promise<void>
  readonly greptile: (ticket: Ticket) => Promise<void>
  // commits landed on the PR that mevo did not push (you pushed by hand, or GitHub's "Update branch")
  readonly outsidePush: (ticket: Ticket) => Promise<void>
  readonly prClosed?: (ticket: Ticket) => Promise<void>
  // the PR got the QA label (github.qa.label)
  readonly qaRequested: (ticket: Ticket) => Promise<void>
}

// Polls PRs with gh, diffs comments against what we already stored, and reports only what is new.
// Own comments are ignored so a reply from the operator does not bounce back. It also follows
// what happens on GitHub itself: a PR opened or marked ready by hand, merged or closed there.
export class PrSync {
  private me: string | null = null

  // reads why CI went red before the notification goes out, so it can say so
  onCiRed: ((id: string) => Promise<unknown>) | null = null

  constructor(private readonly config: () => Config, private readonly store: Store, private readonly notify: PrNotifier) {}

  onResult: ((ok: boolean, detail: string) => void) | null = null
  // The PR's stories on the Storybook branch preview, listed in the body under its marker and kept
  // current: done for a head once the preview says it was built from that commit.
  private async syncStories(ticket: Ticket, pr: PrInfo, body: string, worktree: string): Promise<void> {
    if (!pr.headSha || ticket.storiesSha === pr.headSha || !/<!-- stories(:start)? -->/.test(body)) return
    const sb = storybookPreview(pr.comments)
    if (!sb) return
    try {
      const entries = await loadStoryIndex(sb.url)
      if (!entries.length) return
      const changed = (await git(['diff', '--name-only', `origin/${this.config().repo.baseBranch}...HEAD`], worktree)).split('\n').filter(Boolean)
      const stories = storiesForChange(entries, changed)
      const next = withStories(body, storiesBlock(sb.url, stories))
      if (next) {
        await editPrBody(worktree, String(pr.number), next)
        if (!body.includes('<!-- stories:start -->')) this.store.journal(ticket.id, { kind: 'pr', title: `Listed ${stories.length} Storybook stor${stories.length === 1 ? 'y' : 'ies'} in the PR`, meta: { url: sb.url } })
      }
      if (sb.sha && pr.headSha.startsWith(sb.sha)) this.store.patch(ticket.id, { storiesSha: pr.headSha })
    } catch (error) {
      log.warn(`${ticket.id}: stories not listed`, error)
    }
  }

  // GitHub says the PR conflicts with the base and mevo has not seen it yet
  onConflicting: ((id: string) => void) | null = null
  // the PR left draft on GitHub (marked ready outside mevo)
  onReady: ((t: Ticket) => void) | null = null

  private running: Promise<void> | null = null
  private readonly lastOne = new Map<string, number>()

  // Every open PR (the regular sync), or with `hot` only the ones likely to change in the next
  // minutes: pushed recently, CI still running, or GitHub still working out the merge state.
  // Ticks never overlap; a few PRs sync at once.
  tick(opts: { hot?: boolean } = {}): Promise<void> {
    if (this.running) return opts.hot ? Promise.resolve() : this.running.then(() => this.tick(opts))
    this.running = this.run(Boolean(opts.hot)).finally(() => {
      this.running = null
    })
    return this.running
  }

  // One PR now (you opened its ticket); at most every 20 seconds.
  async syncNow(id: string): Promise<void> {
    const t = this.store.get(id)
    if (!t?.worktree || Date.now() - (this.lastOne.get(id) ?? 0) < 20_000) return
    this.lastOne.set(id, Date.now())
    await this.syncOne(t)
  }

  private async run(hot: boolean): Promise<void> {
    // anything with a worktree that may have a PR, including one opened outside mevo
    // closed here because GitHub closed the PR: watched two more weeks in case it is reopened there
    const watchClosed = (t: Ticket) => t.status === 'done' && Boolean(t.closedOnGithub) && Date.now() - Date.parse(t.closedOnGithub?.at ?? '') < 14 * 86_400_000
    const all = this.store.all().filter((t) => !t.replay && t.worktree && (t.pr || t.prUrl || t.status === 'review_ready') && (!['done', 'skipped', 'assigned', 'queued'].includes(t.status) || watchClosed(t)))
    const open = hot ? all.filter(isHot) : all
    if (open.length === 0) {
      if (!hot) this.onResult?.(true, 'no open PRs')
      return
    }
    if (!this.me) this.me = await ghLogin(this.config().repo.path).catch(() => '')
    let errors = 0
    const queue = [...open]
    const worker = async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        const ticket = t
        this.lastOne.set(ticket.id, Date.now())
        await this.syncOne(this.store.get(ticket.id) ?? ticket).catch((e: unknown) => {
          errors += 1
          log.warn(`${ticket.id}: pr sync failed`, e)
        })
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, open.length) }, worker))
    if (!hot || errors) this.onResult?.(errors === 0, errors === 0 ? `${open.length} PR(s) synced` : `${errors}/${open.length} PR syncs failed`)
  }

  // Commits on GitHub the worktree lacks: a fast-forward comes in by itself (pipeline.autoPullPr),
  // anything else waits on the ticket for Pull from GitHub. `fresh`: new since the last sync.
  private async pullIn(ticket: Ticket, headSha: string, fresh: boolean): Promise<Ticket> {
    const worktree = ticket.worktree as string
    const local = await git(['rev-parse', 'HEAD'], worktree).catch(() => '')
    if (local === headSha) {
      const { unpushed: _u, ...same } = ticket
      return this.store.upsert({ ...same, pushedSha: headSha })
    }
    const r = this.config().pipeline.autoPullPr ? await pullPrBranch(worktree, ticket.branch, ticket.status, false) : { outcome: 'diverged' as const, commits: 0, remote: headSha, text: 'Automatic pulls are off; use Pull from GitHub.' }
    const { behindPr: _b, ...rest } = ticket
    if (r.outcome === 'current' || r.outcome === 'ahead') {
      // ahead: the fixes are here, not on the PR yet
      const unpushed = r.outcome === 'ahead' ? await unpushedSince(worktree, headSha).catch(() => null) : null
      const { unpushed: _u, ...base } = rest
      return this.store.upsert({ ...base, pushedSha: headSha, ...(unpushed?.count ? { unpushed } : {}) })
    }
    if (r.outcome === 'pulled') {
      const t = this.store.upsert({ ...rest, pushedSha: headSha, ...(ticket.visual ? { visualStale: true } : {}) })
      this.store.journal(ticket.id, { kind: 'pr', title: `Pulled ${r.commits} commit(s) from GitHub`, body: 'The PR branch moved on GitHub (Update branch, or a push from elsewhere); the worktree now matches it.', meta: { sha: headSha.slice(0, 8) } })
      if (fresh) await this.notify.outsidePush(this.store.get(ticket.id) ?? t)
      return this.store.get(ticket.id) ?? t
    }
    const why = r.outcome === 'busy' ? 'busy' : r.outcome === 'conflicts' ? 'conflicts' : r.outcome === 'diverged' ? 'diverged' : 'error'
    const t = this.store.patch(ticket.id, { behindPr: { sha: headSha, commits: r.commits, at: new Date().toISOString(), why, detail: r.text, ...(r.files?.length ? { files: r.files } : {}) }, ...(ticket.visual ? { visualStale: true } : {}) })
    if (ticket.behindPr?.sha !== headSha) {
      this.store.journal(ticket.id, { kind: 'pr', title: 'New commits on the PR from outside mevo', body: r.text, meta: { sha: headSha.slice(0, 8) } })
      if (fresh) await this.notify.outsidePush(t)
    }
    return t
  }

  // A reviewer asked for changes or approved since the last look: in the journal.
  private noteReviewChanges(ticket: Ticket, now: PrConversation): void {
    const before = new Map((ticket.conversation?.reviewers ?? []).map((r) => [r.login, r]))
    if (!ticket.conversation) return
    for (const r of now.reviewers) {
      const was = before.get(r.login)
      if (was?.state === r.state && was.at === r.at) continue
      if (r.state === 'CHANGES_REQUESTED') this.store.journal(ticket.id, { kind: 'review', title: `${r.login} requested changes`, body: `${now.threads.filter((t) => !t.resolved && t.comments[0]?.author === r.login).length} open thread(s) from them.` })
      if (r.state === 'APPROVED') this.store.journal(ticket.id, { kind: 'review', title: `${r.login} approved` })
    }
  }

  private async syncOne(current: Ticket): Promise<void> {
    let ticket = current
    const worktree = ticket.worktree
    if (!worktree) return
    // by number once known, so a renamed head branch still finds its PR
    const pr = await fetchPrInfo(worktree, ticket.pr?.number ? String(ticket.pr.number) : ticket.branch, this.config().github.greptile.bot)
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
    let body = pr.body ?? ''
    const preview = body.includes('<!-- preview -->') ? previewUrl(pr.comments) : null
    if (preview) {
      const next = body.replace('<!-- preview -->', `[Open preview](${preview})`)
      const ok = await editPrBody(worktree, String(pr.number), next).then(() => true, (e: unknown) => (log.warn(`${ticket.id}: preview link not added`, e), false))
      if (ok) body = next
      this.store.journal(ticket.id, { kind: 'pr', title: 'Added the preview link to the PR', meta: { url: preview } })
    }
    // older descriptions: thumbnails and the stories marker, once
    const tidy = pr.state === 'OPEN' ? tidyShots(body) : null
    if (tidy) {
      const ok = await editPrBody(worktree, String(pr.number), tidy).then(() => true, (e: unknown) => (log.warn(`${ticket.id}: screenshots not tidied`, e), false))
      if (ok) {
        body = tidy
        this.store.journal(ticket.id, { kind: 'pr', title: 'Made the PR screenshots thumbnails (click for full size)', meta: { url: pr.url } })
      }
    }
    await this.syncStories(ticket, pr, body, worktree)
    const before = ticket.pr?.headSha
    const gh = ticket.githubUpdate
    if (gh && pr.headSha && pr.headSha !== gh.from) {
      // our own "Update branch" on GitHub: bring the worktree along, no notification
      const synced = await fastForward(worktree, ticket.branch, ticket.status)
      const { githubUpdate: _done, behindMain, ...rest } = ticket
      this.store.upsert({ ...rest, pushedSha: pr.headSha, ...(behindMain && !synced.ok ? { behindMain } : {}) })
      this.store.journal(ticket.id, { kind: 'pr', title: `New head ${pr.headSha.slice(0, 7)} after the update on GitHub`, body: synced.text })
      ticket = this.store.get(ticket.id) ?? ticket
    } else if (gh && Date.now() - Date.parse(gh.at) > 30 * 60_000) {
      const { githubUpdate: _stale, ...rest } = ticket
      ticket = this.store.upsert(rest)
    } else if (pr.state === 'OPEN' && pr.headSha && pr.headSha !== ticket.pushedSha && (ticket.behindPr?.sha !== pr.headSha || (ticket.behindPr.why === 'busy' && ticket.status !== 'running' && ticket.status !== 'queued'))) {
      // the PR branch moved on GitHub (its Update branch button, a teammate): bring it in
      const fresh = Boolean(before && pr.headSha !== before)
      ticket = await this.pullIn(ticket, pr.headSha, fresh)
    }
    // local commits the PR doesn't have yet (a lane round you stopped, a fix not pushed)
    if (pr.state === 'OPEN' && pr.headSha && ticket.worktree && ticket.status !== 'running') {
      const head = pr.headSha
      const local = await git(['rev-parse', 'HEAD'], ticket.worktree).catch(() => head)
      const u = local === head ? null : await unpushedSince(ticket.worktree, head).catch(() => undefined)
      if (u !== undefined && (u?.count ?? 0) !== (ticket.unpushed?.count ?? 0)) {
        const { unpushed: _u, ...rest } = this.store.get(ticket.id) ?? ticket
        ticket = this.store.upsert(u?.count ? { ...rest, unpushed: u } : rest)
      }
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
    if (pr.state === 'OPEN' && pr.mergeable === 'CONFLICTING' && !ticket.behindMain?.conflicts && !ticket.manualMerge) this.onConflicting?.(ticket.id)
    const readyNow = Boolean(ticket.pr && ticket.pr.isDraft && !pr.isDraft && pr.state === 'OPEN')
    if (readyNow) this.store.journal(ticket.id, { kind: 'pr', title: 'Marked ready for review on GitHub', meta: { url: pr.url } })
    if (pr.state === 'CLOSED') {
      // closed without merging on GitHub: closed on the board too, once no lane is working on it
      if (ticket.status === 'done') {
        this.store.patch(ticket.id, { pr })
        return
      }
      if (ticket.status === 'running' || ticket.status === 'queued') {
        if (ticket.pr?.state !== 'CLOSED') {
          this.store.patch(ticket.id, { pr })
          this.store.journal(ticket.id, { kind: 'pr', title: `PR #${pr.number} was closed on GitHub`, body: 'A lane is working on it; the ticket closes when the lane is done.', meta: { url: pr.url } })
        }
        return
      }
      const by = await closedBy(worktree, pr.number)
      const { stopped: _s, question: _q, behindPr: _b, ...rest } = ticket
      this.store.upsert({ ...rest, pr, status: 'done', closedOnGithub: { at: new Date().toISOString(), by } })
      const closed = this.store.patch(ticket.id, {}, { kind: 'pr', message: `PR #${pr.number} closed on GitHub${by ? ` by ${by}` : ''}` })
      this.store.journal(ticket.id, { kind: 'pr', title: `PR #${pr.number} closed on GitHub${by ? ` by ${by}` : ''}`, body: 'Closed on the board too. The worktree and its commits stay; if the PR is reopened on GitHub, the ticket comes back by itself.', meta: { url: pr.url } })
      await this.notify.prClosed?.(closed)
      return
    }
    // reopened on GitHub after the board closed it: back where GitHub has it
    if (ticket.status === 'done' && ticket.closedOnGithub && pr.state === 'OPEN') {
      const { closedOnGithub: _c, ...rest } = ticket
      this.store.upsert({ ...rest, pr, status: 'pr_draft' })
      ticket = this.store.patch(ticket.id, {}, { kind: 'pr', message: `PR #${pr.number} reopened on GitHub` })
      this.store.journal(ticket.id, { kind: 'pr', title: `PR #${pr.number} reopened on GitHub`, body: 'Back on the board.', meta: { url: pr.url } })
    }
    if (pr.state === 'MERGED') {
      const done = this.store.patch(ticket.id, { pr, status: 'done' }, { kind: 'merged', message: `PR #${pr.number} merged` })
      await this.notify.prMerged(done)
      return
    }
    const qaLabel = this.config().github.qa.label.toLowerCase()
    const qaNew = Boolean(ticket.pr) && (pr.labels ?? []).some((l) => l.toLowerCase() === qaLabel) && !(ticket.pr?.labels ?? []).some((l) => l.toLowerCase() === qaLabel)
    // threads, reviewers and re-review requests: what reviewers are waiting on
    const conversation = pr.state === 'OPEN' ? await prConversation(worktree, pr.number).catch((e: unknown) => (log.warn(`${ticket.id}: review threads not read`, e), null)) : null
    if (conversation) this.noteReviewChanges(ticket, conversation)
    const updated = this.store.patch(
      ticket.id,
      { pr, ...(conversation ? { conversation } : {}) },
      fresh.length > 0 ? { kind: 'pr-comment', message: `${fresh.length} new comment(s) on PR #${pr.number}` } : undefined,
    )
    if (readyNow) this.onReady?.(updated)
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
    if (ciFlipped) {
      await this.onCiRed?.(ticket.id).catch((e: unknown) => log.warn(`${ticket.id}: CI check failed`, e))
      await this.notify.prCi(this.store.get(ticket.id) ?? updated)
    }
    if (qaNew) {
      this.store.journal(ticket.id, { kind: 'pr', title: `${this.config().github.qa.label} on the PR`, meta: { url: pr.url } })
      await this.notify.qaRequested(this.store.get(ticket.id) ?? updated)
    }
  }
}

export function formatComments(comments: readonly PrComment[]): string {
  return comments
    .map((c) => `- ${c.author}${c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ''}` : ''}: ${c.body.trim()}\n  (${c.url})`)
    .join('\n')
}

// The worktree follows the PR branch after GitHub merged main into it. Only a fast-forward: local
// commits that were never pushed stay put and are mentioned instead.
async function fastForward(worktree: string, branch: string, status: Ticket['status']): Promise<{ ok: boolean; text: string }> {
  if (status === 'running' || status === 'queued') return { ok: false, text: 'A lane is running; the worktree catches up on the next push.' }
  try {
    await git(['fetch', 'origin', branch], worktree)
    await git(['merge', '--ff-only', `origin/${branch}`], worktree)
    return { ok: true, text: 'The worktree was fast-forwarded to it.' }
  } catch {
    return { ok: false, text: 'The worktree has commits that are not on GitHub, so it was not fast-forwarded. Use Update from main on the ticket before the next push.' }
  }
}

// Likely to change in the next minutes, so worth a quicker look.
export function isHot(t: Ticket, now = Date.now()): boolean {
  if (t.lastPushAt && now - Date.parse(t.lastPushAt) < 30 * 60_000) return true
  if (t.githubUpdate) return true
  const pr = t.pr
  if (!pr || pr.state !== 'OPEN') return false
  return pr.ci === 'pending' || pr.mergeable === 'UNKNOWN'
}

// Who closed the PR, from its events; null when GitHub doesn't say.
async function closedBy(cwd: string, number: number): Promise<string | null> {
  const { stdout } = await sh('gh', ['api', `repos/{owner}/{repo}/issues/${number}/events`, '--paginate', '--jq', '[.[] | select(.event == "closed")] | last | .actor.login // ""'], cwd).catch(() => ({ stdout: '' }))
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean).at(-1) ?? null
}
