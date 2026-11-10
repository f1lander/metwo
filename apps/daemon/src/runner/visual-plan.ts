import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import type { TestCheckKind, TestPlan, TestStep, Ticket, VisualPlanView } from '@ticketflow/shared'
import { type Config, SHOT_DEFAULTS } from '../config.js'
import { type AppServer, linkModules, startApp } from './app-server.js'
import { cleanSteps } from './human-test.js'
import { git, sh } from './shell.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// VISUAL-PLAN.json: the lane's test steps, in the hand test's shape plus what mevo needs to run
// them (`do`), which screenshots to take (`shot`) and the criterion each one proves.
export interface VisualStep extends TestStep {
  readonly do?: string
  readonly shot?: { readonly viewports: readonly ('desktop' | 'mobile')[]; readonly before?: boolean }
  readonly proves?: string
}
export interface VisualPlan {
  readonly app?: string
  readonly steps: readonly VisualStep[]
}
export interface RunStep {
  readonly id: string
  readonly title: string
  readonly status: 'passed' | 'failed' | 'skipped'
  readonly shots: readonly string[]
  readonly start: number
  readonly end: number
  readonly error?: string
  readonly failShot?: string
  readonly url?: string
  readonly detail?: string
}
export interface RunReport {
  readonly prefix: 'after' | 'before'
  readonly ok: boolean
  readonly steps: readonly RunStep[]
  readonly errors: readonly string[]
  readonly video?: string
}

export const planFile = (flowDir: string) => path.join(flowDir, 'VISUAL-PLAN.json')
export const runDir = (flowDir: string) => path.join(flowDir, 'visual-run')

export function readVisualPlan(flowDir: string): VisualPlan | null {
  const file = planFile(flowDir)
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { app?: unknown; steps?: unknown }
    const list = Array.isArray(raw.steps) ? (raw.steps as Record<string, unknown>[]) : []
    const base = cleanSteps(list)
    const steps = base.map((s, i): VisualStep => {
      const r = list[i] ?? {}
      const shot = r.shot && typeof r.shot === 'object' ? (r.shot as { viewports?: unknown; before?: unknown }) : null
      const viewports = Array.isArray(shot?.viewports) ? shot.viewports.filter((v): v is 'desktop' | 'mobile' => v === 'desktop' || v === 'mobile') : []
      return {
        ...s,
        ...(typeof r.id === 'string' && /^[\w-]{1,20}$/.test(r.id) ? { id: r.id } : {}),
        ...(typeof r.do === 'string' && r.do.trim() ? { do: r.do.slice(0, 4000) } : {}),
        ...(shot ? { shot: { viewports: viewports.length ? viewports : ['desktop'], ...(shot.before === true ? { before: true } : {}) } } : {}),
        ...(typeof r.proves === 'string' ? { proves: r.proves.slice(0, 40) } : {}),
      }
    })
    return steps.length ? { ...(typeof raw.app === 'string' ? { app: raw.app } : {}), steps } : null
  } catch {
    return null
  }
}

// the round when the steps failed and the AI took the screenshots itself
export const fallbackFile = (flowDir: string) => path.join(runDir(flowDir), 'FALLBACK')
export const fellBack = (flowDir: string) => existsSync(fallbackFile(flowDir))

export function planView(flowDir: string): VisualPlanView | null {
  const plan = readVisualPlan(flowDir)
  if (!plan) return null
  const after = readRun(flowDir, 'after')
  const before = readRun(flowDir, 'before')
  return {
    ok: after ? after.ok : null,
    fellBack: fellBack(flowDir),
    steps: plan.steps.map((s, i) => {
      const r = after?.steps.find((x) => x.id === s.id) ?? after?.steps[i]
      const b = before?.steps.find((x) => x.id === s.id) ?? before?.steps[i]
      return {
        id: s.id,
        title: s.title,
        expect: s.expect,
        check: s.check,
        shots: r?.shots ?? [],
        before: b?.shots ?? [],
        ...(s.go ? { go: s.go } : {}),
        ...(s.do ? { do: s.do } : {}),
        ...(s.shot ? { shot: s.shot } : {}),
        ...(s.proves ? { proves: s.proves } : {}),
        ...(r ? { status: r.status } : {}),
        ...(r?.error ? { error: r.error } : {}),
        ...(r?.failShot ? { failShot: `run--${r.failShot}` } : {}),
      }
    }),
  }
}

export function readRun(flowDir: string, prefix: 'after' | 'before' = 'after'): RunReport | null {
  const file = path.join(runDir(flowDir), `RUN-${prefix}.json`)
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as RunReport) : null
  } catch {
    return null
  }
}

