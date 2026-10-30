import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Health, Ticket } from '@ticketflow/shared'
import { classify } from './classifier.js'
import { loadConfig, loadEnv } from './config.js'
import { Linear, type LinearIssue } from './linear.js'
import { computeDigest, formatDigest, scheduleDaily } from './digest.js'
import { HealthTracker } from './health.js'
import { LinearWriter } from './linear-writer.js'
import { LiveLog } from './live-log.js'
import { MainSync } from './main-sync.js'
import { writePending } from './pending.js'
import { budgetStatus, newAlerts } from './budget.js'
import { Reviews } from './reviews.js'
import { log } from './log.js'
import { PrSync } from './pr-sync.js'
import { ticketDiff, openInEditor } from './runner/diff.js'
import { GithubBrowser } from './github-browser.js'
import { Learnings } from './learnings.js'
import { livePrBody } from './runner/github.js'
import { Runner } from './runner/index.js'
import { startServer } from './server.js'
import { Store } from './store.js'
import { Telegram } from './telegram/index.js'
import { Tunnel } from './tunnel.js'
import { sources, syncKnowledge } from './knowledge.js'
import { Assistant } from './assistant.js'
import { registerAssistant } from './telegram/assistant.js'

const env = loadEnv()
const cfg = loadConfig(env.rootDir)
const store = new Store(env.dataDir)
const live = new LiveLog()
const linear = new Linear(env.linearApiKey, cfg.linear)
linear.onLabelColors = (colors) => store.setLabelColors(colors)
const health = new HealthTracker(cfg)
const writer = new LinearWriter(cfg, linear, store)

// Telegram and Runner reference each other; the notifier object breaks the cycle.
let telegram: Telegram
const runner = new Runner(cfg, store, linear, {
  reviewReady: async (t) => {
    await telegram.notifier.reviewReady(t)
    await writer.comment('review_ready', t)
  },
  needsInput: (t) => telegram.notifier.needsInput(t),
  prOpened: async (t) => {
    await telegram.notifier.prOpened(t)
    await writer.comment('pr_opened', t)
  },
  failed: async (t) => {
    await telegram.notifier.failed(t)
    await writer.comment('failed', t)
  },
  noChange: async (t) => {
    await telegram.notifier.noChange(t)
    await writer.comment('no_change', t)
  },
  greptileDeclined: (t) => telegram.notifier.greptileDeclined(t),
  visualDone: (t) => telegram.notifier.visualDone(t),
  descReady: (t) => telegram.notifier.descReady(t),
  previewQaDone: (t) => telegram.notifier.previewQaDone(t),
  uploads: (ok, detail) => {
    health.uploads = { ...(ok ? health.ok() : health.bad(detail)), detail, login: health.uploads.login }
    if (!ok && /signed out/.test(detail)) void telegram.sendPlain('🔐 metwo’s GitHub browser is signed out, so screenshots went to the gist. Send /ghlogin (or Health → Sign in) at the Mac to fix it.')
  },
  claudeState: (ok, detail) => health.markClaudeFromLane(ok ? { ...health.ok(), detail } : health.bad(detail)),
  progress: (t, kind, line) => live.push(t.id, kind, line),
})
runner.budget = () => budgetStatus(runner.config, store, runner.engineList.map((e) => e.id))
telegram = new Telegram(env.telegramToken, env.telegramChatId, store, runner, live, health)
const learnings = new Learnings(env.rootDir, env.dataDir, cfg)
runner.learnings = learnings

// The curator's daily pass; also run on demand from the app or /learn.
async function curate(): Promise<number> {
  const curator = runner.config.roles.curator
  const role = runner.resolve(curator === 'off' ? 'claude' : curator, null, cfg.models.review.model)
  if (!role) throw new Error('no engine for the curator')
  const n = await learnings.run(role.engine, role.model, store.all(), path.join(env.dataDir, 'logs'))
  if (n > 0) await telegram.notifyLearnings(learnings.view().proposals)
  return n
}

