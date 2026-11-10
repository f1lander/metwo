import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { LocalChecks, Ticket } from '@ticketflow/shared'
import type { Config, E2eApp } from '../config.js'
import { runGates } from './supervise.js'
import { git, sh } from './shell.js'

type Step = LocalChecks['steps'][number]

// Words in paths and spec names that say nothing about the feature.
const NOISE = new Set(['apps', 'app', 'src', 'manager', 'portal', 'features', 'feature', 'components', 'component', 'index', 'tsx', 'test', 'tests', 'spec', 'stories', 'story', 'state', 'service', 'services', 'lib', 'hooks', 'hook', 'utils', 'util', 'routes', 'route', 'workflow', 'view', 'views', 'packages', 'locales', 'messages', 'name', 'names', 'page', 'pages', 'shared', 'types', 'constants', 'context', 'machine', 'helpers', 'e2e', 'projects', 'store', 'model', 'data', 'config'])

export function words(p: string): string[] {
  return p
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !NOISE.has(w) && !/^v\d+$/.test(w))
}

// Same feature when the words share their first six letters (register ~ registration).
const near = (a: string, b: string) => a === b || (a.length >= 6 && b.length >= 6 && a.slice(0, 6) === b.slice(0, 6))

// The specs worth running for these changed files: specs the diff touches, and specs whose name
// names a feature the diff touches. A change to the shared e2e fixtures runs them all.
export function relatedSpecs(changed: readonly string[], app: E2eApp, specs: readonly string[], mode: 'related' | 'all'): string[] {
  const mine = changed.filter((f) => app.paths.some((p) => f.startsWith(p)))
  if (!mine.length) return []
  if (mode === 'all' || mine.some((f) => /^e2e\/(fixtures|helpers)\//.test(f))) return [...specs]
  const touched = new Set(mine.filter((f) => f.startsWith(`${app.specs}/`)).map((f) => path.posix.basename(f)))
  const feature = mine.flatMap((f) => words(f))
  return specs.filter((s) => touched.has(s) || words(s.replace(/\.spec\.ts$/, '')).some((w) => feature.some((f) => near(w, f))))
}

// Vite on macOS listens on "localhost", which is often ::1 only: a server is up if either answers.
export async function portOpen(port: number, host?: string, timeoutMs = 1500): Promise<boolean> {
  if (host) return connects(port, host, timeoutMs)
  const [v4, v6] = await Promise.all([connects(port, '127.0.0.1', timeoutMs), connects(port, '::1', timeoutMs)])
  return v4 || v6
}

function connects(port: number, host: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host })
    const done = (ok: boolean) => {
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(timeoutMs, () => done(false))
    sock.once('connect', () => done(true))
    sock.once('error', () => done(false))
  })
}

// KEY=value lines; quotes stripped, comments skipped.
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!m?.[1] || line.trim().startsWith('#')) continue
    out[m[1]] = (m[2] ?? '').replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

// The port a dev server says it is on ("Local: http://localhost:3001/"), when it printed one.
export function devPort(log: string): number | null {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: colour codes in the dev server's output
  const plain = log.replace(/\x1b\[[0-9;]*m/g, '')
  const all = [...plain.matchAll(/Local:\s+https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):(\d+)/g)]
  const port = Number(all.at(-1)?.[1])
  return port > 0 ? port : null
}

// Waits for the dev server on the port it was given, or on the one it says it took instead.
export async function waitForDev(port: number, dev: { exitCode: number | null }, log: () => string, ms: number, stop?: () => boolean): Promise<{ port: number; moved: boolean } | null> {
  const deadline = Date.now() + ms
  for (;;) {
    if (await portOpen(port)) return { port, moved: false }
    const said = devPort(log())
    if (said && said !== port && (await portOpen(said))) return { port: said, moved: true }
    if (Date.now() > deadline || dev.exitCode !== null || stop?.()) return null
    await new Promise((r) => setTimeout(r, 1500))
  }
}

const tail = (text: string, n = 30) => text.trim().split('\n').slice(-n).join('\n')

// What a failed Playwright run says about why: the failed tests and the summary first, then the end
export function e2eTail(out: string, n = 40): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: colour codes in the output
  const lines = out.replace(/\x1b\[[0-9;]*m/g, '').split('\n')
  const key = lines.filter((l) => /^\s*(✘|×)\s|^\s*\d+\) \[|^\s*\d+ (failed|flaky|passed|skipped|did not run)\b|Timed out .* waiting|Error: (?!ERR_PNPM)/.test(l)).map((l) => l.trimEnd())
  const uniq = [...new Set(key)].slice(0, 20)
  const end = lines.slice(-Math.max(8, n - uniq.length)).join('\n').trim()
  return uniq.length ? `${uniq.join('\n')}\n…\n${end}` : end
}

