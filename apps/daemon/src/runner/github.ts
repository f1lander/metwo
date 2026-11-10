import { createHash } from 'node:crypto'
import { type GreptileFinding, type GreptileReview, isBotComment, markdownSection, type PrComment, type PrConversation, type PrInfo, type PrMeta, type PrReviewerState, type Ticket } from '@ticketflow/shared'
import { sizeLine } from './quality.js'
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
  readonly author?: { readonly login: string }
  readonly headRefName: string
  readonly headRefOid: string
  readonly reviewDecision: string
  readonly mergeable?: string
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
      ['pr', 'view', branch, '--json', 'number,url,state,isDraft,reviewDecision,statusCheckRollup,comments,reviews,body,headRefName,headRefOid,labels,author,mergeable'],
      worktree,
    )
    view = JSON.parse(stdout) as GhPrView
  } catch {
    return null
  }
  const { stdout: inlineJson } = await sh('gh', ['api', `repos/{owner}/{repo}/pulls/${view.number}/comments`, '--paginate'], worktree)
  const inline = JSON.parse(inlineJson) as readonly GhInlineComment[]

  const comments: PrComment[] = [
    ...view.comments.map((c) => ({ id: `issue-${c.id}`, kind: 'issue' as const, author: c.author.login, body: c.body, url: c.url, createdAt: c.createdAt, bot: c.author.is_bot === true || isBotComment({ author: c.author.login, body: c.body }) })),
    ...view.reviews
      .filter((r) => r.body.trim())
      .map((r) => ({ id: `review-${r.id}`, kind: 'review' as const, author: r.author.login, body: `[${r.state}] ${r.body}`, url: r.url, createdAt: r.submittedAt })),
    ...inline.map((c) => ({
      id: `inline-${c.id}`,
      kind: 'inline' as const,
      author: c.user.login,
      bot: c.user.type === 'Bot' || isBotComment({ author: c.user.login, body: c.body }),
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
    ...(view.author?.login ? { author: view.author.login } : {}),
    state: view.state,
    isDraft: view.isDraft,
    ...(view.mergeable === 'MERGEABLE' || view.mergeable === 'CONFLICTING' || view.mergeable === 'UNKNOWN' ? { mergeable: view.mergeable } : {}),
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
// where the list of the PR's stories on the Storybook preview goes (filled once the preview deploys)
export const STORIES_MARK = '<!-- stories -->'

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
    body = body.replace(/\n*(?:Ref:|Fixes) [A-Z]+-\d+\s*$/, '') + `\n\n## Screenshots / Video\n\n${block}`
  }
  body = body.replace(/\n*(?:Ref:|Fixes) [A-Z]+-\d+\s*$/, '').trim()
  // the size, so a reviewer knows what they are in for
  if (ticket.size && !/^- \*\*Size:\*\*/m.test(body)) {
    const line = `- **Size:** ${sizeLine(ticket.size)}`
    body = /^## Review Guide\s*$/m.test(body) ? body.replace(/^(## Review Guide\s*\n)/m, `$1${line}\n`) : `${body}\n\n${line}`
  }
  // Fixes, not Ref: Linear only moves the issue (In Review, Done on merge) on a closing keyword
  return `${body}\n\nFixes ${ticket.id}`
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
  // thumbnails only; the link is the stable github.com/user-attachments URL, which GitHub turns
  // into a fresh signed image link on click (the img's own private-user-images link expires)
  const img = (m: PrMedia, width: number) => `<a href="${m.url}"><img src="${m.url}" width="${width}" alt="${prettyShot(m.name)}"></a>`
  const parts: string[] = []
  if (paired.length > 0) {
    parts.push(['| | Before | After |', '|---|---|---|', ...paired.map(([k, p]) => `| ${k} | ${img(p.before as PrMedia, 240)} | ${img(p.after as PrMedia, 240)} |`)].join('\n'))
  }
  const rest = images.filter((m) => !used.has(m.name))
  if (rest.length > 0) {
    const cells = rest.map((m) => `<td valign="top">${img(m, 180)}<br><sub>${prettyShot(m.name)}</sub></td>`)
    const rows: string[] = []
    for (let i = 0; i < cells.length; i += 4) rows.push(`<tr>${cells.slice(i, i + 4).join('')}</tr>`)
    parts.push(`<table>${rows.join('')}</table>`)
  }
  if (images.length > 0) parts.push('<sub>Click a screenshot for full size.</sub>')
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
    `## Screenshots / Video\n${SHOTS_MARK}\n\n**Preview:** <!-- preview -->\n\n${STORIES_MARK}`,
    `## Verification\n**Tested by:** AI\n**Known gaps:** ${one(part('Known risks') || 'none noted')}`,
    part('Files touched') && `## Regression\n**Modified:**\n${part('Files touched').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 8).map((l) => (l.startsWith('-') ? l : `- ${l}`)).join('\n')}\n\n${part('Regression check') ? `**Checked:** ${one(part('Regression check'))}` : '**Could be affected:** not assessed; check the callers of the files above'}`,
    part('Needs manual test') && `## Human Testing Required\n${one(part('Needs manual test'))}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function previewUrl(comments: readonly PreviewComment[]): string | null {
  return previewDeploy(comments)?.url ?? null
}

type PreviewComment = Pick<PrComment, 'body' | 'author'> & { readonly bot?: boolean | undefined }
// only deploy bots may name the preview (anyone can comment "Preview URL: …" on a PR)
const DEPLOY_BOTS = /^(cloudflare-workers-and-pages|cloudflare-pages|vercel|netlify|github-actions)(\[bot\])?$/i
const PREVIEW_HOSTS = /\.(pages\.dev|workers\.dev|vercel\.app|netlify\.app)$/i

// The newest preview deploy a bot reported (Cloudflare Pages / Workers comments): its URL and commit.
export function previewDeploy(comments: readonly PreviewComment[]): { url: string; sha: string | null } | null {
  for (const c of [...comments].reverse()) {
    if (!DEPLOY_BOTS.test(c.author)) continue
    const url = /(?<!Branch\s)Preview URL[\s\S]{0,200}?(https:\/\/[^\s<)|`'"]+)/i.exec(c.body)?.[1] ?? /Preview URL:\s*(https:\/\/[^\s<)]+)/i.exec(c.body)?.[1]
    if (!url) continue
    try {
      if (!PREVIEW_HOSTS.test(new URL(url).hostname)) continue
    } catch {
      continue
    }
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

// GitHub's "Update branch": merges the base into the PR branch on GitHub. expected_head_sha makes it
// refuse when the branch moved since we last looked.
export async function updateBranchOnGithub(cwd: string, prNumber: number, headSha: string | null): Promise<'updated' | 'current' | 'conflicts' | 'moved'> {
  try {
    await sh('gh', ['api', '-X', 'PUT', `repos/{owner}/{repo}/pulls/${prNumber}/update-branch`, ...(headSha ? ['-f', `expected_head_sha=${headSha}`] : [])], cwd, 60_000)
    return 'updated'
  } catch (error) {
    const text = `${(error as { stderr?: string }).stderr ?? ''} ${error instanceof Error ? error.message : ''}`
    if (/merge conflict/i.test(text)) return 'conflicts'
    if (/no new commits|up[- ]to[- ]date/i.test(text)) return 'current'
    if (/expected_head_sha|head sha/i.test(text)) return 'moved'
    throw error
  }
}

// Open, ready-for-review PRs in the repo, newest first (drafts left out).
export async function listOpenPrs(cwd: string): Promise<readonly { number: number; title: string; url: string; author: string; updatedAt: string; head: string; labels: string[]; additions: number; deletions: number; files: number; reviewDecision: string; requestedFrom: string[] }[]> {
  const { stdout } = await sh('gh', ['pr', 'list', '--state', 'open', '--search', 'draft:false sort:updated-desc', '--limit', '80', '--json', 'number,title,url,author,updatedAt,headRefName,labels,additions,deletions,changedFiles,reviewDecision,reviewRequests'], cwd)
  const rows = JSON.parse(stdout || '[]') as { number: number; title: string; url: string; author: { login: string }; updatedAt: string; headRefName: string; labels?: { name: string }[]; additions?: number; deletions?: number; changedFiles?: number; reviewDecision?: string; reviewRequests?: { login?: string }[] }[]
  return rows.map((r) => ({
    number: r.number,
    title: r.title,
    url: r.url,
    author: r.author.login,
    updatedAt: r.updatedAt,
    head: r.headRefName,
    labels: (r.labels ?? []).map((l) => l.name),
    additions: r.additions ?? 0,
    deletions: r.deletions ?? 0,
    files: r.changedFiles ?? 0,
    reviewDecision: r.reviewDecision ?? '',
    requestedFrom: (r.reviewRequests ?? []).flatMap((x) => (x.login ? [x.login] : [])),
  }))
}

export async function prMeta(cwd: string, number: number): Promise<PrMeta> {
  const { stdout } = await sh('gh', ['pr', 'view', String(number), '--json', 'number,title,url,state,isDraft,author,createdAt,updatedAt,mergedAt,headRefName,baseRefName,additions,deletions,changedFiles,commits,labels,assignees,latestReviews,reviewRequests,mergeable,statusCheckRollup,milestone'], cwd)
  const v = JSON.parse(stdout) as {
    number: number; title: string; url: string; state: PrMeta['state']; isDraft: boolean; author: { login: string }; createdAt: string; updatedAt: string; mergedAt: string | null
    headRefName: string; baseRefName: string; additions: number; deletions: number; changedFiles: number; commits?: unknown[]
    labels?: { name: string }[]; assignees?: { login: string }[]; latestReviews?: { author: { login: string }; state: string }[]; reviewRequests?: { login?: string; name?: string }[]
    mergeable?: string; statusCheckRollup?: { conclusion?: string | null; state?: string | null; status?: string | null }[]; milestone?: { title: string } | null
  }
  const reviewers: PrMeta['reviewers'][number][] = []
  for (const r of v.latestReviews ?? []) {
    if (r.author.login === v.author.login) continue
    const state = (['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'].includes(r.state) ? r.state : 'COMMENTED') as PrMeta['reviewers'][number]['state']
    reviewers.push({ login: r.author.login, state })
  }
  for (const q of v.reviewRequests ?? []) {
    const login = q.login ?? q.name
    if (login && !reviewers.some((r) => r.login === login)) reviewers.push({ login, state: 'PENDING' })
  }
  const checks = { passed: 0, failed: 0, pending: 0 }
  for (const c of v.statusCheckRollup ?? []) {
    const s = (c.conclusion ?? c.state ?? c.status ?? '').toUpperCase()
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(s)) checks.passed++
    else if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(s)) checks.failed++
    else checks.pending++
  }
  return {
    number: v.number,
    title: v.title,
    url: v.url,
    state: v.state,
    isDraft: v.isDraft,
    author: v.author.login,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    mergedAt: v.mergedAt ?? null,
    head: v.headRefName,
    base: v.baseRefName,
    additions: v.additions ?? 0,
    deletions: v.deletions ?? 0,
    files: v.changedFiles ?? 0,
    commits: v.commits?.length ?? 0,
    labels: (v.labels ?? []).map((l) => l.name),
    assignees: (v.assignees ?? []).map((a) => a.login),
    reviewers,
    mergeable: v.mergeable ?? 'UNKNOWN',
    checks,
    milestone: v.milestone?.title ?? null,
  }
}

// PRs merged in the repo since a date, with who wrote and who reviewed each (bots left out).
export async function mergedSince(cwd: string, since: string): Promise<readonly { author: string; lines: number; reviewers: string[] }[]> {
  const { stdout } = await sh('gh', ['pr', 'list', '--state', 'merged', '--search', `merged:>=${since.slice(0, 10)}`, '--limit', '300', '--json', 'author,additions,deletions,reviews'], cwd, 60_000)
  const rows = JSON.parse(stdout || '[]') as { author: { login: string; is_bot?: boolean }; additions?: number; deletions?: number; reviews?: { author: { login: string } }[] }[]
  const bot = (l: string) => /\[bot\]$|^dependabot|^renovate|^github-actions/i.test(l)
  return rows
    .filter((r) => !r.author.is_bot && !bot(r.author.login))
    .map((r) => ({ author: r.author.login, lines: (r.additions ?? 0) + (r.deletions ?? 0), reviewers: [...new Set((r.reviews ?? []).map((x) => x.author.login).filter((l) => l !== r.author.login && !bot(l)))] }))
}

const CONVERSATION = `query($o: String!, $r: String!, $n: Int!) {
  repository(owner: $o, name: $r) {
    pullRequest(number: $n) {
      author { login }
      headRefOid
      commits(last: 1) { nodes { commit { committedDate } } }
      reviewThreads(first: 100) { nodes { id isResolved isOutdated path line originalLine comments(first: 30) { nodes { databaseId author { login } body createdAt url } } } }
      latestOpinionatedReviews(first: 50) { nodes { author { login } state submittedAt commit { oid } } }
      latestReviews(first: 50) { nodes { author { login } state submittedAt commit { oid } } }
      reviewRequests(first: 30) { nodes { requestedReviewer { ... on User { login } } } }
    }
  }
}`

interface ConvNode {
  author: { login: string } | null
  headRefOid: string
  commits: { nodes: { commit: { committedDate: string } }[] }
  reviewThreads: { nodes: { id: string; isResolved: boolean; isOutdated: boolean; path: string | null; line: number | null; originalLine: number | null; comments: { nodes: { databaseId: number; author: { login: string } | null; body: string; createdAt: string; url: string }[] } }[] }
  latestOpinionatedReviews: { nodes: { author: { login: string } | null; state: string; submittedAt: string | null; commit: { oid: string } | null }[] }
  latestReviews: { nodes: { author: { login: string } | null; state: string; submittedAt: string | null; commit: { oid: string } | null }[] }
  reviewRequests: { nodes: { requestedReviewer: { login?: string } | null }[] }
}

// Review threads (resolved or not), each reviewer's latest review and who is asked to review now.
export async function prConversation(cwd: string, number: number): Promise<PrConversation> {
  const [owner, name] = (await repoSlug(cwd)).split('/')
  const { stdout } = await sh('gh', ['api', 'graphql', '-f', `query=${CONVERSATION}`, '-f', `o=${owner}`, '-f', `r=${name}`, '-F', `n=${number}`], cwd)
  const pr = (JSON.parse(stdout) as { data: { repository: { pullRequest: ConvNode } } }).data.repository.pullRequest
  const requested = new Set(pr.reviewRequests.nodes.map((n) => n.requestedReviewer?.login).filter((x): x is string => Boolean(x)))
  const byLogin = new Map<string, PrReviewerState>()
  // opinionated (approve / request changes) wins over a later plain comment, as GitHub counts it
  for (const r of [...pr.latestReviews.nodes, ...pr.latestOpinionatedReviews.nodes]) {
    const login = r.author?.login
    if (!login) continue
    const state = (['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'].includes(r.state) ? r.state : 'COMMENTED') as PrReviewerState['state']
    byLogin.set(login, { login, state, at: r.submittedAt, sha: r.commit?.oid ?? null, requested: requested.has(login) })
  }
  for (const login of requested) if (!byLogin.has(login)) byLogin.set(login, { login, state: 'NONE', at: null, sha: null, requested: true })
  const last = pr.commits.nodes[0]?.commit
  return {
    author: pr.author?.login ?? '',
    headSha: pr.headRefOid,
    headAt: last?.committedDate ?? null,
    threads: pr.reviewThreads.nodes.map((t) => ({
      id: t.id,
      resolved: t.isResolved,
      outdated: t.isOutdated,
      ...(t.path ? { path: t.path } : {}),
      ...(t.line ?? t.originalLine ? { line: (t.line ?? t.originalLine) as number } : {}),
      comments: t.comments.nodes.map((c) => ({ id: c.databaseId, author: c.author?.login ?? 'ghost', body: c.body, at: c.createdAt, url: c.url })),
    })),
    reviewers: [...byLogin.values()],
    at: new Date().toISOString(),
  }
}

export async function resolveThread(cwd: string, threadId: string): Promise<void> {
  await sh('gh', ['api', 'graphql', '-f', 'query=mutation($id: ID!) { resolveReviewThread(input: { threadId: $id }) { thread { isResolved } } }', '-f', `id=${threadId}`], cwd)
}

// Asks these people to review again (GitHub's "re-request review").
export async function requestReviewers(cwd: string, number: number, logins: readonly string[]): Promise<void> {
  if (!logins.length) return
  await sh('gh', ['api', '-X', 'POST', `repos/{owner}/{repo}/pulls/${number}/requested_reviewers`, ...logins.flatMap((l) => ['-f', `reviewers[]=${l}`])], cwd)
}

// The commits on the PR after `since` (a sha), counted by GitHub's compare.
export async function commitsSince(cwd: string, since: string, head: string): Promise<number> {
  if (!since || since === head) return 0
  const { stdout } = await sh('gh', ['api', `repos/{owner}/{repo}/compare/${since}...${head}`, '--jq', '.ahead_by'], cwd)
  return Number(stdout) || 0
}

// Commit author emails on the PR, newest first: how a GitHub login is found in Slack.
// A GitHub user as Slack can find them: their name and the emails on their commits in this repo.
export async function githubPerson(cwd: string, login: string): Promise<{ name: string | null; emails: string[] }> {
  const name = await sh('gh', ['api', `users/${login}`, '--jq', '.name // ""'], cwd).then((r) => r.stdout.trim() || null, () => null)
  const emails = await sh('gh', ['api', `repos/{owner}/{repo}/commits?author=${encodeURIComponent(login)}&per_page=20`, '--jq', '.[].commit.author.email'], cwd).then(
    (r) => [...new Set(r.stdout.split('\n').map((x) => x.trim()).filter((x) => x && !/noreply/.test(x)))],
    () => [] as string[],
  )
  return { name, emails }
}

export async function prAuthorEmails(cwd: string, number: number): Promise<string[]> {
  const { stdout } = await sh('gh', ['pr', 'view', String(number), '--json', 'commits', '--jq', '[.commits[].authors[].email] | reverse | .[]'], cwd)
  return [...new Set(stdout.split('\n').map((x) => x.trim()).filter((x) => x && !/noreply/.test(x)))]
}
