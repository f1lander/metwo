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
export async function ensureWorktree(cfg: Config['repo'], ticketId: string, branch: string, startPoint?: string): Promise<Worktree> {
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
    await git(['worktree', 'add', '-b', branch, wtPath, startPoint ?? base], cfg.path)
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

// Commits here that the PR's head on GitHub doesn't have, newest first (merges counted, not listed)
export async function unpushedSince(worktree: string, headSha: string): Promise<{ count: number; commits: { sha: string; subject: string }[]; at: string }> {
  const count = Number(await git(['rev-list', '--count', `${headSha}..HEAD`], worktree)) || 0
  const log = count ? await git(['log', '--no-merges', '-n', '20', '--format=%h%x09%s', `${headSha}..HEAD`], worktree) : ''
  const commits = log
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha = '', ...rest] = l.split('\t')
      return { sha, subject: rest.join('\t') }
    })
  return { count, commits, at: new Date().toISOString() }
}
