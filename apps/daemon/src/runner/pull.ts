import type { Ticket } from '@ticketflow/shared'
import { git } from './shell.js'

export interface PullResult {
  // current: nothing new · ahead: GitHub has nothing the worktree lacks · pulled: fast-forward ·
  // merged: merged with local commits · busy: a lane is running · diverged: needs a merge (asked
  // for by hand) · conflicts: the merge conflicts · error: git said no
  readonly outcome: 'current' | 'ahead' | 'pulled' | 'merged' | 'busy' | 'diverged' | 'conflicts' | 'error'
  readonly commits: number
  readonly remote: string
  readonly text: string
  readonly files?: readonly string[]
}

// Brings the PR branch's new commits from GitHub into the worktree. A fast-forward always; a
// merge with local commits only when `merge` is set (you pressed the button). Never rebases, so
// the PR never needs a force push.
export async function pullPrBranch(worktree: string, branch: string, status: Ticket['status'], merge: boolean): Promise<PullResult> {
  if (status === 'running' || status === 'queued') return { outcome: 'busy', commits: 0, remote: '', text: 'A lane is running; it pulls once the lane is done.' }
  try {
    await git(['fetch', 'origin', branch], worktree)
  } catch (error) {
    return { outcome: 'error', commits: 0, remote: '', text: `git fetch failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}` }
  }
  const remote = await git(['rev-parse', `origin/${branch}`], worktree)
  const head = await git(['rev-parse', 'HEAD'], worktree)
  if (remote === head) return { outcome: 'current', commits: 0, remote, text: 'Already up to date with GitHub.' }
  const behind = Number(await git(['rev-list', '--count', `HEAD..origin/${branch}`], worktree)) || 0
  const ahead = Number(await git(['rev-list', '--count', `origin/${branch}..HEAD`], worktree)) || 0
  if (behind === 0) return { outcome: 'ahead', commits: 0, remote, text: `GitHub has nothing new; ${ahead} local commit(s) not pushed yet.` }
  if (ahead === 0) {
    try {
      await git(['merge', '--ff-only', `origin/${branch}`], worktree)
      return { outcome: 'pulled', commits: behind, remote, text: `Pulled ${behind} commit(s) from GitHub.` }
    } catch (error) {
      return { outcome: 'error', commits: behind, remote, text: `Could not fast-forward (uncommitted changes in the way?): ${error instanceof Error ? error.message.split('\n')[0] : String(error)}` }
    }
  }
  if (!merge) return { outcome: 'diverged', commits: behind, remote, text: `GitHub has ${behind} commit(s) and the worktree has ${ahead} not pushed; Pull from GitHub merges them.` }
  try {
    await git(['merge', '--no-edit', `origin/${branch}`], worktree)
    return { outcome: 'merged', commits: behind, remote, text: `Merged ${behind} commit(s) from GitHub with your ${ahead} local one(s).` }
  } catch {
    const files = (await git(['diff', '--name-only', '--diff-filter=U'], worktree).catch(() => '')).split('\n').filter(Boolean)
    await git(['merge', '--abort'], worktree).catch(() => undefined)
    return { outcome: 'conflicts', commits: behind, remote, files, text: `The ${behind} commit(s) from GitHub conflict with your local ones${files.length ? ` in ${files.slice(0, 5).join(', ')}` : ''}. Nothing was changed.` }
  }
}
