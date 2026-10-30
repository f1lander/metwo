import { createHash } from 'node:crypto'
import { type GreptileFinding, type GreptileReview, markdownSection, type PrComment, type PrInfo, type Ticket } from '@ticketflow/shared'
import { git, sh, shInput } from './shell.js'

export async function pushBranch(worktree: string, branch: string): Promise<void> {
  await git(['push', '-u', 'origin', branch], worktree)
}

// Draft PR via the operator's own gh auth, so it is authored by them.
export async function openDraftPr(worktree: string, ticket: Ticket, baseBranch: string, body: string): Promise<string> {
  const { stdout } = await sh(
    'gh',
    ['pr', 'create', '--draft', '--base', baseBranch, '--head', ticket.branch, '--title', `${ticket.id}: ${ticket.title}`, '--body', body],
    worktree,
  )
  const url = stdout.split('\n').find((l) => l.startsWith('https://'))
  if (!url) throw new Error(`gh pr create returned no URL:\n${stdout}`)
  return url
}

export async function markPrReady(worktree: string, branch: string): Promise<void> {
  await sh('gh', ['pr', 'ready', branch], worktree)
}

// Returns the comment's URL (gh prints it).
export async function commentOnPr(worktree: string, branch: string, body: string): Promise<string> {
  const { stdout } = await sh('gh', ['pr', 'comment', branch, '--body', body], worktree)
  return stdout.split('\n').find((l) => l.startsWith('https://')) ?? ''
}

// A reply inside a review thread on a line of code.
export async function replyToReviewComment(worktree: string, prNumber: number, commentId: string, body: string): Promise<void> {
  await sh('gh', ['api', '-X', 'POST', `repos/{owner}/{repo}/pulls/${prNumber}/comments/${commentId}/replies`, '-f', `body=${body}`], worktree)
}

export async function existingPrUrl(worktree: string, branch: string): Promise<string | null> {
  try {
    const { stdout } = await sh('gh', ['pr', 'view', branch, '--json', 'url', '--jq', '.url'], worktree)
    return stdout || null
  } catch {
    return null
  }
}

interface GhPrView {
  readonly number: number
  readonly url: string
  readonly state: 'OPEN' | 'MERGED' | 'CLOSED'
  readonly isDraft: boolean
  readonly body: string
  readonly labels?: readonly { readonly name: string }[]
  readonly headRefName: string
  readonly headRefOid: string
  readonly reviewDecision: string
  readonly statusCheckRollup: readonly { readonly conclusion?: string; readonly status?: string; readonly state?: string }[]
  readonly comments: readonly { readonly id: string; readonly author: { readonly login: string; readonly is_bot?: boolean }; readonly body: string; readonly url: string; readonly createdAt: string }[]
  readonly reviews: readonly { readonly id: string; readonly author: { readonly login: string }; readonly body: string; readonly url: string; readonly submittedAt: string; readonly state: string }[]
}

interface GhInlineComment {
  readonly id: number
  readonly in_reply_to_id?: number
  readonly user: { readonly login: string; readonly type?: string }
  readonly body: string
  readonly path: string
  readonly line: number | null
  readonly html_url: string
  readonly created_at: string
}

