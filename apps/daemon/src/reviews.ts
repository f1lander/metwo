import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { PrReview, ReviewFinding, ReviewReport } from '@ticketflow/shared'
import type { Config } from './config.js'
import type { Linear } from './linear.js'
import { log } from './log.js'
import { commentableLines, ghLogin, postReview, repoSlug, type ReviewPr, reviewPr, searchPrs } from './runner/github.js'
import type { Runner } from './runner/index.js'
import { git, sh } from './runner/shell.js'
import { runGates } from './runner/supervise.js'
import type { Store } from './store.js'
import { knowledgePointers, reviewLenses } from './knowledge.js'

export interface ReviewNotifier {
  readonly requested: (review: PrReview) => Promise<void>
  readonly reviewed: (review: PrReview) => Promise<void>
  readonly failed: (review: PrReview) => Promise<void>
  readonly moved: (review: PrReview) => Promise<void>
  readonly progress: (id: string, kind: 'text' | 'tool' | 'stage', line: string) => void
}

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'

const OPEN_STATUSES: readonly PrReview['status'][] = ['new', 'queued', 'reviewed', 'posted', 'stopped', 'failed']

// PRs you are asked to review. Found on GitHub (review requests, @mentions) and in Linear mentions
// with a PR link, or added by hand (a link from Slack). A review checks the PR out read-only, runs
// install and the gates, lets the reviewer engine use the app, and drafts findings. You choose
// what gets posted, as one GitHub review under your name.
export class Reviews {
  private me = ''
  private slug = ''
  private current: { id: string; controller: AbortController } | null = null
  private readonly queue: string[] = []
  onResult: ((ok: boolean, detail: string) => void) | null = null

  constructor(
    private readonly cfg: Config,
    private readonly store: Store,
    private readonly runner: Runner,
    private readonly linear: Linear,
    private readonly notify: ReviewNotifier,
  ) {}

  private get cwd(): string {
    return this.cfg.repo.path
  }

  private flowDir(id: string): string {
    return path.join(this.cfg.repo.path, this.cfg.repo.worktreesDir, `${id}-flow`)
  }

  private async identity(): Promise<void> {
    if (!this.slug) this.slug = await repoSlug(this.cwd)
    if (!this.me) this.me = await ghLogin(this.cwd).catch(() => '')
  }

  // Our own tickets' PRs never show up as reviews.
  private ownNumbers(): Set<number> {
    const out = new Set<number>()
    for (const t of this.store.all()) {
      if (t.pr?.number) out.add(t.pr.number)
      const n = Number(/\/pull\/(\d+)/.exec(t.prUrl ?? '')?.[1])
      if (n) out.add(n)
    }
    return out
  }

