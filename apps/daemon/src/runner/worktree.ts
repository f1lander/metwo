import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Config } from '../config.js'
import { git } from './shell.js'

export interface Worktree {
  readonly path: string
  readonly flowDir: string
  readonly branch: string
  readonly base: string
}

// One worktree per ticket at <repo>/.worktrees/<ID>, pinned to origin/<base> at creation.
// Mirrors stage 0 of the wiki's implement-ticket spec so a "full" run can reuse it.
export async function ensureWorktree(cfg: Config['repo'], ticketId: string, branch: string): Promise<Worktree> {
  const wtPath = path.join(cfg.path, cfg.worktreesDir, ticketId)
  const flowDir = path.join(cfg.path, cfg.worktreesDir, `${ticketId}-flow`)
  mkdirSync(path.join(flowDir, 'logs'), { recursive: true })

  await git(['fetch', 'origin', cfg.baseBranch], cfg.path)
  const base = await git(['rev-parse', `origin/${cfg.baseBranch}`], cfg.path)

  if (existsSync(wtPath)) {
    return { path: wtPath, flowDir, branch, base }
  }

  const branches = await git(['branch', '--list', branch], cfg.path)
  const remoteBranches = await git(['branch', '-r', '--list', `origin/${branch}`], cfg.path)
  if (branches.trim()) {
    await git(['worktree', 'add', wtPath, branch], cfg.path)
  } else if (remoteBranches.trim()) {
    await git(['worktree', 'add', '--track', '-b', branch, wtPath, `origin/${branch}`], cfg.path)
  } else {
    await git(['worktree', 'add', '-b', branch, wtPath, base], cfg.path)
  }
  return { path: wtPath, flowDir, branch, base }
}

export async function localCommits(wt: Worktree, baseBranch: string): Promise<string> {
  return git(['log', '--oneline', `origin/${baseBranch}..HEAD`], wt.path)
}

export async function diffStat(wt: Worktree, baseBranch: string): Promise<string> {
  return git(['diff', '--stat', `origin/${baseBranch}...HEAD`], wt.path)
}

export async function hasUncommitted(wt: Worktree): Promise<boolean> {
  const out = await git(['status', '--porcelain', '--untracked-files=no'], wt.path)
  return out.trim().length > 0
}