// One e2e run at a time: every app shares the one local chain and its funded accounts.
let e2eLock: Promise<unknown> = Promise.resolve()
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = e2eLock.then(fn, fn)
  e2eLock = run.catch(() => undefined)
  return run
}

interface Deps {
  readonly cfg: Config
  readonly ticket: Ticket
  readonly worktree: string
  readonly port: number
  readonly signal?: AbortSignal | undefined
  readonly onStep: (step: string) => void
  // full e2e and dev server output goes here (the step keeps only the tail)
  readonly logDir?: string
  // gates only, and why (a quick fix, or the PR is open and CI runs them)
  readonly skipE2e?: string
}

export async function runLocalChecks(d: Deps): Promise<Omit<LocalChecks, 'status' | 'at'> & { readonly status: 'pass' | 'fail' }> {
  const { cfg, worktree } = d
  const sha = await git(['rev-parse', 'HEAD'], worktree)
  const steps: Step[] = []

  // the gates: reused when the supervisor just ran them green on this same commit
  const sup = d.ticket.supervision
  if (sup?.sha === sha && sup.gates.length && sup.gates.every((g) => g.ok)) {
    for (const g of sup.gates) steps.push({ name: g.name, ok: true, tail: g.tail, note: 'green in the supervisor run on this commit' })
  } else {
    d.onStep('typecheck, lint and tests')
    const started = Date.now()
    const gates = await runGates(cfg, worktree, d.signal)
    const seconds = Math.round((Date.now() - started) / 1000)
    for (const g of gates) steps.push({ name: g.name, ok: g.ok, tail: g.tail, seconds })
  }

  // e2e: the specs related to what changed, for each app CI would test
  const specs: string[] = []
  const e2e = cfg.e2e
  const mode = cfg.localChecks.e2e
  if (d.skipE2e && e2e?.apps?.length && mode !== 'off') steps.push({ name: 'e2e', ok: null, tail: '', note: d.skipE2e })
  else if (e2e?.apps?.length && mode !== 'off' && !d.signal?.aborted) {
    const changed = (await git(['diff', '--name-only', `origin/${cfg.repo.baseBranch}...HEAD`], worktree).catch(() => '')).split('\n').filter(Boolean)
    for (const app of e2e.apps) {
      const dir = path.join(worktree, app.specs)
      const all = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.spec.ts')).sort() : []
      const pick = relatedSpecs(changed, app, all, mode)
      if (!changed.some((f) => app.paths.some((p) => f.startsWith(p)))) continue
      if (!pick.length) {
        steps.push({ name: `e2e ${app.name}`, ok: null, tail: '', note: 'no spec matches what changed; CI runs the full suite' })
        continue
      }
      specs.push(...pick.map((s) => `${app.name}/${s}`))
      d.onStep(`e2e ${app.name}: waiting for the stack`)
      steps.push(await exclusive(() => runE2e(d, app, pick)))
    }
  }
  const status = steps.some((s) => s.ok === false) ? 'fail' : 'pass'
  return { sha, steps, specs, status }
}

export async function stackUp(cfg: Config, onStep: (s: string) => void): Promise<string | null> {
  const e2e = cfg.e2e
  if (!e2e) return 'no e2e stack configured'
  const down = async () => {
    const out: string[] = []
    for (const [name, port] of Object.entries(e2e.ports)) if (!(await portOpen(port))) out.push(`${name} :${port}`)
    return out
  }
  let missing = await down()
  if (!missing.length) return null
  onStep(`starting the e2e stack (${missing.join(', ')} down)`)
  try {
    await sh('bash', ['-lc', e2e.up], cfg.repo.path, 10 * 60_000)
  } catch (error) {
    const e = error as { stderr?: string; message?: string }
    return `the e2e stack did not start (${e2e.up}): ${tail(e.stderr || e.message || 'no output', 5)}`
  }
  missing = await down()
  return missing.length ? `the e2e stack is still down (${missing.join(', ')})` : null
}

