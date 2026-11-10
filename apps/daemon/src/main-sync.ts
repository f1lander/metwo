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
    private readonly config: () => Config,
    private readonly store: Store,
    private readonly runner: Runner,
  ) {}

  async tick(): Promise<void> {
    const base = `origin/${this.config().repo.baseBranch}`
    try {
      await git(['fetch', 'origin', this.config().repo.baseBranch], this.config().repo.path)
      this.fetchedAt = Date.now()
    } catch (error) {
      this.onResult?.(false, `fetch failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    let behind = 0
    for (const t of this.store.byStatus(...OPEN)) if (!t.replay && ((await this.check(t, base)) > 0)) behind++
    this.onResult?.(true, behind ? `${behind} branch(es) behind ${this.config().repo.baseBranch}` : `all branches up to date with ${this.config().repo.baseBranch}`)
  }

  // One ticket right away, when GitHub reports its PR conflicting before the next tick.
  async checkOne(id: string): Promise<void> {
    const t = this.store.get(id)
    if (!t?.worktree || t.replay || !OPEN.includes(t.status)) return
    const base = `origin/${this.config().repo.baseBranch}`
    if (Date.now() - this.fetchedAt > 60_000) {
      await git(['fetch', 'origin', this.config().repo.baseBranch], this.config().repo.path).catch(() => undefined)
      this.fetchedAt = Date.now()
    }
    await this.check(t, base)
  }

  private fetchedAt = 0

  // records how far behind the base one branch is, and which files would conflict; returns the commits behind
  private async check(t: Ticket, base: string): Promise<number> {
    if (!t.worktree || !existsSync(t.worktree) || t.manualMerge) return 0
    try {
      const commits = Number(await git(['rev-list', '--count', `HEAD..${base}`], t.worktree)) || 0
      const files = commits > 0 ? await conflictFiles(t.worktree, base) : []
      const conflicts = files.length > 0
      const prev = t.behindMain
      if (commits === 0 && prev) {
        const { behindMain: _clear, ...rest } = t
        this.store.upsert(rest)
      } else if (commits > 0 && (prev?.commits !== commits || prev.conflicts !== conflicts || (prev.files ?? []).join() !== files.join())) {
        this.store.patch(t.id, { behindMain: { commits, conflicts, at: new Date().toISOString(), ...(conflicts ? { files } : {}) } })
      }
      if (this.config().pipeline.autoUpdateFromMain && commits > 0 && !conflicts && t.status === 'pr_draft' && t.pr?.state !== 'MERGED') {
        const outcome = await this.runner.updateFromMain(t.id)
        this.onUpdated?.(this.store.get(t.id) ?? t, outcome)
      }
      return commits
    } catch (error) {
      log.warn(`${t.id}: main sync failed`, error)
      return 0
    }
  }
}

// git merge-tree (2.38+) does the merge in memory: exit 1 means conflicts, and its output is the
// tree id, then the conflicted files, then a blank line. Older git: unknown, say none.
export async function conflictFiles(worktree: string, base: string): Promise<string[]> {
  try {
    await sh('git', ['merge-tree', '--write-tree', '--name-only', 'HEAD', base], worktree)
    return []
  } catch (error) {
    const e = error as { code?: number; stdout?: string }
    if (e.code !== 1) return []
    const lines = (e.stdout ?? '').split('\n').slice(1)
    const end = lines.findIndex((l) => !l.trim())
    const files = [...new Set((end === -1 ? lines : lines.slice(0, end)).map((l) => l.trim()).filter(Boolean))]
    return files.length ? files : ['(unknown files)']
  }
}
