import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync, lstatSync, rmSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import type { Config, E2eApp } from '../config.js'
import { portOpen, stackUp, waitForDev } from './local-checks.js'
import { git } from './shell.js'

// The app from a worktree on the local e2e stack, for mevo's own browser runs (the visual plan).
// The hand test starts its app the same way.
export interface AppServer {
  readonly url: string
  readonly rpc: string | null
  readonly app: E2eApp
  stop(): void
}

// The e2e app the diff touches (the first one when it touches only shared packages)
export async function appFor(cfg: Config, worktree: string): Promise<E2eApp | null> {
  const apps = cfg.e2e?.apps ?? []
  const changed = (await git(['diff', '--name-only', `origin/${cfg.repo.baseBranch}...HEAD`], worktree).catch(() => '')).split('\n').filter(Boolean)
  return apps.find((a) => changed.some((f) => a.paths.some((p) => f.startsWith(p)) && !f.startsWith('packages/'))) ?? apps[0] ?? null
}

export async function startApp(cfg: Config, worktree: string, firstPort: number, stage: (s: string) => void, app?: E2eApp | null): Promise<AppServer> {
  const picked = app ?? (await appFor(cfg, worktree))
  if (!picked) throw new Error('no e2e app is set up for this repo (e2e.apps in the config)')
  stage('checking the local e2e stack')
  const down = await stackUp(cfg, stage)
  if (down) throw new Error(down)
  let port = firstPort
  while (await portOpen(port)) port++
  stage(`starting the ${picked.name} app on :${port}`)
  const dev: ChildProcess = spawn('bash', ['-lc', picked.dev.replace('{port}', String(port))], { cwd: worktree, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
  let log = ''
  const keep = (d: Buffer) => (log = (log + d.toString()).slice(-4000))
  dev.stdout?.on('data', keep)
  dev.stderr?.on('data', keep)
  const stop = () => {
    if (!dev.pid) return
    try {
      process.kill(-dev.pid, 'SIGTERM')
    } catch {
      // gone
    }
  }
  const up = await waitForDev(port, dev, () => log, 180_000)
  if (!up) {
    stop()
    throw new Error(`the ${picked.name} app did not come up on :${port}${log.trim() ? `: ${log.trim().split('\n').slice(-3).join(' ')}` : ''}`)
  }
  return { url: `http://localhost:${up.port}`, rpc: `http://127.0.0.1:${cfg.e2e?.ports.anvil ?? 8545}`, app: picked, stop }
}

// A browser script runs from `dir` with the repo's e2e packages (Playwright, the headless wallet)
// linked in as node_modules; mevo's own Playwright when the repo has none.
export function linkModules(dir: string, worktree: string, own: string): { wallet: boolean } {
  const e2e = path.join(worktree, 'e2e', 'node_modules')
  const repo = existsSync(path.join(e2e, '@playwright', 'test'))
  const link = path.join(dir, 'node_modules')
  try {
    if (lstatSync(link)) rmSync(link, { recursive: true, force: true })
  } catch {
    // not there yet
  }
  symlinkSync(repo ? e2e : own, link, 'dir')
  return { wallet: repo && existsSync(path.join(e2e, '@ensdomains', 'headless-web3-provider')) }
}