// Everything through the operator's own gh auth. {owner}/{repo} placeholders resolve from the
// worktree's remote, so no repo config is needed.
export async function fetchPrInfo(worktree: string, branch: string, greptileBot = 'greptile-apps[bot]'): Promise<PrInfo | null> {
  let view: GhPrView
  try {
    const { stdout } = await sh(
      'gh',
      ['pr', 'view', branch, '--json', 'number,url,state,isDraft,reviewDecision,statusCheckRollup,comments,reviews,body,headRefName,headRefOid,labels'],
      worktree,
    )
    view = JSON.parse(stdout) as GhPrView
  } catch {
    return null
  }
  const { stdout: inlineJson } = await sh('gh', ['api', `repos/{owner}/{repo}/pulls/${view.number}/comments`, '--paginate'], worktree)
  const inline = JSON.parse(inlineJson) as readonly GhInlineComment[]

  const comments: PrComment[] = [
    ...view.comments.map((c) => ({ id: `issue-${c.id}`, kind: 'issue' as const, author: c.author.login, body: c.body, url: c.url, createdAt: c.createdAt, bot: c.author.is_bot === true || c.author.login.endsWith('[bot]') })),
    ...view.reviews
      .filter((r) => r.body.trim())
      .map((r) => ({ id: `review-${r.id}`, kind: 'review' as const, author: r.author.login, body: `[${r.state}] ${r.body}`, url: r.url, createdAt: r.submittedAt })),
    ...inline.map((c) => ({
      id: `inline-${c.id}`,
      kind: 'inline' as const,
      author: c.user.login,
      bot: c.user.type === 'Bot' || c.user.login.endsWith('[bot]'),
      body: c.body,
      path: c.path,
      ...(c.line !== null ? { line: c.line } : {}),
      url: c.html_url,
      createdAt: c.created_at,
    })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  const greptile = parseGreptile(view.comments, inline, greptileBot)
  return {
    ...(greptile ? { greptile } : {}),
    number: view.number,
    url: view.url,
    body: view.body,
    head: view.headRefName,
    headSha: view.headRefOid,
    labels: (view.labels ?? []).map((l) => l.name),
    state: view.state,
    isDraft: view.isDraft,
    ci: rollupToCi(view.statusCheckRollup),
    reviewDecision: view.reviewDecision || 'none',
    comments,
    syncedAt: new Date().toISOString(),
  }
}

function rollupToCi(rollup: GhPrView['statusCheckRollup']): PrInfo['ci'] {
  if (!rollup || rollup.length === 0) return 'none'
  const states = rollup.map((r) => (r.conclusion ?? r.state ?? r.status ?? '').toUpperCase())
  if (states.some((s) => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED'].includes(s))) return 'failure'
  if (states.some((s) => ['PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED', ''].includes(s))) return 'pending'
  return 'success'
}

export async function ghLogin(cwd: string): Promise<string> {
  const { stdout } = await sh('gh', ['api', 'user', '--jq', '.login'], cwd)
  return stdout
}

const SHOTS_MARK = '<!-- screenshots -->'

// The lane's PR-BODY.md when it wrote one, else the same structure built from ARM-SUMMARY.md.
// Screenshots replace the marker; the Ref line is always last.
export interface PrMedia {
  readonly name: string
  readonly url: string
  readonly kind?: 'image' | 'video'
}

// The lane's PR-BODY.md when it wrote one, else the same structure built from ARM-SUMMARY.md.
// Media replaces the marker; 'pending' keeps the marker so the media can be added once the PR
// exists (browser uploads need the PR page). The Ref line is always last.
export function buildPrBody(ticket: Ticket, summary: string, laneBody: string | null, media: readonly PrMedia[] | 'pending'): string {
  let body = laneBody?.trim() || fallbackBody(ticket, summary)
  const block = media === 'pending' ? SHOTS_MARK : mediaBlock(media)
  if (body.includes(SHOTS_MARK)) {
    body = block
      ? body.replace(SHOTS_MARK, block)
      : body.replace(/\n*## Screenshots(?: \/ Video)?\s*\n+<!-- screenshots -->\s*/, '\n\n').replace(SHOTS_MARK, '')
  } else if (block) {
    body = body.replace(/\n*Ref: [A-Z]+-\d+\s*$/, '') + `\n\n## Screenshots / Video\n\n${block}`
  }
  body = body.replace(/\n*Ref: [A-Z]+-\d+\s*$/, '').trim()
  return `${body}\n\nRef: ${ticket.id}`
}

// before/after pairs (same name once "before"/"after" is taken out) become a two-column
// table; the rest of the images follow, then the videos.
export function mediaBlock(media: readonly PrMedia[]): string {
  const images = media.filter((m) => m.kind !== 'video')
  const videos = media.filter((m) => m.kind === 'video')
  const key = (name: string) => name.replace(/\.[a-z0-9]+$/i, '').replace(/(^|[-_])(before|after)(?=[-_]|$)/i, '$1').replace(/^\d+[-_]/, '').replace(/[-_]+/g, ' ').trim()
  const side = (name: string) => (/(^|[-_])before([-_]|\.|$)/i.test(name) ? 'before' : /(^|[-_])after([-_]|\.|$)/i.test(name) ? 'after' : null)
  const pairs = new Map<string, { before?: PrMedia; after?: PrMedia }>()
  for (const m of images) {
    const s = side(m.name)
    if (!s) continue
    const k = key(m.name)
    pairs.set(k, { ...pairs.get(k), [s]: m })
  }
  const paired = [...pairs.entries()].filter(([, p]) => p.before && p.after)
  const used = new Set(paired.flatMap(([, p]) => [p.before?.name, p.after?.name]))
  const img = (m: PrMedia, width: number) => `<img src="${m.url}" width="${width}" alt="${prettyShot(m.name)}">`
  const parts: string[] = []
  if (paired.length > 0) {
    parts.push(['| | Before | After |', '|---|---|---|', ...paired.map(([k, p]) => `| ${k} | ${img(p.before as PrMedia, 360)} | ${img(p.after as PrMedia, 360)} |`)].join('\n'))
  }
  for (const m of images.filter((m) => !used.has(m.name))) parts.push(`**${prettyShot(m.name)}**\n\n${img(m, 720)}`)
  for (const v of videos) parts.push(`**${prettyShot(v.name)}**\n\n${v.url}`)
  return parts.join('\n\n')
}

export async function livePrBody(worktree: string, branch: string): Promise<{ body: string; url: string }> {
  const { stdout } = await sh('gh', ['pr', 'view', branch, '--json', 'body,url'], worktree)
  return JSON.parse(stdout) as { body: string; url: string }
}

export async function editPrBody(worktree: string, branch: string, body: string): Promise<void> {
  await sh('gh', ['pr', 'edit', branch, '--body', body], worktree)
}

// After `gh pr ready`: request GitHub's suggested reviewers (minus you and anyone already
// requested), up to `max`. Returns who was added.
export async function requestSuggestedReviewers(worktree: string, branch: string, max: number): Promise<readonly string[]> {
  const { stdout: repoJson } = await sh('gh', ['repo', 'view', '--json', 'owner,name'], worktree)
  const repo = JSON.parse(repoJson) as { owner: { login: string }; name: string }
  const { stdout: numberOut } = await sh('gh', ['pr', 'view', branch, '--json', 'number', '--jq', '.number'], worktree)
  const query = `query($o: String!, $r: String!, $n: Int!) {
    viewer { login }
    repository(owner: $o, name: $r) { pullRequest(number: $n) {
      suggestedReviewers { isAuthor reviewer { login } }
      reviewRequests(first: 30) { nodes { requestedReviewer { ... on User { login } } } }
    } }
  }`
  const { stdout } = await sh('gh', ['api', 'graphql', '-f', `query=${query}`, '-f', `o=${repo.owner.login}`, '-f', `r=${repo.name}`, '-F', `n=${numberOut.trim()}`], worktree)
  const data = JSON.parse(stdout) as {
    data: {
      viewer: { login: string }
      repository: { pullRequest: { suggestedReviewers: { isAuthor: boolean; reviewer: { login: string } }[]; reviewRequests: { nodes: { requestedReviewer: { login?: string } | null }[] } } }
    }
  }
  const pr = data.data.repository.pullRequest
  const already = new Set(pr.reviewRequests.nodes.map((n) => n.requestedReviewer?.login).filter(Boolean))
  const pick = pr.suggestedReviewers
    .filter((s) => !s.isAuthor && s.reviewer.login !== data.data.viewer.login && !already.has(s.reviewer.login))
    .map((s) => s.reviewer.login)
    .slice(0, max)
  if (pick.length > 0) await sh('gh', ['pr', 'edit', branch, '--add-reviewer', pick.join(',')], worktree)
  return pick
}

function fallbackBody(ticket: Ticket, summary: string): string {
  const part = (h: string) => markdownSection(summary, h)
  const one = (text: string) => collapse(text).slice(0, 400)
  return [
    `## Summary\n${one(part('What changed and why') || ticket.title)}\n\nTicket: [${ticket.id}](${ticket.url})`,
    part('Files touched') && `## Review Guide\n${part('Files touched').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 5).map((l) => (l.startsWith('-') ? l : `- ${l}`)).join('\n')}`,
    `## Screenshots / Video\n${SHOTS_MARK}\n\n**Preview:** <!-- preview -->`,
    `## Verification\n**Tested by:** AI\n**Known gaps:** ${one(part('Known risks') || 'none noted')}`,
    part('Files touched') && `## Regression\n**Modified:**\n${part('Files touched').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 8).map((l) => (l.startsWith('-') ? l : `- ${l}`)).join('\n')}\n\n${part('Regression check') ? `**Checked:** ${one(part('Regression check'))}` : '**Could be affected:** not assessed; check the callers of the files above'}`,
    part('Needs manual test') && `## Human Testing Required\n${one(part('Needs manual test'))}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function previewUrl(comments: readonly { body: string }[]): string | null {
  return previewDeploy(comments)?.url ?? null
}

// The newest preview deploy a bot reported (Cloudflare Pages / Workers comments): its URL and commit.
export function previewDeploy(comments: readonly { body: string }[]): { url: string; sha: string | null } | null {
  for (const c of [...comments].reverse()) {
    const url = /(?<!Branch\s)Preview URL[\s\S]{0,200}?(https:\/\/[^\s<)|`'"]+)/i.exec(c.body)?.[1] ?? /Preview URL:\s*(https:\/\/[^\s<)]+)/i.exec(c.body)?.[1]
    if (!url) continue
    const sha = /(?:Latest commit|Commit)[\s\S]{0,80}?\b([0-9a-f]{7,40})\b/i.exec(c.body)?.[1] ?? null
    return { url, sha }
  }
  return null
}

export function prettyShot(file: string): string {
  return file.replace(/\.[a-z]+$/i, '').replace(/^\d+[-_]/, '').replace(/[-_]+/g, ' ')
}


function collapse(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim()
}

const sameBot = (login: string, bot: string) => login.replace(/\[bot\]$/, '') === bot.replace(/\[bot\]$/, '')

// Reads Greptile's summary comment: the confidence score, the impact line and the numbered
// findings, each with the agent prompt Greptile writes for it and the inline comment it links.
function parseGreptile(
  comments: GhPrView['comments'],
  inline: readonly GhInlineComment[],
  bot: string,
): GreptileReview | null {
  const summary = [...comments].reverse().find((c) => sameBot(c.author.login, bot) && c.body.includes('greptile_summary'))
  if (!summary) return null
  const body = summary.body
  const score = /Confidence Score:\s*(\d)\s*\/\s*5/i.exec(body)
  const impact = /\*\*\[([^\]]+)\]\*\*/.exec(body)
  const byId = new Map(inline.map((c) => [String(c.id), c]))

  const heads = [...body.matchAll(/^\d+\.\s+(?:<img[^>]*alt="(P\d)"[^>]*>)?(?:&nbsp;|\s)*\*\*(.+?)\*\*(.*)$/gm)]
  const findings: GreptileFinding[] = heads.map((m, i) => {
    const start = (m.index ?? 0) + m[0].length
    const end = heads[i + 1]?.index ?? body.length
    const chunk = body.slice(start, end)
    const fenced = /(`{3,})(?:markdown)?\n([\s\S]*?)\n\1(?!`)/.exec(chunk)?.[2] ?? chunk.replace(/<[^>]+>/g, '')
    const lines = fenced.split('\n')
    const loc = lines.map((l) => /^([\w./@\-[\]$]+\.[a-z]+):(\d+)(?:-\d+)?$/i.exec(l.trim())).find(Boolean)
    const text = lines
      .filter((l) => !/^### Issue \d+/.test(l) && !(loc && l.trim() === loc[0]))
      .join('\n')
      .split(/\n---\n/)[0]
      ?.replace(/\n*Note: If this suggestion[\s\S]*$/, '')
      .trim() ?? ''
    const link = /#discussion_r(\d+)/.exec(m[3] ?? '')?.[1]
    const ic = link ? byId.get(link) : undefined
    const path = ic?.path ?? loc?.[1]
    const line = ic?.line ?? (loc?.[2] ? Number(loc[2]) : undefined)
    return {
      level: m[1] ?? null,
      title: (m[2] ?? '').trim(),
      body: text,
      ...(path ? { path } : {}),
      ...(line ? { line } : {}),
      ...(ic ? { url: ic.html_url } : {}),
    }
  })

  return {
    key: createHash('sha1').update(body).digest('hex').slice(0, 12),
    score: score ? Number(score[1]) : null,
    impact: impact?.[1] ?? null,
    findings,
    url: summary.url,
    at: summary.createdAt,
  }
}

// --- PRs you review -------------------------------------------------------------------------

export async function repoSlug(cwd: string): Promise<string> {
  return (await sh('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], cwd)).stdout
}

// Open PRs in this repo where a review is requested from you, or that mention you.
export async function searchPrs(cwd: string, repo: string, filter: 'review-requested' | 'mentions'): Promise<readonly { number: number; title: string; url: string; author: string; updatedAt: string }[]> {
  const { stdout } = await sh('gh', ['search', 'prs', `--${filter}=@me`, '--state=open', `--repo=${repo}`, '--json', 'number,title,url,author,updatedAt', '--limit', '30'], cwd)
  const rows = JSON.parse(stdout || '[]') as { number: number; title: string; url: string; author: { login: string }; updatedAt: string }[]
  return rows.map((r) => ({ number: r.number, title: r.title, url: r.url, author: r.author.login, updatedAt: r.updatedAt }))
}

export interface ReviewPr {
  readonly number: number
  readonly url: string
  readonly title: string
  readonly body: string
  readonly author: string
  readonly head: string
  readonly headSha: string
  readonly base: string
  readonly isDraft: boolean
  readonly state: 'OPEN' | 'MERGED' | 'CLOSED'
  readonly comments: readonly { readonly author: string; readonly body: string; readonly path?: string; readonly line?: number }[]
}

export async function reviewPr(cwd: string, number: number): Promise<ReviewPr> {
  const { stdout } = await sh('gh', ['pr', 'view', String(number), '--json', 'number,url,title,body,author,headRefName,headRefOid,baseRefName,isDraft,state,comments,reviews'], cwd)
  const v = JSON.parse(stdout) as {
    number: number
    url: string
    title: string
    body: string
    author: { login: string }
    headRefName: string
    headRefOid: string
    baseRefName: string
    isDraft: boolean
    state: ReviewPr['state']
    comments: { author: { login: string }; body: string }[]
    reviews: { author: { login: string }; body: string }[]
  }
  const inline = await sh('gh', ['api', `repos/{owner}/{repo}/pulls/${number}/comments`, '--paginate'], cwd)
    .then((r) => JSON.parse(r.stdout || '[]') as GhInlineComment[])
    .catch(() => [] as GhInlineComment[])
  return {
    number: v.number,
    url: v.url,
    title: v.title,
    body: v.body,
    author: v.author.login,
    head: v.headRefName,
    headSha: v.headRefOid,
    base: v.baseRefName,
    isDraft: v.isDraft,
    state: v.state,
    comments: [
      ...v.comments.map((c) => ({ author: c.author.login, body: c.body })),
      ...v.reviews.filter((r) => r.body.trim()).map((r) => ({ author: r.author.login, body: r.body })),
      ...inline.map((c) => ({ author: c.user.login, body: c.body, path: c.path, ...(c.line !== null ? { line: c.line } : {}) })),
    ],
  }
}

// Lines of the new side GitHub accepts inline comments on: every line inside a diff hunk.
export function commentableLines(diff: string): ReadonlyMap<string, ReadonlySet<number>> {
  const out = new Map<string, Set<number>>()
  let file: string | null = null
  let line = 0
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.startsWith('+++ b/') ? raw.slice(6) : null
      continue
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw)
    if (hunk) {
      line = Number(hunk[1])
      continue
    }
    if (!file || raw.startsWith('--- ') || raw.startsWith('diff ') || raw.startsWith('\\')) continue
    if (raw.startsWith('-')) continue
    if (raw.startsWith('+') || raw.startsWith(' ')) {
      const set = out.get(file) ?? new Set<number>()
      set.add(line)
      out.set(file, set)
      line++
    }
  }
  return out
}

// One GitHub review: a body plus inline comments, as you, on the commit that was reviewed.
export async function postReview(
  cwd: string,
  number: number,
  review: { sha: string; event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'; body: string; comments: readonly { path: string; line: number; body: string }[] },
): Promise<string> {
  const payload = JSON.stringify({ commit_id: review.sha, event: review.event, body: review.body, comments: review.comments.map((c) => ({ ...c, side: 'RIGHT' })) })
  const { stdout } = await shInput('gh', ['api', '-X', 'POST', `repos/{owner}/{repo}/pulls/${number}/reviews`, '--input', '-'], cwd, payload)
  return (JSON.parse(stdout) as { html_url?: string }).html_url ?? ''
}