async function runE2e(d: Deps, app: E2eApp, specs: readonly string[]): Promise<Step> {
  const name = `e2e ${app.name}`
  const started = Date.now()
  const down = await stackUp(d.cfg, d.onStep)
  if (down) return { name, ok: null, tail: '', note: `not run: ${down}` }
  // a port nothing listens on, near the ticket's own
  let port = d.port + 700
  while (await portOpen(port)) port++
  d.onStep(`e2e ${app.name}: starting the app on :${port}`)
  const logs = d.logDir ? (mkdirSync(d.logDir, { recursive: true }), d.logDir) : null
  const devFile = logs ? path.join(logs, `e2e-${app.name}-dev.log`) : null
  const runFile = logs ? path.join(logs, `e2e-${app.name}.log`) : null
  if (devFile) writeFileSync(devFile, `$ ${app.dev.replace('{port}', String(port))}\n`)
  const dev = spawn('bash', ['-lc', app.dev.replace('{port}', String(port))], { cwd: d.worktree, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
  let devLog = ''
  const keep = (b: Buffer) => {
    devLog = (devLog + b.toString()).slice(-6000)
    if (devFile) appendFileSync(devFile, b)
  }
  dev.stdout.on('data', keep)
  dev.stderr.on('data', keep)
  const stopDev = () => {
    try {
      if (dev.pid) process.kill(-dev.pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
  try {
    const up = await waitForDev(port, dev, () => devLog, 120_000, () => Boolean(d.signal?.aborted))
    if (!up) {
      if (d.signal?.aborted) return { name, ok: null, tail: '', note: 'stopped before it ran' }
      const why = dev.exitCode !== null ? `exited with ${dev.exitCode}` : 'no answer after 2 minutes'
      return { name, ok: false, tail: tail(devLog) || '(the dev server printed nothing)', note: `the ${app.name} dev server did not come up on :${port} (${why})${devFile ? `; log: ${devFile}` : ''}` }
    }
    port = up.port
    const own = path.join(d.worktree, 'e2e', '.env')
    const envFile = app.envFile ? path.join(d.worktree, app.envFile) : null
    const extra = !existsSync(own) && envFile && existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}
    d.onStep(`e2e ${app.name}: ${specs.join(', ')}`)
    const cmd = app.test.replace('{specs}', specs.map((s) => `'${s.replace(/'/g, '')}'`).join(' '))
    try {
      if (runFile) writeFileSync(runFile, `$ ${cmd}\n`)
      const { stdout, stderr } = await runWithEnv(cmd, d.worktree, { ...extra, [app.urlEnv]: `http://localhost:${port}` }, d.cfg.localChecks.e2eMinutes * 60_000, d.signal, runFile)
      return { name, ok: true, tail: tail(`${stdout}\n${stderr}`), seconds: Math.round((Date.now() - started) / 1000) }
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean }
      if (d.signal?.aborted) return { name, ok: null, tail: '', note: 'stopped before it finished' }
      const timedOut = e.killed
      const full = runFile && existsSync(runFile) ? readFileSync(runFile, 'utf8') : `${e.stdout ?? ''}\n${e.stderr ?? e.message ?? ''}`
      return { name, ok: false, tail: e2eTail(full), seconds: Math.round((Date.now() - started) / 1000), ...(timedOut ? { note: `stopped after ${d.cfg.localChecks.e2eMinutes} minutes` } : runFile ? { note: `full output: ${runFile}` } : {}) }
    }
  } finally {
    stopDev()
  }
}

function runWithEnv(cmd: string, cwd: string, env: Record<string, string>, timeoutMs: number, signal?: AbortSignal, logFile?: string | null): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-lc', cmd], { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let killed = false
    const kill = () => {
      killed = true
      try {
        if (child.pid) process.kill(-child.pid, 'SIGTERM')
      } catch {
        // already gone
      }
    }
    const timer = setTimeout(kill, timeoutMs)
    signal?.addEventListener('abort', kill, { once: true })
    child.stdout.on('data', (b: Buffer) => {
      stdout = (stdout + b.toString()).slice(-20000)
      if (logFile) appendFileSync(logFile, b)
    })
    child.stderr.on('data', (b: Buffer) => {
      stderr = (stderr + b.toString()).slice(-20000)
      if (logFile) appendFileSync(logFile, b)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', kill)
      if (code === 0) resolve({ stdout, stderr })
      else reject(Object.assign(new Error(`exit ${code}`), { stdout, stderr, killed }))
    })
  })
}

export function failedSummary(lc: Pick<LocalChecks, 'steps'>): string {
  return lc.steps
    .filter((s) => s.ok === false)
    .map((s) => s.name)
    .join(', ')
}