const githubBrowser = cfg.github.screenshots === 'browser' ? new GithubBrowser(path.join(env.dataDir, 'github-profile')) : null
runner.browser = githubBrowser

// Opens a visible Chrome on github.com/login on this Mac; the profile keeps the session.
async function githubLogin(): Promise<string> {
  if (!githubBrowser) throw new Error('github.screenshots is not "browser"')
  health.uploads = { ok: null, detail: 'sign in in the Chrome window on the Mac, then close it', at: new Date().toISOString(), login: null }
  try {
    const login = await githubBrowser.signIn()
    health.uploads = { ...health.ok(), detail: 'signed in', login }
    return login
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    health.uploads = { ...health.bad(message), login: null }
    throw error
  }
}
const prSync = new PrSync(cfg, store, {
  prComments: (t, c) => telegram.notifier.prComments(t, c),
  prCi: (t) => telegram.notifier.prCi(t),
  prMerged: (t) => telegram.notifier.prMerged(t),
  greptile: (t) => telegram.notifier.greptile(t),
  outsidePush: (t) => telegram.notifier.outsidePush(t),
  qaRequested: (t) => telegram.notifier.qaRequested(t),
})
prSync.onResult = (ok, detail) => {
  health.prSync = ok ? { ...health.ok(), detail } : health.bad(detail)
}
const mainSync = new MainSync(cfg, store, runner)
mainSync.onResult = (ok, detail) => {
  health.mainSync = ok ? { ...health.ok(), detail } : health.bad(detail)
}
mainSync.onUpdated = (t, outcome) => void telegram.sendPlain(`⬇️ ${t.id}: updated from ${cfg.repo.baseBranch}${outcome === 'pushed' ? ' and pushed' : outcome === 'lane' ? ', the lane is fixing what broke' : ''}`)

const reviews = new Reviews(cfg, store, runner, linear, {
  requested: (r) => telegram.notifier.reviewRequested(r),
  reviewed: (r) => telegram.notifier.reviewDone(r),
  failed: (r) => telegram.notifier.reviewFailed(r),
  moved: (r) => telegram.notifier.reviewMoved(r),
  progress: (id, kind, line) => live.push(id, kind, line),
})
const assistant = new Assistant({ store, runner, reviews, dataDir: env.dataDir, cycle: () => linear.cycleView(), assign: (ids) => assignAndTrack(ids), autopilotStart: (id) => autopilotStart(id) })
reviews.onResult = (ok, detail) => {
  health.reviews = ok ? { ...health.ok(), detail } : health.bad(detail)
}

// Stop everything: lanes killed, RESUME.md per ticket, data/pending.md with the rest.
async function stopEverything(shutdown: boolean): Promise<{ stopped: readonly string[]; pending: string }> {
  const stopped = await runner.stopAll(shutdown ? 'daemon shut down by you' : 'stop all', true)
  if (reviews.activeId) reviews.stop(reviews.activeId)
  const pending = writePending(env.dataDir, store.all(), shutdown ? 'stopped everything and shut down' : 'stopped everything')
  if (shutdown) {
    await telegram.sendPlain(`⏹ metwo stopped ${stopped.length} lane(s) and is shutting down. Pending work is in ${pending}.`)
    setTimeout(() => process.exit(0), 500)
  }
  return { stopped, pending }
}