// Runs the plan against an app that is already up (or starts it). The shots replace the previous
// run's shots with the same prefix.
export async function runPlan(o: {
  cfg: Config
  worktree: string
  flowDir: string
  plan: VisualPlan
  prefix: 'after' | 'before'
  port: number
  stage: (s: string) => void
  signal?: AbortSignal
  app?: AppServer
}): Promise<RunReport> {
  const dir = runDir(o.flowDir)
  mkdirSync(dir, { recursive: true })
  const shotsDir = path.join(o.flowDir, 'shots')
  // the previous run's screenshots with this prefix go, so stale states never reach the PR
  for (const s of readRun(o.flowDir, o.prefix)?.steps ?? []) for (const f of s.shots) rmSync(path.join(shotsDir, path.basename(f)), { force: true })
  const { wallet } = linkModules(dir, o.worktree, path.resolve(HERE, '..', '..', 'node_modules'))
  copyFileSync(path.join(HERE, 'visual-run.mjs'), path.join(dir, 'run.mjs'))
  const wanted = o.plan.app ? o.cfg.e2e?.apps?.find((a) => a.name === o.plan.app) : undefined
  const app = o.app ?? (await startApp(o.cfg, o.worktree, o.port, o.stage, wanted))
  try {
    const work = path.join(dir, o.prefix)
    rmSync(work, { recursive: true, force: true })
    const out = path.join(dir, `RUN-${o.prefix}.json`)
    const config = path.join(dir, `run-${o.prefix}.json`)
    writeFileSync(config, JSON.stringify({ url: app.url, wallet: wallet && app.rpc ? { rpc: app.rpc } : null, steps: o.plan.steps, prefix: o.prefix, shotsDir, workDir: work, out }))
    o.stage(`running the visual plan (${o.plan.steps.length} steps${o.prefix === 'before' ? ', on the base code' : ''})`)
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(dir, 'run.mjs'), config], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
      let stderr = ''
      child.stderr?.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-3000)))
      readline.createInterface({ input: child.stdout as NodeJS.ReadableStream }).on('line', (line) => {
        try {
          const e = JSON.parse(line) as { type?: string; title?: string; status?: string }
          if (e.type === 'step') o.stage(`visual plan: ${e.title} · ${e.status}`)
        } catch {
          // not ours
        }
      })
      const kill = () => child.kill('SIGTERM')
      o.signal?.addEventListener('abort', kill, { once: true })
      const timer = setTimeout(kill, 10 * 60_000)
      child.on('exit', (code) => {
        clearTimeout(timer)
        o.signal?.removeEventListener('abort', kill)
        if (existsSync(out) && code === 0) resolve()
        else reject(new Error(`the visual plan run ended (${code ?? 'killed'}): ${stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500)}`))
      })
    })
    const report = JSON.parse(readFileSync(out, 'utf8')) as RunReport
    return report
  } finally {
    if (!o.app) app.stop()
  }
}

// A checkout of the base branch, reused by every ticket for before shots. Updated to the latest
// origin/<base> each time and installed when its lockfile changed.
export async function baseCheckout(cfg: Config, stage: (s: string) => void): Promise<string> {
  const dir = path.join(cfg.repo.path, cfg.repo.worktreesDir, '_base')
  const ref = `origin/${cfg.repo.baseBranch}`
  await git(['fetch', 'origin', cfg.repo.baseBranch], cfg.repo.path).catch(() => '')
  if (!existsSync(path.join(dir, '.git'))) {
    stage(`creating a checkout of ${cfg.repo.baseBranch} for before shots`)
    await git(['worktree', 'add', '--detach', dir, ref], cfg.repo.path)
  } else {
    await git(['checkout', '--detach', '--force', ref], dir)
    await git(['clean', '-fd', '-e', 'node_modules', '-e', '.env*', '-e', '.mevo-installed'], dir).catch(() => '')
  }
  const lock = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock'].map((f) => path.join(dir, f)).find((f) => existsSync(f))
  const stamp = path.join(dir, '.mevo-installed')
  const hash = lock ? createHash('sha1').update(readFileSync(lock)).digest('hex') : 'none'
  if (cfg.repo.commands.install && (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== hash)) {
    stage(`installing ${cfg.repo.baseBranch}'s packages for before shots (once per lockfile change)`)
    await sh('bash', ['-lc', cfg.repo.commands.install], dir, 15 * 60_000)
    writeFileSync(stamp, hash)
  }
  // the app's local env files are not in git; the main checkout has them
  for (const f of ['.env', '.env.local']) for (const app of cfg.e2e?.apps ?? []) {
    const rel = path.join('apps', app.name, f)
    if (existsSync(path.join(cfg.repo.path, rel)) && !existsSync(path.join(dir, rel))) copyFileSync(path.join(cfg.repo.path, rel), path.join(dir, rel))
  }
  return dir
}