  async tick(): Promise<void> {
    const r = this.cfg.github.reviews
    const notes: string[] = []
    try {
      await this.identity()
    } catch (error) {
      this.onResult?.(false, `gh: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const found = new Map<number, { source: PrReview['source']; note: string }>()
    const collect = async (label: string, fn: () => Promise<void>) => {
      try {
        await fn()
      } catch (error) {
        notes.push(`${label} failed`)
        log.warn(`reviews: ${label} failed`, error)
      }
    }
    if (r.requested) {
      await collect('review requests', async () => {
        for (const p of await searchPrs(this.cwd, this.slug, 'review-requested')) found.set(p.number, { source: 'requested', note: `review requested · ${p.author}` })
      })
    }
    if (r.mentions) {
      await collect('mentions', async () => {
        for (const p of await searchPrs(this.cwd, this.slug, 'mentions')) if (!found.has(p.number)) found.set(p.number, { source: 'mentioned', note: `mentioned you · ${p.author}` })
      })
    }
    if (r.linear) {
      await collect('Linear mentions', async () => {
        const prefix = `https://github.com/${this.slug}/pull/`.toLowerCase()
        for (const m of await this.linear.mentionedPrs()) {
          if (!m.url.toLowerCase().startsWith(prefix)) continue
          const n = Number(m.url.slice(prefix.length))
          if (n && !found.has(n)) found.set(n, { source: 'linear', note: `${m.by} in ${m.issue || 'Linear'}` })
        }
      })
    }
    const own = this.ownNumbers()
    for (const [number, how] of found) {
      if (own.has(number) || this.store.review(`PR-${number}`)) continue
      await collect(`PR #${number}`, async () => {
        const pr = await reviewPr(this.cwd, number)
        if (pr.state !== 'OPEN' || pr.author === this.me) return
        const review = this.create(pr, how.source, how.note)
        await this.notify.requested(review)
        if (r.auto) void this.start(review.id)
      })
    }
    await this.refresh()
    const open = this.store.reviews().filter((x) => OPEN_STATUSES.includes(x.status)).length
    this.onResult?.(notes.length === 0, [`${open} open review(s)`, ...notes].join(' · '))
  }

  // Follows the PRs already on the list: new commits make a report stale, merged or closed ends it.
  private async refresh(): Promise<void> {
    for (const r of this.store.reviews()) {
      if (!OPEN_STATUSES.includes(r.status) || r.status === 'queued' || this.current?.id === r.id) continue
      try {
        const pr = await reviewPr(this.cwd, r.number)
        if (pr.state !== 'OPEN') {
          this.store.patchReview(r.id, { status: 'closed' }, { kind: 'pr', title: `PR ${pr.state.toLowerCase()} on GitHub` })
          continue
        }
        const stale = Boolean(r.report && r.report.sha !== pr.headSha)
        const changed = r.headSha !== pr.headSha || r.title !== pr.title || r.isDraft !== pr.isDraft || Boolean(r.stale) !== stale
        if (!changed) continue
        const updated = this.store.patchReview(r.id, { title: pr.title, body: pr.body, headSha: pr.headSha, isDraft: pr.isDraft, stale }, stale && !r.stale ? { kind: 'pr', title: 'New commits since your review' } : undefined)
        if (stale && !r.stale) await this.notify.moved(updated)
      } catch (error) {
        log.warn(`${r.id}: refresh failed`, error)
      }
    }
  }

  private create(pr: ReviewPr, source: PrReview['source'], note: string): PrReview {
    const now = new Date().toISOString()
    return this.store.putReview({
      id: `PR-${pr.number}`,
      number: pr.number,
      repo: this.slug,
      url: pr.url,
      title: pr.title,
      author: pr.author,
      body: pr.body,
      head: pr.head,
      headSha: pr.headSha,
      base: pr.base,
      isDraft: pr.isDraft,
      source,
      sourceNote: note,
      requestedAt: now,
      updatedAt: now,
      status: 'new',
      journal: [{ at: now, kind: 'note', title: `On your list: ${note}` }],
    })
  }

  // A PR link (from Slack, anywhere) or a number.
  async add(input: string): Promise<PrReview> {
    await this.identity()
    const m = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/i.exec(input) ?? /^#?(\d+)$/.exec(input.trim())
    if (!m) throw new Error('send a PR link or number')
    const repo = m.length === 3 ? (m[1] as string) : this.slug
    if (repo.toLowerCase() !== this.slug.toLowerCase()) throw new Error(`metwo reviews PRs in ${this.slug}; that one is in ${repo}`)
    const number = Number(m.length === 3 ? m[2] : m[1])
    const existing = this.store.review(`PR-${number}`)
    if (existing && existing.status !== 'dismissed' && existing.status !== 'closed') return existing
    const pr = await reviewPr(this.cwd, number)
    if (pr.state !== 'OPEN') throw new Error(`PR #${number} is ${pr.state.toLowerCase()}`)
    return this.create(pr, 'manual', 'added by you')
  }

  dismiss(id: string): void {
    if (this.current?.id === id) this.current.controller.abort()
    this.store.patchReview(id, { status: 'dismissed' }, { kind: 'note', title: 'Dismissed' })
  }

  stop(id: string): void {
    const i = this.queue.indexOf(id)
    if (i >= 0) {
      this.queue.splice(i, 1)
      this.store.patchReview(id, { status: 'new' })
      return
    }
    if (this.current?.id !== id) throw new Error(`${id} is not being reviewed`)
    this.current.controller.abort()
  }

  get activeId(): string | null {
    return this.current?.id ?? null
  }

  // One review at a time: each runs install, the gates and a dev server.
  async start(id: string): Promise<void> {
    const r = this.store.review(id)
    if (!r) throw new Error(`unknown review ${id}`)
    if (this.current?.id === id || this.queue.includes(id)) return
    if (this.current) {
      this.queue.push(id)
      this.store.patchReview(id, { status: 'queued' })
      return
    }
    const controller = new AbortController()
    this.current = { id, controller }
    try {
      await this.run(id, controller.signal)
    } finally {
      this.current = null
      const next = this.queue.shift()
      if (next) void this.start(next)
    }
  }

  private async run(id: string, signal: AbortSignal): Promise<void> {
    const prev = this.store.review(id) as PrReview
    const say = (line: string) => this.notify.progress(id, 'stage', line)
    const wt = path.join(this.cfg.repo.path, this.cfg.repo.worktreesDir, id)
    const flow = this.flowDir(id)
    this.store.patchReview(id, { status: 'reviewing', error: '' }, { kind: 'run', title: prev.report ? 'Reviewing again' : 'Review started' })
    try {
      say('checking out the PR')
      const pr = await reviewPr(this.cwd, prev.number)
      await git(['fetch', 'origin', `pull/${pr.number}/head`, pr.base], this.cwd)
      if (existsSync(wt)) {
        await git(['checkout', '--detach', '--force', pr.headSha], wt)
      } else {
        await git(['worktree', 'add', '--detach', wt, pr.headSha], this.cwd)
      }
      mkdirSync(path.join(flow, 'logs'), { recursive: true })
      rmSync(path.join(flow, 'shots'), { recursive: true, force: true })
      rmSync(path.join(flow, 'REVIEW.json'), { force: true })
      const port = prev.port ?? this.store.allocatePort(this.cfg.pipeline.portBase)
      this.store.patchReview(id, { worktree: wt, port, title: pr.title, body: pr.body, headSha: pr.headSha, isDraft: pr.isDraft })
      const mergeBase = await git(['merge-base', 'HEAD', `origin/${pr.base}`], wt)
      writeFileSync(path.join(flow, 'pr.md'), await this.context(pr, prev))

      say(`installing (${this.cfg.repo.commands.install})`)
      let install: { ok: boolean; tail: string } = { ok: true, tail: '' }
      try {
        await sh('bash', ['-lc', this.cfg.repo.commands.install], wt, 15 * 60_000, signal)
      } catch (error) {
        const e = error as { stdout?: string; stderr?: string; message?: string }
        install = { ok: false, tail: `${e.stderr ?? e.message ?? ''}`.trim().split('\n').slice(-12).join('\n') }
      }
      if (signal.aborted) throw new Error('stopped')
      say('running the gates')
      const gates = install.ok ? await runGates(this.cfg, wt, signal) : [{ name: 'install', ok: false, tail: install.tail }]
      if (signal.aborted) throw new Error('stopped')

      const b = this.runner.budget()
      const ref = b.regulate && b.level === 'over' && b.fallback ? b.fallback : this.runner.config.roles.reviewer
      const role = this.runner.resolve(ref, null, this.cfg.models.review.model) ?? this.runner.resolve('claude', null, this.cfg.models.review.model)
      if (!role) throw new Error('no engine for reviews')
      say(`reviewing on ${role.engine.label}`)
      const result = await role.engine.run({
        cwd: wt,
        prompt: this.prompt(pr, wt, flow, port, mergeBase, gates),
        model: role.model,
        effort: this.runner.effort,
        logFile: path.join(flow, 'logs', 'review.jsonl'),
        onLine: (kind, line) => this.notify.progress(id, kind, line),
        signal,
      })
      if (signal.aborted) throw new Error('stopped')
      if (result.exitCode !== 0) throw new Error(`${role.engine.id} exited ${result.exitCode}: ${result.stderr.split('\n').at(-1) ?? ''}`)
      const diff = await git(['diff', `${mergeBase}...HEAD`], wt)
      const report = readReport(flow, commentableLines(diff), gates, role.ref, pr.headSha)
      const done = this.store.patchReview(
        id,
        { status: 'reviewed', report, stale: false },
        {
          kind: 'review',
          title: `Reviewed · ${report.verdict.replace('_', ' ')} · ${report.findings.length} finding(s)`,
          body: report.summary,
          meta: { model: `${result.model ?? role.model}/${this.runner.effort}`, ...(result.costUsd ? { cost: Number(result.costUsd.toFixed(2)) } : {}), ...(result.tokens ? { tokens: result.tokens } : {}) },
        },
      )
      say('review ready')
      await this.notify.reviewed(done)
    } catch (error) {
      if (signal.aborted) {
        if (this.store.review(id)?.status !== 'dismissed') this.store.patchReview(id, { status: 'stopped' }, { kind: 'note', title: 'Stopped by you' })
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      const failed = this.store.patchReview(id, { status: 'failed', error: message }, { kind: 'failure', title: 'Review failed', body: message })
      await this.notify.failed(failed)
    }
  }

  // pr.md: everything the reviewer should know besides the code.
  private async context(pr: ReviewPr, prev: PrReview): Promise<string> {
    const ref = /\b(?:Ref|Refs|Fixes|Closes)?:?\s*([A-Z]{2,10}-\d+)\b/.exec(`${pr.title}\n${pr.body}`)?.[1]
    let issue = ''
    if (ref) {
      try {
        const v = await this.linear.issueView(ref)
        issue = `## Linear issue ${v.id}: ${v.title}\n${v.url}\n\n${v.description}\n\n${v.comments
          .filter((c) => !c.bot)
          .map((c) => `- ${c.author}: ${c.body.replace(/\s+/g, ' ').slice(0, 500)}`)
          .join('\n')}`
      } catch {
        issue = `## Linear issue\n${ref} (could not be loaded)`
      }
    }
    const said = pr.comments
      .filter((c) => c.body.trim())
      .map((c) => `- ${c.author}${c.path ? ` on ${c.path}${c.line ? `:${c.line}` : ''}` : ''}: ${c.body.replace(/\s+/g, ' ').slice(0, 600)}`)
      .join('\n')
    const before = prev.report
      ? `## Your previous review (on ${prev.report.sha.slice(0, 8)})\nCheck which of these are now fixed; only repeat what still applies.\n${prev.report.findings.map((f) => `- [${f.severity}] ${f.file ? `${f.file}${f.line ? `:${f.line}` : ''} ` : ''}${f.title}`).join('\n')}`
      : ''
    const rules = this.runner.learnings?.rules().trim() ?? ''
    return [
      `# PR #${pr.number}: ${pr.title}`,
      `${pr.url} · by ${pr.author} · ${pr.head} → ${pr.base}${pr.isDraft ? ' · draft' : ''}`,
      '',
      '## Description',
      pr.body.trim() || '(empty)',
      issue,
      said ? `## Discussion so far (do not repeat these points)\n${said}` : '',
      before,
      rules ? `## Team learnings\n${rules}` : '',
      knowledgePointers(this.cfg) && `## Team knowledge\nStart from the index of each for the areas this PR touches:\n${knowledgePointers(this.cfg)}`,
      reviewLenses(this.cfg).length ? `## Review lenses\nApply these, in order:\n${reviewLenses(this.cfg).map((l, i) => `${i + 1}. ${l}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
  }

  private prompt(pr: ReviewPr, wt: string, flow: string, port: number, mergeBase: string, gates: readonly { name: string; ok: boolean; tail: string }[]): string {
    const c = this.cfg.repo.commands
    return `You are reviewing pull request #${pr.number} ("${pr.title}" by ${pr.author}) for the developer who was asked to review it. The PR is checked out, detached, in ${wt}.
Do NOT edit, commit or push anything, and do not comment on GitHub: the developer reads your findings and decides what to post.

Read first:
1. ${path.join(flow, 'pr.md')}: the description, the Linear issue, what reviewers already said${pr.comments.length ? ' (do not repeat it)' : ''}, your previous review if any.
2. The change: git diff ${mergeBase}...HEAD, and git log ${mergeBase}..HEAD for the commits.
3. The repo rules at the root: CLAUDE.md, AGENTS.md, STYLEGUIDE.md, REVIEW.md and .greptile/ when they exist.

metwo already ran install and the gates on this commit:
${gates.map((g) => `- ${g.name}: ${g.ok ? 'ok' : `FAILED\n${g.tail.split('\n').map((l) => `    ${l}`).join('\n')}`}`).join('\n')}

Then check the behaviour, not only the code:
- If the diff changes anything rendered, start the app (${c.dev} ${port}${c.storybook ? `, and Storybook with ${c.storybook} ${port + 1000} if stories changed` : ''}), go through the flows the PR and the issue describe with the Playwright MCP at 1440x900 and 390x844, and save screenshots to ${path.join(flow, 'shots')}/ as NN-<state>-<viewport>.png. Stop the servers when done.
- Look for: wrong behaviour against the issue, edge cases and empty/error/loading states, regressions in what the diff touches, missing or weak tests, security, accessibility, and breaks of the repo rules.

Write ${path.join(flow, 'REVIEW.json')} and nothing else:
{
  "verdict": "approve | comment | request_changes",
  "summary": "two or three sentences for the PR author: what you checked and the overall call",
  "findings": [{ "severity": "P0 | P1 | P2 | P3", "file": "path from the repo root", "line": 123, "title": "short", "body": "what is wrong, why it matters, what to do", "suggestion": "optional: replacement code for exactly that line" }],
  "checks": [{ "what": "flow or state you tried", "result": "pass | fail | not_checked", "shot": "file name in shots/", "note": "optional" }]
}
Write findings the way a helpful senior teammate would: specific, short, kind, one issue each. "line" is a line number in the new version of the file and must be inside the diff. P3 only for things worth the author's time. "request_changes" only for P0/P1; "approve" only when you would merge it as is.`
  }

  // The findings you picked, as one GitHub review under your name. Findings on lines inside the
  // diff become inline comments; the rest go in the review body.
  async post(id: string, input: { event: ReviewEvent; body: string; findings: readonly { id: string; body: string }[] }): Promise<PrReview> {
    const r = this.store.review(id)
    if (!r?.report) throw new Error(`${id} has no review to post`)
    const byId = new Map(r.report.findings.map((f) => [f.id, f]))
    const picked = input.findings.map((x) => ({ f: byId.get(x.id), body: x.body.trim() })).filter((x): x is { f: ReviewFinding; body: string } => Boolean(x.f && x.body))
    const inline = picked.filter((x) => x.f.inline && x.f.file && x.f.line)
    const loose = picked.filter((x) => !inline.includes(x))
    const body = [input.body.trim(), loose.length ? loose.map((x) => `- ${x.f.file ? `\`${x.f.file}${x.f.line ? `:${x.f.line}` : ''}\` ` : ''}${x.body}`).join('\n') : ''].filter(Boolean).join('\n\n')
    if (!body && inline.length === 0 && input.event !== 'APPROVE') throw new Error('nothing to post')
    const url = await postReview(this.cwd, r.number, {
      sha: r.report.sha,
      event: input.event,
      body,
      comments: inline.map((x) => ({ path: x.f.file as string, line: x.f.line as number, body: x.f.suggestion ? `${x.body}\n\n\`\`\`suggestion\n${x.f.suggestion}\n\`\`\`` : x.body })),
    })
    return this.store.patchReview(
      id,
      { status: 'posted', posted: { url, at: new Date().toISOString(), event: input.event, comments: inline.length } },
      { kind: 'comment', title: `Posted your review · ${input.event.toLowerCase().replace('_', ' ')} · ${inline.length} inline, ${loose.length} in the body`, body, meta: url ? { url } : {} },
    )
  }
}