// One warning per quiet spell for lanes that have said nothing for a while.
const warnedQuiet = new Map<string, number>()
function watchQuiet(): void {
  const limit = cfg.pipeline.stuckMinutes * 60_000
  for (const id of runner.activeIds) {
    const a = runner.activity(id)
    const t = store.get(id)
    if (!a || !t) continue
    const quiet = Date.now() - a.at
    if (quiet < limit) {
      warnedQuiet.delete(id)
    } else if (warnedQuiet.get(id) !== a.at) {
      warnedQuiet.set(id, a.at)
      void telegram.notifier.quiet(t, Math.round(quiet / 60_000), a.line)
    }
  }
}
// Each enabled engine: installed, signed in, and which roles it holds right now.
let engineHealth: NonNullable<Health['lanes']['engines']> = []
async function probeEngines(): Promise<void> {
  const roleOf = (e: string) => {
    const roles: string[] = []
    const cfg = runner.config
    const claudeImpl = (ref: string) => runner.resolve(ref, null, cfg.models.lite.model)?.engine.id
    if (claudeImpl(cfg.roles.implementer.lite) === e) roles.push('lite')
    if (claudeImpl(cfg.roles.implementer.full) === e) roles.push('full')
    if (runner.resolve(cfg.roles.reviewer, 'claude', cfg.models.review.model)?.engine.id === e) roles.push('reviewer')
    if (runner.resolve(cfg.roles.supervisor, 'claude', cfg.models.review.model)?.engine.id === e) roles.push('supervisor of Claude work')
    if (runner.resolve(cfg.roles.visual, null, cfg.models.review.model)?.engine.id === e) roles.push('visual check')
    if (runner.resolve(cfg.roles.curator, null, cfg.models.review.model)?.engine.id === e) roles.push('curator')
    if (e !== 'claude' && runner.budget().fallback?.split(':')[0] === e) roles.push(cfg.budget.planFirst === 'off' ? 'when the budget runs low' : `${cfg.budget.planFirst === 'all' ? 'every' : 'lite'} lane first, to save budget`)
    return roles
  }
  engineHealth = await Promise.all(runner.engineList.map(async (e) => ({ id: e.id, label: e.label, ...(await e.health()), roles: roleOf(e.id) })))
}

const healthSnapshot = () => health.snapshot({
    engines: engineHealth,
    active: runner.activeIds,
    max: runner.maxParallel,
    paused: runner.paused,
    stuckMinutes: cfg.pipeline.stuckMinutes,
    budget: runner.budget(),
    autopilot: { ...runner.config.autopilot, today: store.all().filter((t) => t.autopilot && new Date(t.autopilot.at).toDateString() === new Date().toDateString()).length },
    effort: runner.effort,
    models: {
      lite: { ...cfg.models.lite, effort: runner.effort },
      full: { ...cfg.models.full, effort: runner.effort },
      review: { ...cfg.models.review, effort: runner.effort },
    },
  })