// The steps that ask for a before shot (and the ones that lead to them), hashed: before shots
// are taken again only when those steps change.
export function beforeKey(plan: VisualPlan): string {
  const last = Math.max(-1, ...plan.steps.map((s, i) => (s.shot?.before ? i : -1)))
  return createHash('sha1').update(JSON.stringify(plan.steps.slice(0, last + 1))).digest('hex')
}

const lines = (run: RunReport, flowDir: string) =>
  run.steps
    .map((s, i) => `${i + 1}. ${s.title}: ${s.status}${s.shots.length ? ` · shots: ${s.shots.map((f) => path.join(flowDir, 'shots', f)).join(', ')}` : ''}${s.error ? ` · error: ${s.error}` : ''}${s.failShot ? ` · what the page showed: ${path.join(runDir(flowDir), run.prefix, s.failShot)}` : ''}${s.url ? ` · at ${s.url}` : ''}`)
    .join('\n')

// After the run: the lane fixes what failed and judges the shots it asked for
export function verdictPrompt(cfg: Config, ticket: Ticket, flowDir: string, run: RunReport, plan: VisualPlan, canFix: boolean): string {
  const expect = plan.steps.map((s, i) => `${i + 1}. ${s.title}${s.expect ? ` — should show: ${s.expect}` : ''}${s.proves ? ` (${s.proves})` : ''}`).join('\n')
  const failed = run.steps.filter((s) => s.status === 'failed')
  return `mevo ran your visual plan (${planFile(flowDir)}) for ${ticket.id} in a real browser${run.steps.some((s) => s.detail) ? ' with the test wallet' : ''}.

The steps and what each should show:
${expect}

What happened:
${lines(run, flowDir)}
${failed.length && canFix ? `\nA step failed. Look at its error and the screenshot of what the page showed. If the step itself is wrong (a selector, a route, a timing, a state it assumed), fix it in VISUAL-PLAN.json: mevo runs the plan once more after this turn. Don't change the code: when the app itself is wrong, mark that check fail and say what you saw; the supervisor sends code problems back to the lane.\n` : ''}${failed.length && !canFix ? '\nA step failed; record it in the verdict, do not change code now.\n' : ''}
Then open every screenshot listed above with the Read tool and judge each against what its step
should show. Write ${path.join(flowDir, 'VISUAL.json')}: one check per step that took screenshots,
"what" = what it should show, "shot" = its first screenshot's file name, "result" = pass only
when you saw it in the screenshot, fail when the screenshot shows something else, not_checked
when the step failed or took no shot. "viewports" = the viewports the shots used. "verified"
only when every check passed. Don't take other screenshots${(cfg.shots ?? SHOT_DEFAULTS).stories ? ` (story shots excepted, at most ${(cfg.shots ?? SHOT_DEFAULTS).stories})` : ''}. No push, no network writes.`
}

// When the lane can't be asked (it is gone, or the plan was re-run after its verdict): the run's
// failures go into VISUAL.json so a failed step never reads as a pass.
export function markRunInVisual(flowDir: string, run: RunReport): void {
  const file = path.join(flowDir, 'VISUAL.json')
  let visual: { verdict?: string; summary?: string; checks?: { what: string; result: string; shot?: string; note?: string }[]; viewports?: string[] } = {}
  try {
    visual = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  } catch {
    visual = {}
  }
  const failed = run.steps.filter((s) => s.status !== 'passed')
  if (!failed.length) return
  const checks = [...(visual.checks ?? [])]
  for (const s of failed) {
    const at = checks.findIndex((c) => c.what === s.title || (s.shots[0] && c.shot === s.shots[0]))
    const check = { what: s.title, result: 'fail', note: `mevo's run: ${s.status}${s.error ? ` (${s.error.slice(0, 200)})` : ''}` }
    if (at >= 0) checks[at] = { ...checks[at], ...check, what: checks[at]?.what ?? s.title }
    else checks.push(check)
  }
  writeFileSync(file, JSON.stringify({ ...visual, verdict: visual.verdict === 'not_applicable' ? 'not_applicable' : 'partial', summary: `${visual.summary ?? ''}${visual.summary ? ' ' : ''}mevo's last run of the plan: ${failed.length} step(s) did not pass.`.trim(), checks }, null, 2))
}

// The hand test's plan, from the visual plan: no model call
export function testPlanFrom(plan: VisualPlan, sha: string): TestPlan {
  const KIND: readonly TestCheckKind[] = ['url', 'text', 'selector', 'rpc', 'tx', 'clipboard', 'manual']
  return {
    at: new Date().toISOString(),
    sha,
    engine: 'the visual plan',
    where: 'mock',
    whereWhy: 'the steps mevo runs with the test wallet',
    steps: plan.steps.map((s, i) => ({
      id: `s${i + 1}`,
      title: s.title,
      how: s.how || s.title,
      expect: s.expect,
      check: KIND.includes(s.check.kind) ? s.check : { kind: 'manual' },
      ...(s.go ? { go: s.go } : {}),
    })),
  }
}
