import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Ticket } from '@ticketflow/shared'
import { log } from '../log.js'

// RESUME.md: where the lane was, what is committed and what is not. Sync on purpose: it also runs
// while the daemon is shutting down.
export function writeResumeNote(ticket: Ticket, flowDir: string, baseBranch: string, lines: readonly string[], reason: string): string {
  const run = (args: string[]) => {
    if (!ticket.worktree || !existsSync(ticket.worktree)) return ''
    try {
      return execFileSync('git', args, { cwd: ticket.worktree, timeout: 3000, encoding: 'utf8' }).trim()
    } catch {
      return ''
    }
  }
  const commits = run(['log', '--oneline', `origin/${baseBranch}..HEAD`])
  const dirty = run(['status', '--short'])
  const note = [
    `# ${ticket.id} stopped`,
    `${new Date().toISOString()} · ${reason}. Status before: ${ticket.status}${ticket.sessionEngine ? ` · session ${ticket.sessionId ?? '?'} on ${ticket.sessionEngine}` : ''}.`,
    '',
    '## Last steps',
    lines.length ? lines.slice(-12).map((l) => `- ${l}`).join('\n') : '- (no lane output in this daemon run)',
    '',
    '## Commits on the branch',
    commits || '(none yet)',
    '',
    '## Not committed',
    dirty || '(clean)',
    '',
    '## To pick it up',
    'Resume in metwo continues the same session with this note. Or open the worktree, check the steps above and carry on by hand.',
  ].join('\n')
  try {
    mkdirSync(flowDir, { recursive: true })
    writeFileSync(path.join(flowDir, 'RESUME.md'), `${note}\n`)
  } catch (error) {
    log.warn(`${ticket.id}: could not write RESUME.md`, error)
  }
  return note
}