// A tiny real run in a scratch folder: proves the CLI, the login and metwo's parsing all work.
async function testEngine(id: string): Promise<{ ok: boolean; text: string; model: string | null; seconds: number; detail: string }> {
  const engine = runner.engineList.find((e) => e.id === id)
  if (!engine) throw new Error(`${id} is not enabled`)
  const dir = mkdtempSync(path.join(os.tmpdir(), 'metwo-engine-test-'))
  const started = Date.now()
  try {
    const model = runner.resolve(id, null, cfg.models.lite.model)?.model ?? ''
    const r = await engine.run({ cwd: dir, prompt: 'Reply with exactly: metwo ok', model, effort: 'low', logFile: path.join(env.dataDir, 'logs', `engine-test-${id}.jsonl`) })
    const ok = r.exitCode === 0 && /metwo ok/i.test(r.text)
    return { ok, text: r.text.slice(0, 300), model: r.model, seconds: Math.round((Date.now() - started) / 100) / 10, detail: ok ? 'works' : r.exitCode !== 0 ? `exit ${r.exitCode}: ${r.stderr.split('\n').at(-1) ?? ''}` : 'ran, but the reply was not parsed; check the log' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Assign in Linear, then poll right away so the tickets land on the board (and in Telegram).
async function assignAndTrack(ids: readonly string[]) {
  const result = await linear.assignToMe(ids)
  if (result.assigned.length > 0) await poll()
  return result
}

const branchFor = (id: string) => cfg.repo.branchPattern.replace('{id}', id)

async function poll(): Promise<void> {
  let issues: readonly LinearIssue[]
  try {
    issues = await linear.myOpenIssues()
    health.linear = { ...health.ok(), detail: `${issues.length} open issue(s) assigned to you`, lastPollAt: new Date().toISOString(), tracked: Object.keys(store.snapshot().tickets).length }
  } catch (error) {
    log.warn('linear poll failed', error)
    health.linear = { ...health.bad(error instanceof Error ? error.message : String(error)), lastPollAt: health.linear.lastPollAt, tracked: health.linear.tracked }
    return
  }
  for (const issue of issues) {
    const known = store.get(issue.id)
    // not started yet: move it to the current naming; started ones keep their branch and PR
    if (known && !known.worktree && known.branch !== branchFor(issue.id)) store.patch(issue.id, { branch: branchFor(issue.id) })
    if (known) {
      if (known.linearState !== issue.state || known.title !== issue.title) {
        store.patch(issue.id, { linearState: issue.state, title: issue.title, labels: issue.labels })
      }
      continue
    }
    const c = classify(issue, cfg.classifier, runner.config.autopilot.enabled)
    const now = new Date().toISOString()
    const ticket: Ticket = {
      ...issue,
      branch: branchFor(issue.id),
      linearState: issue.state,
      seenAt: now,
      updatedAt: now,
      status: 'assigned',
      decision: c.decision,
      suggestedLane: c.lane,
      reason: c.reason,
      small: c.small,
      events: [{ at: now, kind: 'seen', message: `assigned in Linear (${issue.state}); ${c.decision}/${c.lane}: ${c.reason}` }],
    }
    store.upsert(ticket)
    log.info(`new ${issue.id} ${issue.title} → ${c.decision}/${c.lane} (${c.reason})`)
    if (c.decision !== 'auto' || !(await autopilotStart(issue.id))) await telegram.notifyNew(ticket)
  }
  // tickets that came in before autopilot was turned on, while it was over its daily cap, or over budget
  if (runner.config.autopilot.enabled) {
    const since = store.snapshot().settings?.autopilot?.since ?? ''
    for (const t of store.byStatus('assigned')) if (t.small && !t.autopilot && t.seenAt >= since) await autopilotStart(t.id, true)
  }
  runner.pump()
  void nudgeWhenIdle()
}

// Autopilot takes a small ticket: in its daily cap, and only when the budget leaves an engine to
// run it on. Returns false when it left the ticket for you.
async function autopilotStart(id: string, quiet = false): Promise<boolean> {
  const ap = runner.config.autopilot
  const today = new Date().toDateString()
  const taken = store.all().filter((t) => t.autopilot && new Date(t.autopilot.at).toDateString() === today).length
  const b = runner.budget()
  const blocked = taken >= ap.maxPerDay ? `autopilot already took ${taken} today (max ${ap.maxPerDay})` : b.regulate && b.level === 'over' && !b.fallback ? 'over budget and no fallback engine enabled' : null
  if (blocked) {
    if (!quiet) store.journal(id, { kind: 'note', title: 'Autopilot left this one for you', body: blocked })
    return false
  }
  runner.enqueue(id, 'lite')
  const t = store.patch(id, { autopilot: { at: new Date().toISOString() } }, { kind: 'decision', message: 'started by autopilot' })
  store.journal(id, { kind: 'note', title: 'Started by autopilot', body: t.reason })
  await telegram.notifyAutoStarted(t)
  return true
}

// Budget alerts at 50, 80 and 100 % of the daily and monthly limits, once each per period.
async function watchBudget(): Promise<void> {
  const b = runner.budget()
  for (const a of newAlerts(b, store.snapshot().settings?.alerts ?? {})) {
    store.setSettings({ alerts: { [a.key]: a.pct } })
    const what = a.pct >= 100 ? (b.regulate ? (b.fallback ? `new lanes move to ${b.fallback}; Claude only when you start a ticket yourself` : 'no fallback engine is enabled, so autopilot stops; your own starts still run on Claude') : 'regulation is off, nothing changes') : a.pct >= 80 ? 'lanes run at lower effort and lite skips the review pass' : 'heads up'
    await telegram.sendPlain(`💸 budget ${a.pct}% ${a.label}: $${a.spent.toFixed(2)} of $${a.limit}. ${what}.`)
  }
}

// Once a day, when nothing is waiting or running, offer the current cycle.
let nudgedOn = ''
async function nudgeWhenIdle(): Promise<void> {
  const busy = store.byStatus('assigned', 'queued', 'running', 'needs_input', 'review_ready', 'stopped').length > 0
  const today = new Date().toDateString()
  if (busy || nudgedOn === today || store.all().length === 0) return
  nudgedOn = today
  await telegram.sendPlain('🫙 nothing pending on your side. Here is what is open in the cycle:')
  await telegram.sendCycle()
}

async function main(): Promise<void> {
  log.info(`metwo daemon · repo ${cfg.repo.path} · knowledge ${sources(cfg).map((k) => k.name).join(', ') || 'none'}`)
  registerAssistant(telegram, assistant)
  await telegram.start()
  if (cfg.server.tunnel && !env.dashboardToken) {
    throw new Error('server.tunnel is on but DASHBOARD_TOKEN is empty; refusing to expose the dashboard without auth')
  }
  telegram.healthSnapshot = healthSnapshot
  telegram.linearWriter = writer
  startServer(cfg.server.port, env.rootDir, store, runner, live, env.dashboardToken, reviews, {
    health: healthSnapshot,
    poll: () => poll(),
    refresh: async () => {
      await Promise.allSettled([poll(), prSync.tick()])
    },
    restartBot: () => telegram.restart(),
    moveInLinear: (id, to) => writer.move(id, to),
    note: (id, text) => {
      store.journal(id, { kind: 'note', title: 'Note', body: text })
    },
    probe: async () => {
      await Promise.all([health.probe(), probeEngines()])
    },
    testEngine: (id) => testEngine(id),
    learnings: () => learnings.view(),
    curate: () => curate(),
    decideLearning: (id, approve, text) => learnings.decide(id, approve, text),
    removeRule: (rule) => learnings.removeRule(rule),
    issueView: async (id) => {
      const t = store.get(id)
      if (!t) throw new Error(`unknown ticket ${id}`)
      return linear.issueView(t.uuid)
    },
    linearFile: (url) => linear.download(url),
    prView: async (id) => {
      const t = store.get(id)
      if (!t) throw new Error(`unknown ticket ${id}`)
      if (t.prUrl && t.worktree) {
        const live = await livePrBody(t.worktree, t.branch)
        return { source: 'github', body: live.body, url: live.url, media: [] }
      }
      const preview = runner.previewBody(id)
      return { source: 'draft', body: preview.body, url: null, media: preview.media.map((m) => ({ ...m, local: true })) }
    },
    githubLogin: () => void githubLogin().catch(() => undefined),
    cycle: () => linear.cycleView(),
    assign: (ids) => assignAndTrack(ids),
    mediaFile: (id, name) => runner.mediaFile(id, name),
    diff: (id) => {
      const t = store.get(id)
      if (!t?.worktree) throw new Error(`${id} has no worktree yet`)
      return ticketDiff(t.worktree, cfg.repo.baseBranch)
    },
    openEditor: (id) => {
      const t = store.get(id)
      if (!t?.worktree) throw new Error(`${id} has no worktree yet`)
      return openInEditor(t.worktree, cfg.pipeline.editors)
    },
    stopAll: (shutdown) => stopEverything(shutdown),
    today: () => assistant.today(),
    triage: (force) => assistant.triage(force),
    ask: (q, history) => assistant.ask(q, history),
    runActions: (actions) => assistant.run(actions),
    settings: () => {
      const pick = (c: typeof cfg) => ({ autopilot: c.autopilot, triage: c.triage, budget: c.budget, engines: c.engines, roles: { ...c.roles }, pipeline: { effort: c.pipeline.effort, maxParallel: c.pipeline.maxParallel } })
      return { overrides: store.snapshot().settings ?? {}, effective: pick(runner.config), defaults: pick(cfg) }
    },
  })
  if (cfg.roles.curator !== 'off') scheduleDaily(cfg.roles.curatorAt, () => curate().then(() => undefined, (e: unknown) => log.warn('curator failed', e)))
  telegram.curate = curate
  telegram.learnings = learnings
  if (cfg.pipeline.digestAt) {
    scheduleDaily(cfg.pipeline.digestAt, () => telegram.sendPlain(formatDigest(computeDigest(store.all()))))
  }
  if (cfg.server.tunnel && env.dashboardToken) {
    const token = env.dashboardToken
    const tunnel = new Tunnel(cfg.server.port, (url) => {
      health.tunnel = { ...health.ok(), detail: 'up', url }
      void telegram.sendPlain(`📱 dashboard: ${url}/?t=${token}`)
    })
    health.tunnel = { ok: null, detail: 'starting', at: null, url: null }
    telegram.dashboardLink = () => (tunnel.url ? `${tunnel.url}/?t=${token}` : null)
    tunnel.start()
    process.on('exit', () => tunnel.stop())
  }
  // A restart (tsx watch, the app's Stop, Ctrl-C) kills the lanes and parks them with a RESUME.md,
  // instead of leaving them running headless or losing where they were.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (reviews.activeId) reviews.stop(reviews.activeId)
      const parked = runner.shutdown('the daemon was stopped')
      writePending(env.dataDir, store.all(), `daemon stopped (${sig})`)
      if (parked.length) log.info(`parked ${parked.join(', ')}`)
      setTimeout(() => process.exit(0), 1500)
    })
  }
  // Mid-run when the daemon died without a clean stop: parked too, so Resume can pick them up.
  const interrupted = store.byStatus('running')
  for (const t of interrupted) runner.recover(t.id)
  const parked = store.byStatus('stopped')
  if (parked.length) {
    writePending(env.dataDir, store.all(), 'daemon started')
    await telegram.notifyStopped(parked)
  }
  void health.probe()
  setInterval(() => void health.probe(), 60_000)
  void probeEngines()
  setInterval(() => void probeEngines(), 5 * 60_000)
  if (githubBrowser) {
    githubBrowser
      .status()
      .then((login) => {
        health.uploads = login ? { ...health.ok(), detail: 'signed in', login } : { ...health.bad('not signed in yet: Health → Sign in, or /ghlogin'), login: null }
      })
      .catch((error: unknown) => {
        health.uploads = { ...health.bad(`browser did not start: ${error instanceof Error ? error.message : String(error)}`), login: null }
      })
  }
  telegram.githubLogin = githubLogin
  telegram.stopAll = (shutdown) => stopEverything(shutdown)
  telegram.reviews = reviews
  telegram.cycle = () => linear.cycleView()
  telegram.assign = (ids) => assignAndTrack(ids)
  await poll()
  setInterval(() => void poll(), cfg.pipeline.pollMs)
  void prSync.tick()
  setInterval(() => void prSync.tick(), cfg.pipeline.prSyncMs)
  void reviews.tick()
  setInterval(() => void reviews.tick(), cfg.pipeline.prSyncMs)
  void mainSync.tick()
  setInterval(() => void mainSync.tick(), cfg.pipeline.mainSyncMinutes * 60_000)
  setInterval(watchQuiet, 60_000)
  void watchBudget()
  // with triage.auto: the cycle a minute after start and every few hours; cached per issue
  const autoTriage = () => void (runner.config.triage.auto ? assistant.triage().catch((e: unknown) => log.warn('triage failed', e)) : undefined)
  setTimeout(autoTriage, 60_000)
  setInterval(autoTriage, 3 * 3_600_000)
  setInterval(() => void watchBudget(), 60_000)
  const syncDocs = () => void syncKnowledge(cfg).then((problems) => problems.forEach((p) => log.warn(`knowledge sync failed: ${p}`)))
  if (cfg.knowledge.sources.some((k) => k.git)) {
    syncDocs()
    setInterval(syncDocs, Math.max(1, cfg.knowledge.syncHours) * 3_600_000)
  }
  // engines turned on or off in Settings show up in Health right away
  store.on('settings', () => void probeEngines())
}

main().catch((error) => {
  log.error('fatal', error)
  process.exit(1)
})
