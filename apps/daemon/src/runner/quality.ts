import type { PrSize, Ticket } from '@ticketflow/shared'
import type { Config } from '../config.js'
import { git } from './shell.js'

// Small PRs a person can review: the size count, what holds a PR back from review, and when a
// diff needs the security lens.

// pnpm-lock.yaml, *.snap, **/__snapshots__/**: "*" stays in one folder, "**" crosses them, a
// pattern without "/" matches the file name anywhere
export function globRe(glob: string): RegExp {
  const body = glob
    .split('**')
    .map((part) => part.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('.*')
    .replace(/\.\*\//g, '(?:.*/)?')
  return new RegExp(glob.includes('/') ? `^${body}$` : `(^|/)${body}$`)
}

const TEST = /(\.|\/)(test|spec|stories)\.[cm]?[jt]sx?$|(^|\/)(__tests__|e2e)\//

// From `git diff --numstat`: lines added + removed per file. Binary files count as 0 lines.
export function countSize(numstat: string, ignore: readonly string[], at = new Date().toISOString()): PrSize {
  const skip = ignore.map(globRe)
  let lines = 0
  let tests = 0
  let files = 0
  for (const row of numstat.split('\n')) {
    const [a, r, ...rest] = row.split('\t')
    const raw = rest.join('\t')
    if (!raw) continue
    // renames: "src/{old => new}/x.ts" or "old => new"
    const file = raw.replace(/\{[^}]*? => ([^}]*)\}/g, '$1').replace(/^.* => /, '').replace(/\/\//g, '/')
    if (skip.some((re) => re.test(file))) continue
    const n = (Number(a) || 0) + (Number(r) || 0)
    files += 1
    lines += n
    if (TEST.test(file)) tests += n
  }
  return { lines, files, tests, at }
}

export async function prSize(worktree: string, baseBranch: string, ignore: readonly string[]): Promise<PrSize> {
  const base = await git(['merge-base', `origin/${baseBranch}`, 'HEAD'], worktree)
  return countSize(await git(['diff', '--numstat', '--find-renames', base, 'HEAD'], worktree), ignore)
}

export const sizeLine = (s: PrSize) => `${s.lines} line${s.lines === 1 ? '' : 's'} changed in ${s.files} file${s.files === 1 ? '' : 's'}${s.tests ? ` (${s.tests} in tests)` : ''}`

// Why a PR should not be marked ready for review yet, or null.
export function readyHold(t: Ticket, q: Config['quality']): string | null {
  const reasons: string[] = []
  if (q.maxLines && t.size && t.size.lines > q.maxLines) reasons.push(`it changes ${t.size.lines} lines, over your max of ${q.maxLines}: split it`)
  const score = t.pr?.greptile?.score
  if (q.minGreptile && t.pr && score !== undefined && score !== null && score < q.minGreptile) reasons.push(`Greptile gave it ${score}/5, under your minimum of ${q.minGreptile}`)
  return reasons.length ? reasons.join('; ') : null
}

// The patterns the added lines hit, for the security lens. Removed lines don't count.
export function securityHits(diff: string, patterns: readonly string[]): string[] {
  const added = diff
    .split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .join('\n')
  const hits = new Set<string>()
  for (const p of patterns) {
    let re: RegExp
    try {
      re = new RegExp(p, 'g')
    } catch {
      continue
    }
    for (const m of added.matchAll(re)) hits.add(m[0])
  }
  return [...hits].slice(0, 8)
}

export function securityLens(hits: readonly string[]): string {
  return `Security (the diff adds ${hits.map((h) => `\`${h}\``).join(', ')}). Read it the way a bug bounty researcher would: what can a user, a URL, a name record or another site control, and where does it end up? Check for a wrong chain, address, amount or calldata in a transaction or signature; signatures that can be replayed; approvals larger than needed; user input reaching HTML, URLs or redirects unescaped; secrets or personal data sent to a third party or logged; async races that act on stale state. Fix what you can prove; anything you suspect but can't prove goes under Known risks with the file and line.`
}
