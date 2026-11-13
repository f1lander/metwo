import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { reviewerFollowUps, type Ticket } from '@ticketflow/shared'
import { git } from './shell.js'

const clip = (s: string | undefined, n: number) => {
  const t = (s ?? '').replace(/\r/g, '').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}
const one = (s: string | undefined, n: number) => clip((s ?? '').replace(/\s+/g, ' '), n)
const day = (iso: string | undefined) => (iso ? iso.slice(0, 16).replace('T', ' ') : '')

// Everything known about one ticket, in one file, for questions in the chat: the PR and its review
// threads, every commit, what each lane turn and check said, and what happened to each comment.
// Built from what mevo already keeps, no model. Rebuilt before each question.
export async function writeRecord(t: Ticket, flowDir: string, baseBranch: string): Promise<string> {
  const out: string[] = []
  const pr = t.pr
  out.push(`# ${t.id}: ${t.title}`)
  out.push(
    [
      `Status in mevo: ${t.status}`,
      `Linear: ${t.linearState} · ${t.url}`,
      `Branch: ${t.branch}${t.worktree ? ` · worktree ${t.worktree}` : ''}`,
      pr ? `PR #${pr.number} ${pr.url} · ${pr.state.toLowerCase()}${pr.isDraft ? ', draft' : ''} · review: ${pr.reviewDecision || 'none'} · CI: ${pr.ci}${pr.mergeable ? ` · merge: ${pr.mergeable.toLowerCase()}` : ''} · head ${pr.headSha?.slice(0, 9) ?? '?'}` : t.prUrl ? `PR: ${t.prUrl}` : 'No PR yet',
      t.pushedSha ? `Last pushed by mevo: ${t.pushedSha.slice(0, 9)}${t.lastPushAt ? ` at ${day(t.lastPushAt)}` : ''}` : '',
      t.behindMain ? `Behind main: ${t.behindMain.commits} commit(s)${t.behindMain.conflicts ? ', conflicts' : ''}` : '',
      t.behindPr ? `GitHub has ${t.behindPr.commits} commit(s) not in the worktree (${t.behindPr.why})` : '',
      `The ticket text and its Linear discussion, as the lane got them: ${path.join(flowDir, 'brief.md')}`,
      existsSync(path.join(t.worktree ?? '', 'ARM-SUMMARY.md')) ? `The lane's own summary: ${path.join(t.worktree as string, 'ARM-SUMMARY.md')}` : '',
    ]
      .filter(Boolean)
      .map((l) => `- ${l}`)
      .join('\n'),
  )

  // commits, oldest first, with the files each touched
  if (t.worktree && existsSync(t.worktree)) {
    const log = await git(['log', '--reverse', '--date=format:%Y-%m-%d %H:%M', '--format=--- %h %ad %an%n%s%n%b', '--stat=120', `origin/${baseBranch}..HEAD`], t.worktree).catch(() => '')
    const pushed = t.pushedSha ? await git(['rev-list', `origin/${baseBranch}..${t.pushedSha}`], t.worktree).catch(() => '') : ''
    const onPr = new Set(pushed.split('\n').map((x) => x.slice(0, 7)))
    const marked = log.replace(/^--- ([0-9a-f]{7,})/gm, (_m, h: string) => `--- ${h}${t.pushedSha ? (onPr.has(h.slice(0, 7)) ? ' (on the PR)' : ' (local, not pushed)') : ''}`)
    out.push(`## Commits on the branch (oldest first)\n${clip(marked, 16_000) || '(none yet)'}`)
    const dirty = await git(['status', '--short'], t.worktree).catch(() => '')
    if (dirty) out.push(`## Uncommitted in the worktree\n${clip(dirty, 2000)}`)
  }

  // review threads as GitHub has them, and what each reviewer is waiting on
  const conv = t.conversation
  if (conv) {
    const handled = t.commentsHandled ?? {}
    const fus = reviewerFollowUps(conv, handled)
    if (fus.length) out.push(`## Reviewers\n${fus.map((f) => `- ${f.login}: ${f.state.toLowerCase().replace('_', ' ')} · ${f.next === 'fix' ? `${f.open.length - f.answered.length} comment(s) still to address` : f.next === 'tell' ? 'everything answered, not told on GitHub' : f.next === 'waiting' ? 're-review asked' : 'done'}`).join('\n')}`)
    if (conv.threads.length) {
      out.push(
        `## Review threads on GitHub\n${conv.threads
          .map((th) => {
            const first = th.comments[0]
            const how = first ? handled[`inline-${first.id}`]?.how : undefined
            const head = `### ${th.path ?? 'PR'}${th.line ? `:${th.line}` : ''} · ${th.resolved ? 'RESOLVED' : 'OPEN'}${th.outdated ? ' · outdated (the code under it changed)' : ''}${how ? ` · mevo: ${how}` : ''}${first ? ` · ${first.url}` : ''}`
            return `${head}\n${th.comments.map((c) => `- ${c.author} (${day(c.at)}): ${one(c.body, 700)}`).join('\n')}`
          })
          .join('\n\n')}`,
      )
    }
  }
  const people = (pr?.comments ?? []).filter((c) => !c.bot && c.kind !== 'inline')
  if (people.length) {
    const handled = t.commentsHandled ?? {}
    out.push(`## PR comments and review bodies\n${people.map((c) => `- ${c.author} (${day(c.createdAt)})${handled[c.id] ? ` · mevo: ${handled[c.id]?.how}` : ''}: ${one(c.body, 600)} · ${c.url}`).join('\n')}`)
  }
  if (pr?.greptile) {
    const g = pr.greptile
    out.push(`## Greptile ${g.score ?? '?'}/5 (${day(g.at)})\n${g.findings.map((f) => `- [${f.level ?? '?'}] ${f.title}${f.path ? ` (${f.path}${f.line ? `:${f.line}` : ''})` : ''}: ${one(f.body, 300)}`).join('\n') || '- no findings'}`)
  }

  // checks
  const checks: string[] = []
  if (t.localChecks) checks.push(`Local checks on ${t.localChecks.sha.slice(0, 9)}: ${t.localChecks.status}${t.localChecks.steps.length ? ` (${t.localChecks.steps.map((s) => `${s.name} ${s.ok === true ? 'ok' : s.ok === false ? 'FAILED' : 'not run'}`).join(', ')})` : ''}`)
  if (t.supervision) checks.push(`Supervisor ${t.supervision.engine}${t.supervision.sha ? ` on ${t.supervision.sha.slice(0, 9)}` : ''}: ${t.supervision.verdict}. ${one(t.supervision.summary, 400)}${t.supervision.findings.length ? `\n  ${t.supervision.findings.map((f) => `[${f.severity}] ${f.file ?? ''} ${one(f.note, 300)}`).join('\n  ')}` : ''}`)
  if (t.visual) checks.push(`Visual check: ${t.visual.verdict}${t.visualStale ? ' (stale: code changed since)' : ''}. ${one(t.visual.summary, 300)}`)
  if (t.ci) checks.push(`CI (${day(t.ci.at)}): ${t.ci.verdict}. ${one(t.ci.why, 300)}${t.ci.jobs.length ? ` Jobs: ${t.ci.jobs.map((j) => j.name).join(', ')}` : ''}`)
  if (t.readiness) checks.push(`Readiness before the start: ${t.readiness.verdict} ${t.readiness.confidence}%. ${one(t.readiness.why, 300)}`)
  if (checks.length) out.push(`## Checks\n${checks.map((c) => `- ${c}`).join('\n')}`)

  // the timeline, oldest first; your earlier chat questions included
  const journal = (t.journal ?? []).filter((j) => j.kind !== 'note' || !/^(Brief context|Past review feedback)/.test(j.title))
  out.push(
    `## Timeline (oldest first)\n${journal
      .map((j) => {
        const meta = j.meta ? Object.entries(j.meta).filter(([k]) => ['cost', 'minutes', 'model', 'url', 'sha'].includes(k)).map(([k, v]) => `${k} ${v}`).join(', ') : ''
        const long = ['run', 'review', 'question', 'answer', 'ask', 'comment'].includes(j.kind)
        return `### ${day(j.at)} · ${j.kind} · ${j.title}${meta ? ` (${meta})` : ''}${j.body ? `\n${long ? clip(j.body, 1800) : one(j.body, 300)}` : ''}`
      })
      .join('\n')
      .slice(-40_000)}`,
  )

  const text = out.join('\n\n')
  mkdirSync(flowDir, { recursive: true })
  const file = path.join(flowDir, 'HISTORY.md')
  writeFileSync(file, text)
  return file
}
