import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Ticket } from '@ticketflow/shared'

const GROUPS: readonly { title: string; statuses: readonly Ticket['status'][] }[] = [
  { title: 'Stopped mid-run (Resume in mevo, or see RESUME.md in the flow dir)', statuses: ['stopped'] },
  { title: 'Waiting for you', statuses: ['needs_input', 'review_ready', 'no_change', 'failed'] },
  { title: 'Queued', statuses: ['queued'] },
  { title: 'Running', statuses: ['running'] },
  { title: 'Open PRs', statuses: ['pr_draft'] },
  { title: 'Assigned, not started', statuses: ['assigned'] },
]

// data/pending.md: everything not finished, so work can pick up after a stop or a restart.
export function writePending(dataDir: string, tickets: readonly Ticket[], why: string): string {
  const file = path.join(dataDir, 'pending.md')
  const line = (t: Ticket) => {
    const bits = [
      t.stopped ? `stopped ${t.stopped.at.slice(0, 16).replace('T', ' ')} (${t.stopped.reason})` : '',
      t.prUrl ? t.prUrl : '',
      t.behindMain ? `${t.behindMain.commits} behind main${t.behindMain.conflicts ? ', conflicts' : ''}` : '',
      t.worktree ? `worktree ${t.worktree}` : '',
    ].filter(Boolean)
    return `- ${t.id} · ${t.title}${bits.length ? `\n  ${bits.join(' · ')}` : ''}`
  }
  const sections = GROUPS.map((g) => ({ g, list: tickets.filter((t) => g.statuses.includes(t.status)) }))
    .filter((x) => x.list.length > 0)
    .map((x) => `## ${x.g.title}\n${x.list.map(line).join('\n')}`)
  const text = [`# Pending work`, `${new Date().toISOString()} · ${why}`, '', sections.join('\n\n') || 'Nothing pending.'].join('\n')
  writeFileSync(file, `${text}\n`)
  return file
}