function readReport(flow: string, lines: ReadonlyMap<string, ReadonlySet<number>>, gates: ReviewReport['gates'], engine: string, sha: string): ReviewReport {
  const file = path.join(flow, 'REVIEW.json')
  const base = { gates, engine, sha, at: new Date().toISOString() }
  if (!existsSync(file)) return { ...base, verdict: 'comment', summary: 'The reviewer did not write REVIEW.json; check the log.', findings: [], checks: [] }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<ReviewReport> & { findings?: Partial<ReviewFinding>[] }
    const findings = (Array.isArray(raw.findings) ? raw.findings : [])
      .filter((f) => f && typeof f.body === 'string')
      .map((f, i): ReviewFinding => {
        const fileName = typeof f.file === 'string' ? f.file.replace(/^\.?\//, '') : undefined
        const line = typeof f.line === 'number' ? f.line : undefined
        return {
          id: `f${i + 1}`,
          severity: typeof f.severity === 'string' ? f.severity : 'P2',
          title: typeof f.title === 'string' ? f.title : (f.body as string).split('\n')[0]?.slice(0, 80) ?? '',
          body: f.body as string,
          ...(fileName ? { file: fileName } : {}),
          ...(line ? { line } : {}),
          ...(typeof f.suggestion === 'string' && f.suggestion.trim() ? { suggestion: f.suggestion } : {}),
          inline: Boolean(fileName && line && lines.get(fileName)?.has(line)),
        }
      })
    const verdict = raw.verdict === 'approve' || raw.verdict === 'request_changes' ? raw.verdict : 'comment'
    const checks = (Array.isArray(raw.checks) ? raw.checks : []).filter((c) => c && typeof c.what === 'string').map((c) => ({ ...c, result: c.result === 'pass' || c.result === 'fail' ? c.result : ('not_checked' as const) }))
    return { ...base, verdict, summary: typeof raw.summary === 'string' ? raw.summary : '', findings, checks }
  } catch {
    return { ...base, verdict: 'comment', summary: 'REVIEW.json could not be read; check the log.', findings: [], checks: [] }
  }
}
