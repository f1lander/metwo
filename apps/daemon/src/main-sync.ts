import { existsSync } from 'node:fs'
import type { Ticket } from '@ticketflow/shared'
import type { Config } from './config.js'
import { log } from './log.js'
import type { Runner } from './runner/index.js'
import { git, sh } from './runner/shell.js'
import type { Store } from './store.js'

// Statuses whose branch can fall behind the base and still matters.
const OPEN: readonly Ticket['status'][] = ['review_ready', 'pr_draft', 'needs_input', 'no_change', 'stopped', 'failed']

// Fetches the base branch on a timer and records, per open branch, how many commits it is
// behind and whether merging would conflict. Nothing in a worktree changes unless
// autoUpdateFromMain is on, and then only for clean, conflict-free PRs.
export class MainSync {
  onResult: ((ok: boolean, detail: string) => void) | null = null
  onUpdated: ((ticket: Ticket, outcome: string) => void) | null = null

  constructor(
    private readonly cfg: Config,
    private readonly store: Store,
    private readonly runner: Runner,
  ) {}

  async tick(): Promise<void> {
    const base = `origin/${this.cfg.repo.baseBranch}`
    try {
      await git(['fetch', 'origin', this.cfg.repo.baseBranch], this.cfg.repo.path)
    } catch (error) {
      this.onResult?.(false, `fetch failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    let behind = 0
    for (const t of this.store.byStatus(...OPEN)) {
      if (!t.worktree || !existsSync(t.worktree)) continue
      try {
        const commits = Number(await git(['rev-list', '--count', `HEAD..${base}`], t.worktree)) || 0
        const conflicts = commits > 0 && (await mergeConflicts(t.worktree, base))
        if (commits > 0) behind++
        const prev = t.behindMain
        if (commits === 0 && prev) {
          const { behindMain: _clear, ...rest } = t
          this.store.upsert(rest)
        } else if (commits > 0 && (prev?.commits !== commits || prev.conflicts !== conflicts)) {
          this.store.patch(t.id, { behindMain: { commits, conflicts, at: new Date().toISOString() } })
        }
        if (this.cfg.pipeline.autoUpdateFromMain && commits > 0 && !conflicts && t.status === 'pr_draft' && t.pr?.state !== 'MERGED') {
          const outcome = await this.runner.updateFromMain(t.id)
          this.onUpdated?.(this.store.get(t.id) ?? t, outcome)
        }
      } catch (error) {
        log.warn(`${t.id}: main sync failed`, error)
      }
    }
    this.onResult?.(true, behind ? `${behind} branch(es) behind ${this.cfg.repo.baseBranch}` : `all branches up to date with ${this.cfg.repo.baseBranch}`)
  }
}

// git merge-tree (2.38+) does the merge in memory: exit 1 means conflicts. Older git: unknown, say no.
async function mergeConflicts(worktree: string, base: string): Promise<boolean> {
  try {
    await sh('git', ['merge-tree', '--write-tree', '--name-only', 'HEAD', base], worktree)
    return false
  } catch (error) {
    return (error as { code?: number }).code === 1
  }
}
