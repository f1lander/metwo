import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { setAgentSandbox } from './engines/stream.js'
import { Sessions } from './sessions.js'
import { EngineSetup } from './engine-setup.js'
import os from 'node:os'
import path from 'node:path'
import type { FixLogView, Health, PrMeta, Readiness, Ticket } from '@ticketflow/shared'
import { classify } from './classifier.js'
import { loadConfig, loadEnv, usesStages } from './config.js'
import { pipelineView } from './pipeline-view.js'
import { Linear, type LinearIssue } from './linear.js'
import { GithubIssues } from './github-issues.js'
import { NO_CYCLE, type Tracker } from './tracker.js'
import { computeDigest, formatDigest, scheduleDaily } from './digest.js'
import { HealthTracker } from './health.js'
import { LinearWriter } from './linear-writer.js'
import { LinearSync } from './linear-sync.js'
import { Coffee } from './coffee.js'
import { CodeWatch } from './code-watch.js'
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
import { Leaders } from './leaderboard.js'
import { fetchFrames, figmaLinks, figmaMe } from './figma.js'
import { NightShift } from './nightshift.js'
import { Nudger } from './nudger.js'
import { reviewSummary, rollCallsDue, Slack, textHash } from './slack.js'
import { makeDropUnassigned } from './unassigned.js'
import { feedbackSection, FixLog, learnFromPr, lensSection, reviewedPrs } from './fixlog.js'
import { prMeta } from './runner/github.js'
import { checkPrinciplesUpdate, principlesStatus, syncPrinciples } from './principles.js'
import { Assistant } from './assistant.js'
import { Requests } from './requests.js'
import { ghLogin } from './runner/github.js'
import { label as readinessLabel, ReadinessCheck } from './readiness.js'
import { AndroidDevices } from './runner/android.js'
import { HumanTests } from './runner/human-test.js'
import { registerAssistant } from './telegram/assistant.js'

const env = loadEnv()
// lanes, gates, installs and every other child process inherit process.env: keep the secrets out
for (const key of ['LINEAR_API_KEY', 'TELEGRAM_BOT_TOKEN', 'DASHBOARD_TOKEN', 'FIGMA_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_USER_TOKEN']) delete process.env[key]
const cfg = loadConfig(env.rootDir)
const staged = usesStages(env.rootDir)
const store = new Store(env.dataDir)
const live = new LiveLog()
// the tracker: Linear (needs LINEAR_API_KEY) or GitHub Issues through gh
const linear: Tracker = (() => {
  if (cfg.tracker.kind === 'github') return new GithubIssues(() => cfg)
  if (!env.linearApiKey) throw new Error('missing env LINEAR_API_KEY (or set tracker.kind to "github" in ticketflow.config.json)')
  return new Linear(env.linearApiKey, cfg.linear)
})()
const leaders = new Leaders(cfg.repo.path, linear)
const metaCache = new Map<number, { at: number; meta: PrMeta }>()
linear.onLabelColors = (colors) => store.setLabelColors(colors)
const health = new HealthTracker(cfg)
const writer = new LinearWriter(cfg, linear, store)
const linearSync = new LinearSync(() => runner.config, linear, store)

// Telegram and Runner reference each other; the notifier object breaks the cycle.
let telegram: Telegram
const runner = new Runner(cfg, store, linear, {
  // replays stay on this Mac: no Linear comments, no Telegram buttons that push
  reviewReady: async (t) => {
    if (t.replay) return
    await telegram.notifier.reviewReady(t)
    await writer.comment('review_ready', t)
  },
  needsInput: async (t) => {
    if (!t.replay) await telegram.notifier.needsInput(t)
  },
  prOpened: async (t) => {
    await telegram.notifier.prOpened(t)
    await writer.comment('pr_opened', t)
  },
  failed: async (t) => {
    if (t.replay) return
    await telegram.notifier.failed(t)
    await writer.comment('failed', t)
  },
  noChange: async (t) => {
    if (t.replay) return
    await telegram.notifier.noChange(t)
    await writer.comment('no_change', t)
  },
  greptileDeclined: (t) => telegram.notifier.greptileDeclined(t),
  visualDone: (t) => telegram.notifier.visualDone(t),
  descReady: (t) => telegram.notifier.descReady(t),
  previewQaDone: (t) => telegram.notifier.previewQaDone(t),
  uploads: (ok, detail) => {
    health.uploads = { ...(ok ? health.ok() : health.bad(detail)), detail, login: health.uploads.login }
    if (!ok && /signed out/.test(detail)) void telegram.sendPlain('🔐 mevo’s GitHub browser is signed out, so screenshots went to the gist. Send /ghlogin (or Health → Sign in) at the Mac to fix it.')
  },
  claudeState: (ok, detail) => health.markClaudeFromLane(ok ? { ...health.ok(), detail } : health.bad(detail)),
  progress: (t, kind, line) => live.push(t.id, kind, line),
})
const coffee = new Coffee(() => runner.config, store)
const codeWatch = new CodeWatch(env.rootDir)
runner.codeStale = () => codeWatch.state().stale

// What would be cut off by a restart right now, or null when it is safe.
function busyWith(): string | null {
  if (runner.activeIds.length) return `${runner.activeIds.join(', ')} running`
  if (reviews.activeId) return `the review of ${reviews.activeId}`
  const t = store.all().find((x) => x.localChecks?.status === 'running' || x.previewQa?.status === 'running' || x.humanTests?.some((h) => h.status === 'starting' || h.status === 'running'))
  return t ? `${t.id}'s checks or hand test` : null
}

// Exit with 75: the desktop app starts mevo again at once, on the new code. Lanes cut off by a
// manual restart are parked with their RESUME.md, as on any stop.
let restarting = false
function restartForNewCode(why: string): void {
  if (restarting) return
  restarting = true
  log.info(`restarting to load new code: ${why}`)
  if (reviews.activeId) reviews.stop(reviews.activeId)
  const parked = runner.shutdown('mevo restarted to load new code')
  writePending(env.dataDir, store.all(), 'restarted to load new code')
  void telegram.sendPlain(`♻️ mevo restarted to load new code (${why})${parked.length ? `. Parked ${parked.join(', ')}: Resume picks them up.` : ''}`).catch(() => undefined)
  setTimeout(() => process.exit(75), 1500)
}
runner.canStart = () => coffee.blocked()
store.on('settings', () => coffee.sync())
runner.budget = () => budgetStatus(runner.config, store, runner.engineList.map((e) => e.id))
telegram = new Telegram(env.telegramToken, env.telegramChatId, store, runner, live, health)
// every Telegram message also goes out as a Slack DM when Slack notifications are on
{
  const tg = telegram.notifier
  ;(telegram as unknown as { notifier: typeof tg }).notifier = new Proxy(tg, {
    get: (target, key) => {
      const fn = (target as unknown as Record<string | symbol, unknown>)[key]
      if (typeof fn !== 'function') return fn
      return async (...args: unknown[]) => {
        const out = await (fn as (...a: unknown[]) => unknown).apply(target, args)
        void slack.notify(String(key), args)
        return out
      }
    },
  })
}
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
const prSync = new PrSync(() => runner.config, store, {
  prComments: (t, c) => telegram.notifier.prComments(t, c),
  prCi: (t) => telegram.notifier.prCi(t),
  prMerged: (t) => {
    if (t.pr?.number) learnSoon(t.pr.number, 5_000)
    return telegram.notifier.prMerged(t)
  },
  greptile: (t) => telegram.notifier.greptile(t),
  outsidePush: (t) => telegram.notifier.outsidePush(t),
  prClosed: (t) => telegram.notifier.prClosed(t),
  qaRequested: (t) => telegram.notifier.qaRequested(t),
})
prSync.onConflicting = (id) => void mainSync.checkOne(id)
prSync.onResult = (ok, detail) => {
  health.prSync = ok ? { ...health.ok(), detail } : health.bad(detail)
}
const mainSync = new MainSync(() => runner.config, store, runner)
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
// a nudge to a PR author about your review comments, as a DM from you
reviews.pingAuthor = async (login, emails, name, text) => {
  const id = await slack.findPerson(login, emails, name)
  if (!id) throw new Error(`could not find ${login} in Slack; add their member ID on the review`)
  await slack.dm(id, text)
  return id
}
const phones = new AndroidDevices()
phones.start()
const humanTests = new HumanTests(() => runner.config, store, runner, phones)
const readiness = new ReadinessCheck({ store, runner, dataDir: env.dataDir, issueView: (uuid) => linear.issueView(uuid) })
const assistant = new Assistant({ store, runner, reviews, dataDir: env.dataDir, cycle: () => linear.cycleView?.() ?? Promise.resolve(NO_CYCLE), assign: (ids) => assignAndTrack(ids), autopilotStart: (id) => autopilotStart(id) })
// The team's review knowledge: how each comment on your PRs ended (fixlog.ts).
const fixlog = new FixLog(path.join(env.dataDir, 'knowledge'))
let learning: FixLogView['learning'] = { running: false, done: 0, total: 0, current: null, errors: [] }
const learnQueue: number[] = []
const learn = async (numbers: readonly number[]): Promise<number> => {
  const fresh = numbers.filter((n) => !learnQueue.includes(n) && learning.current !== n)
  learnQueue.push(...fresh)
  learning = { ...learning, total: learning.running ? learning.total + fresh.length : fresh.length, done: learning.running ? learning.done : 0, errors: learning.running ? learning.errors : [] }
  if (learning.running) return fresh.length
  learning = { ...learning, running: true }
  void (async () => {
    while (learnQueue.length) {
      const n = learnQueue.shift() as number
      learning = { ...learning, current: n }
      try {
        const ticketFor = (num: number) => store.all().find((t) => t.pr?.number === num)?.id ?? null
        const got = await learnFromPr({ repo: cfg.repo.path, log: fixlog, greptileBot: cfg.github.greptile.bot, json: (p, name) => assistant.json(p, name), ticketFor, triage: (num) => store.get(ticketFor(num) ?? '')?.commentTriage }, n)
        log.info(`review knowledge: #${n} → ${got} comment(s)`)
        const id = ticketFor(n)
        if (id && got) store.journal(id, { kind: 'note', title: `Learned from ${got} review comment(s) on #${n}`, body: 'Filed in the review knowledge (Learnings): new tickets and your reviews use it.' })
      } catch (error) {
        const id = store.all().find((t) => t.pr?.number === n)?.id
        if (id) store.journal(id, { kind: 'failure', title: `Could not learn from #${n}'s comments`, body: error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error) })
        learning = { ...learning, errors: [...learning.errors, `#${n}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`].slice(-10) }
      }
      learning = { ...learning, done: learning.done + 1 }
    }
    learning = { ...learning, running: false, current: null }
  })()
  return fresh.length
}
runner.extras.feedback = (q) => feedbackSection(fixlog.search(q))
runner.extras.json = (prompt, name) => assistant.json(prompt, name)
// Resolved comments are learned on their own: after a fix round is pushed, after a reply you post,
// and once more when the PR merges. A short wait lets a burst of replies become one pass.
const learnTimers = new Map<number, ReturnType<typeof setTimeout>>()
const learnSoon = (n: number, wait = 90_000) => {
  clearTimeout(learnTimers.get(n))
  learnTimers.set(n, setTimeout(() => {
    learnTimers.delete(n)
    void learn([n])
  }, wait))
}
runner.extras.learnPr = (n) => learnSoon(n)
reviews.feedback = (q) => lensSection(fixlog.search(q, 8))

// Slack and Figma: optional, each switched in Settings → Integrations; their tokens stay here.
const slack = new Slack({
  config: () => runner.config,
  store,
  dataDir: env.dataDir,
  tokens: env.slack,
  appUrl: () => health.tunnel.url ?? null,
  json: (prompt, name) => assistant.sealed(prompt, name),
  telegram: (text) => telegram.sendPlain(text),
})
const nudger = new Nudger(() => runner.config, store, slack)
const nightShift = new NightShift({
  cfg: () => runner.config,
  store,
  slack,
  telegram: (text) => telegram.sendPlain(text),
  json: (prompt, name) => assistant.sealed(prompt, name),
  // Linear comments on your tickets: the thread they are in, and an answer under them
  linear: {
    thread: async (m) => {
      if (!m.linear) return m.text
      const root = m.linear.parent ?? m.linear.comment
      const all = await linear.threadComments(m.linear.issue)
      return all.filter((c) => c.id === root || c.parent === root).map((c) => `${c.author}: ${c.body}`).join('\n\n')
    },
    reply: (m, body) => {
      if (!m.linear) throw new Error('not a Linear comment')
      return linear.reply(m.linear.issue, m.linear.parent ?? m.linear.comment, body)
    },
  },
})
let myLogin = ''
const requests = new Requests({
  cfg: () => runner.config,
  store,
  runner,
  linear,
  slack,
  nightShift,
  json: (prompt, name) => assistant.sealed(prompt, name),
  telegram: (text) => telegram.sendPlain(text),
  me: async () => (myLogin ||= await ghLogin(cfg.repo.path).catch(() => '')),
})
runner.onPushed = (t, head) => requests.onPushed(t, head)
slack.onMessage = (m) => nightShift.onMessage(m)
slack.nightOn = () => nightShift.on()
slack.nightSince = () => (nightShift.on() ? store.nightShift().since : null)
let figmaState: NonNullable<Health['figma']> = { ok: null, detail: env.figmaToken ? 'checking' : 'add FIGMA_TOKEN to .env', at: null, user: null }
const probeFigma = async () => {
  if (!env.figmaToken) return
  figmaState = await figmaMe(env.figmaToken).then(
    (user) => ({ ok: true, detail: `signed in as ${user}`, at: new Date().toISOString(), user }),
    (e: unknown) => ({ ok: false, detail: e instanceof Error ? e.message : String(e), at: new Date().toISOString(), user: null }),
  )
}
if (env.figmaToken) {
  const token = env.figmaToken
  runner.extras.figma = (texts, dir) => fetchFrames(token, figmaLinks(...texts), dir)
}
if (env.slack.userToken || env.slack.botToken) runner.extras.slackThreads = (texts) => slack.threadsFor(texts)
// a PR marked ready (here or on GitHub) goes to the team's channel when announce is on
const announceReady = async (t: Ticket) => {
  if (!runner.config.slack.announce || !t.pr) return
  const meta = await prMeta(t.worktree && existsSync(t.worktree) ? t.worktree : cfg.repo.path, t.pr.number).catch(() => null)
  const where = await slack.announce(t, meta).catch((e: unknown) => {
    log.warn(`${t.id}: slack announce failed`, e)
    return null
  })
  if (where) store.journal(t.id, { kind: 'pr', title: `Posted to Slack ${where}`, meta: { url: t.prUrl ?? '' } })
}
// ready for review (here or on GitHub): the PR goes on the Linear issue, so nobody has to dig for it
const linkReady = async (t: Ticket) => {
  const url = t.pr?.url ?? t.prUrl
  if (!url || !t.uuid) return
  try {
    const links = (await linear.states([t.uuid])).get(t.uuid)?.links ?? []
    if (links.some((l) => l.replace(/(\/pull\/\d+).*$/, '$1') === url.replace(/(\/pull\/\d+).*$/, '$1'))) return
    await linear.linkPr(t.uuid, url, `#${t.pr?.number ?? ''} ${t.title}`.trim())
    store.journal(t.id, { kind: 'linear', title: `Linked the PR to the ${linear.label} issue`, meta: { url } })
  } catch (e) {
    log.warn(`${t.id}: could not link the PR in Linear`, e)
  }
}
runner.onReady = (t) => void Promise.all([announceReady(t), linkReady(t)])
prSync.onReady = (t) => void Promise.all([announceReady(t), linkReady(t)])

reviews.onResult = (ok, detail) => {
  health.reviews = ok ? { ...health.ok(), detail } : health.bad(detail)
}

// Stop everything: lanes killed, RESUME.md per ticket, data/pending.md with the rest.
async function stopEverything(shutdown: boolean): Promise<{ stopped: readonly string[]; pending: string }> {
  const stopped = await runner.stopAll(shutdown ? 'daemon shut down by you' : 'stop all', true)
  if (reviews.activeId) reviews.stop(reviews.activeId)
  const pending = writePending(env.dataDir, store.all(), shutdown ? 'stopped everything and shut down' : 'stopped everything')
  if (shutdown) {
    await telegram.sendPlain(`⏹ mevo stopped ${stopped.length} lane(s) and is shutting down. Pending work is in ${pending}.`)
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
const sessions = new Sessions(env.dataDir)
// secrets agents never get to read (macOS sandbox-exec); see engines/stream.ts
{
  const home = os.homedir()
  const hide = [
    ...['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.config/gcloud', '.azure', '.netrc', '.pgpass'].map((p) => path.join(home, p)),
    ...['Library/Application Support/Google/Chrome', 'Library/Application Support/Arc', 'Library/Application Support/BraveSoftware', 'Library/Application Support/Firefox', 'Library/Cookies', 'Library/Safari'].map((p) => path.join(home, p)),
    path.join(env.rootDir, '.env'),
    // not all of data/: lanes read the synced knowledge in data/knowledge
    ...['state.json', 'sessions.json', 'github-profile', 'history'].map((p) => path.join(env.dataDir, p)),
    ...(cfg.security?.hide ?? []),
  ]
  // opt-in until it has run real lanes (browsers start their own sandbox inside it)
  const result = cfg.security?.sandbox === true ? setAgentSandbox(hide) : 'off (set security.sandbox: true to turn it on)'
  log.info(`agent sandbox ${result}`)
  store.history.record({ type: 'settings', sandbox: result })
}
const engineSetup = new EngineSetup(() => probeEngines(), () => runner.config.pipeline.terminal)
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
  const probed = await Promise.all(runner.engineList.map(async (e) => ({ id: e.id, label: e.label, ...(await e.health()) })))
  runner.setMissing(probed.filter((e) => !e.installed).map((e) => e.id))
  engineHealth = probed.map((e) => ({ ...e, roles: e.installed ? roleOf(e.id) : ['skipped: not installed'] }))
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
    principles: principlesStatus(runner.config),
  })
const fullHealth = (): Health => ({ ...healthSnapshot(), figma: figmaState, slack: slack.state, android: phones.health, code: codeWatch.state() })

// A tiny real run in a scratch folder: proves the CLI, the login and mevo's parsing all work.
async function testEngine(id: string): Promise<{ ok: boolean; text: string; model: string | null; seconds: number; detail: string }> {
  const engine = runner.engineList.find((e) => e.id === id)
  if (!engine) throw new Error(`${id} is not enabled`)
  const dir = mkdtempSync(path.join(os.tmpdir(), 'metwo-engine-test-'))
  const started = Date.now()
  try {
    const model = runner.resolve(id, null, cfg.models.lite.model)?.model ?? ''
    const r = await engine.run({ cwd: dir, prompt: 'Reply with exactly: mevo ok', model, effort: 'low', logFile: path.join(env.dataDir, 'logs', `engine-test-${id}.jsonl`) })
    const ok = r.exitCode === 0 && /mevo ok/i.test(r.text)
    return { ok, text: r.text.slice(0, 300), model: r.model, seconds: Math.round((Date.now() - started) / 100) / 10, detail: ok ? 'works' : r.exitCode !== 0 ? `exit ${r.exitCode}: ${r.stderr.split('\n').at(-1) ?? ''}` : 'ran, but the reply was not parsed; check the log' }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// An issue on the board: new ones are classified and announced, known ones keep their title and state.
async function track(issue: LinearIssue, how = `assigned in ${linear.label} (${issue.state})`): Promise<Ticket> {
  const known = store.get(issue.id)
  // not started yet: move it to the current naming; started ones keep their branch and PR
  if (known && !known.worktree && known.branch !== branchFor(issue.id)) store.patch(issue.id, { branch: branchFor(issue.id) })
  if (known) {
    if (!known.creator && issue.creator) store.patch(issue.id, { creator: issue.creator })
    if (known.linearState !== issue.state || known.title !== issue.title) return store.patch(issue.id, { linearState: issue.state, title: issue.title, labels: issue.labels })
    return known
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
    events: [{ at: now, kind: 'seen', message: `${how}; ${c.decision}/${c.lane}: ${c.reason}` }],
  }
  store.upsert(ticket)
  log.info(`new ${issue.id} ${issue.title} → ${c.decision}/${c.lane} (${c.reason})`)
  if (c.decision === 'auto' && (await autopilotStart(issue.id))) return store.get(issue.id) ?? ticket
  // not for autopilot: read it now so the board says whether it is ready before you start it
  if (runner.config.readiness.auto && readiness.enabled) {
    void readiness
      .check(issue.id)
      .catch(() => null)
      .then(() => telegram.notifyNew(store.get(issue.id) ?? ticket))
  } else {
    await telegram.notifyNew(ticket)
  }
  return store.get(issue.id) ?? ticket
}

// Assign in Linear, then bring each one onto the board, whatever team or cycle it is in.
async function assignAndTrack(ids: readonly string[]) {
  const result = await linear.assignToMe(ids)
  for (const id of result.assigned) {
    const got = await linear.lookup(id).catch(() => null)
    if (got) await track(got.issue, `taken from Linear (${got.found.team}${got.found.project ? ` · ${got.found.project}` : ''})`)
  }
  if (result.assigned.length > 0) await poll()
  return result
}

// A pasted link or id: onto the board, assigned to you unless you only want to track it.
async function importIssue(ref: string, assign: boolean): Promise<Ticket> {
  const got = await linear.lookup(ref)
  if (!got) throw new Error(`no ${linear.label} issue found for "${ref.slice(0, 80)}"`)
  if (assign && !got.found.mine) {
    const r = await linear.assignToMe([got.issue.id])
    if (r.failed.length) throw new Error(r.failed[0]?.error ?? 'could not assign it')
  }
  return track(got.issue, assign ? `taken by link (${got.found.team})` : `added by link (${got.found.team}${got.found.assignee && !got.found.mine ? `, assigned to ${got.found.assignee}` : ''})`)
}

const branchFor = (id: string) => cfg.repo.branchPattern.replace('{id}', id)

const dropUnassigned = makeDropUnassigned(store, (id) => linear.lookup(id), (m) => log.info(m))

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
  for (const issue of issues) await track(issue)
  await dropUnassigned(new Set(issues.map((i) => i.id)))
  // tickets that came in before autopilot was turned on, while it was over its daily cap, or over budget
  if (runner.config.autopilot.enabled) {
    const since = store.snapshot().settings?.autopilot?.since ?? ''
    for (const t of store.byStatus('assigned')) if (t.small && !t.autopilot && t.seenAt >= since) await autopilotStart(t.id, true)
  }
  // assigned tickets: read the ones never checked (two per poll), and re-read the unclear ones
  // when their discussion moves (Linear is asked at most every 10 minutes per ticket)
  if (runner.config.readiness.auto && readiness.enabled) {
    const waiting = store.byStatus('assigned').filter((t) => !t.autopilot)
    const fresh = waiting.filter((t) => !t.readiness && !t.readinessRunning?.error).slice(0, 2)
    const unclear = waiting.filter((t) => t.readiness && t.readiness.verdict !== 'ready')
    for (const t of [...fresh, ...unclear]) void readiness.check(t.id).catch(() => null)
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
  if (runner.config.readiness.auto && readiness.enabled && !readiness.passes(store.get(id)?.readiness)) {
    // a check that failed is retried by Check again, not on every poll
    if (quiet && store.get(id)?.readinessRunning?.error) return false
    void readyThenStart(id, quiet)
    return true
  }
  const noCoffee = coffee.blocked()
  if (noCoffee) {
    if (!quiet) store.journal(id, { kind: 'note', title: 'Autopilot left this one for you', body: noCoffee })
    return false
  }
  runner.enqueue(id, 'lite')
  const t = store.patch(id, { autopilot: { at: new Date().toISOString() } }, { kind: 'decision', message: 'started by autopilot' })
  store.journal(id, { kind: 'note', title: 'Started by autopilot', body: t.reason })
  await telegram.notifyAutoStarted(t)
  return true
}

// Autopilot reads the ticket and its discussion first and starts it only when it is clearly
// ready; otherwise it stays with you, with the questions to ask. Told once per new reading.
async function readyThenStart(id: string, quiet: boolean): Promise<void> {
  const before = store.get(id)?.readiness?.stamp
  let r: Readiness | null = null
  try {
    r = await readiness.check(id)
  } catch (error) {
    if (!quiet) store.journal(id, { kind: 'note', title: 'Autopilot left this one for you', body: `The readiness check failed: ${error instanceof Error ? error.message : String(error)}` })
    const t = store.get(id)
    if (t && !quiet) await telegram.notifyNew(t)
    return
  }
  const t = store.get(id)
  if (!t || t.status !== 'assigned' || t.autopilot) return
  if (!r || readiness.passes(r)) {
    if (r || !readiness.enabled) await autopilotStart(id, quiet)
    return
  }
  if (r.stamp === before && quiet) return
  store.journal(id, { kind: 'note', title: 'Autopilot left this one for you', body: `Readiness: ${readinessLabel(r.verdict)}, ${r.confidence}% (autopilot needs ready and ${runner.config.readiness.minConfidence}%).` })
  await telegram.notifyNew(t)
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
  log.info(`mevo daemon · repo ${cfg.repo.path} · knowledge ${sources(cfg).map((k) => k.name).join(', ') || 'none'}`)
  registerAssistant(telegram, assistant)
  await telegram.start()
  if (cfg.server.tunnel && !env.dashboardToken) {
    throw new Error('server.tunnel is on but DASHBOARD_TOKEN is empty; refusing to expose the dashboard without auth')
  }
  telegram.healthSnapshot = fullHealth
  telegram.linearWriter = writer
  startServer(cfg.server.port, cfg.server.host ?? '127.0.0.1', env.rootDir, store, runner, live, env.dashboardToken, reviews, {
    health: fullHealth,
    poll: () => poll(),
    refresh: async () => {
      await Promise.allSettled([poll(), prSync.tick()])
    },
    restartBot: () => telegram.restart(),
    restartDaemon: () => {
      if (process.env.METWO_SUPERVISED !== '1') return { ok: false, error: 'this daemon was started from a terminal: stop it there (Ctrl-C) and run pnpm daemon again' }
      restartForNewCode('restarted by you')
      return { ok: true }
    },
    moveInLinear: (id, to) => writer.move(id, to),
    note: (id, text) => {
      store.journal(id, { kind: 'note', title: 'Note', body: text })
    },
    probe: async () => {
      await Promise.all([health.probe(), probeEngines()])
    },
    testEngine: (id) => testEngine(id),
    engineSetup,
    sessions,
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
    cycle: () => linear.cycleView?.() ?? Promise.resolve(NO_CYCLE),
    assign: (ids) => assignAndTrack(ids),
    find: (scope, opts) => linear.find?.(scope, opts) ?? Promise.resolve([]),
    projects: (q) => linear.projects?.(q) ?? Promise.resolve([]),
    projectByLink: (link) => linear.projectByLink?.(link) ?? Promise.resolve(null),
    lookup: async (ref) => (await linear.lookup(ref))?.found ?? null,
    importIssue: (ref, assign) => importIssue(ref, assign),
    // a hand test's shots and video, asked for as human--<run>--<file>
    mediaFile: (id, name) => (name.startsWith('human--') ? humanTests.file(id, name.slice(7).replace('--', '/')) : runner.mediaFile(id, name)),
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
    principlesUpdate: () => checkPrinciplesUpdate(runner.config),
    prMeta: async (kind, id) => {
      const number = kind === 'review' ? store.review(id)?.number : store.get(id)?.pr?.number
      if (!number) return null
      const hit = metaCache.get(number)
      if (hit && Date.now() - hit.at < 60_000) return hit.meta
      const t = kind === 'ticket' ? store.get(id) : undefined
      const meta = await prMeta(t?.worktree && existsSync(t.worktree) ? t.worktree : cfg.repo.path, number)
      metaCache.set(number, { at: Date.now(), meta })
      return meta
    },
    leaderboard: (period, fresh) => leaders.get(period, fresh),
    knowledge: {
      view: () => fixlog.view(learning),
      learn: async (prs) => learn(prs?.length ? prs : await reviewedPrs(cfg.repo.path)),
    },
    triageComments: (id, ids) => runner.triageComments(id, ids),
    readiness: (id) => readiness.check(id, true),
    handTest: {
      plan: (id) => humanTests.plan(id),
      savePlan: (id, steps) => humanTests.savePlan(id, steps),
      start: (id, mode, device) => humanTests.start(id, mode, device),
      stop: (id) => humanTests.stop(id),
    },
    phone: {
      watch: (serial, send) => {
        if (!phones.get(serial)) throw new Error('that phone is not connected')
        return phones.screen(serial).watch(send)
      },
      input: (serial, e) => phones.input(serial, e),
    },
    syncPr: (id) => prSync.syncNow(id),
    // you wrote or edited this text in the app and pressed Post: it goes to Linear as your comment
    askInLinear: async (id, text) => {
      const t = store.get(id)
      if (!t) throw new Error(`unknown ticket ${id}`)
      const url = await linear.comment(t.uuid, text)
      store.journal(id, { kind: 'comment', title: 'Asked in Linear', body: text, meta: url ? { url } : {} })
      return url
    },
    linearSync: { check: () => linearSync.check(), fix: (ids) => linearSync.fix(ids) },
    mascot: { sip: (n) => coffee.sip(n), set: (e) => coffee.set(e) },
    slack: {
      mentions: () => store.slackMentions(),
      summarize: async (id) => {
        const m = store.slackMentions().find((x) => x.id === id)
        if (!m) throw new Error('unknown mention')
        return slack.summarize(m)
      },
      // a Linear comment from Night Shift is answered in its Linear thread, as you
      reply: async (id, text) => {
        const m = store.slackMentions().find((x) => x.id === id)
        if (m?.source !== 'linear' || !m.linear) return slack.reply(id, text)
        const url = await linear.reply(m.linear.issue, m.linear.parent ?? m.linear.comment, text)
        store.putSlackMention({ ...m, status: 'done' })
        return url ?? ''
      },
      done: (id) => slack.done(id),
      doneAll: () => store.doneAllMentions(),
      check: () => slack.pollMentions(),
      channels: (fresh) => slack.postable(fresh),
      announce: async (id, to) => {
        const t = store.get(id)
        if (!t?.pr) throw new Error(`${id} has no PR`)
        const meta = await prMeta(t.worktree && existsSync(t.worktree) ? t.worktree : cfg.repo.path, t.pr.number).catch(() => null)
        const where = await slack.announce(t, meta, true, to)
        if (!where) throw new Error('set the Slack channel and SLACK_BOT_TOKEN first')
        store.journal(id, { kind: 'pr', title: `Posted to Slack ${where}`, meta: { url: t.prUrl ?? '' } })
        return where
      },
      reviewSummary: () => reviewSummary(store.all().filter((t) => !t.replay)),
      postReviewSummary: async (text, to) => {
        const where = await slack.postReviewSummary(text, to)
        store.setSettings({ alerts: { [`reviewSummary:${new Date().toDateString()}`]: 1 } })
        return where
      },
      night: {
        set: (manual) => nightShift.set(manual),
        post: (id, text) => nightShift.post(id, text),
        seen: () => nightShift.seen(),
        test: (text, from) => nightShift.test(text, from),
      },
      nudgeDraft: (picks) => nudger.draft(picks),
      nudgeSend: (login, slackId, text, ids) => nudger.send(login, slackId, text, ids),
      people: () => slack.people(),
      setPerson: (login, id) => slack.setPerson(login, id),
    },
    // GitHub takes a few seconds to make the merge commit; sync soon so the new heads and CI show up
    updateBranches: async (ids) => {
      const results = await runner.updateBranchesOnGithub(ids)
      if (results.some((r) => r.outcome === 'updated')) for (const ms of [20_000, 90_000]) setTimeout(() => void prSync.tick(), ms)
      return results
    },
    settings: () => {
      const pick = (c: typeof cfg) => ({ autopilot: c.autopilot, triage: c.triage, readiness: c.readiness, localChecks: { enabled: c.localChecks.enabled, e2e: c.localChecks.e2e, e2eAfterPr: c.localChecks.e2eAfterPr }, afterFix: c.afterFix, chat: c.chat, budget: c.budget, engines: c.engines, roles: { ...c.roles }, pipeline: { effort: c.pipeline.effort, maxParallel: c.pipeline.maxParallel, reviewPass: c.pipeline.reviewPass, draftOnFinish: c.pipeline.draftOnFinish, autoUpdateFromMain: c.pipeline.autoUpdateFromMain, autoPullPr: c.pipeline.autoPullPr }, github: { screenshots: c.github.screenshots, greptile: { enabled: c.github.greptile.enabled }, reviewers: c.github.reviewers }, steps: c.steps, shots: c.shots, principles: { enabled: c.principles.enabled, ref: c.principles.ref }, slack: { threads: c.slack.threads, notify: c.slack.notify, announce: c.slack.announce, channel: c.slack.channel, mentions: c.slack.mentions, reviewSummaryAt: c.slack.reviewSummaryAt, rollCalls: c.slack.rollCalls, nightShift: c.slack.nightShift, autoNudge: c.slack.autoNudge }, figma: { enabled: c.figma.enabled }, mascot: c.mascot, daemon: c.daemon, quality: { targetLines: c.quality.targetLines, maxLines: c.quality.maxLines, minGreptile: c.quality.minGreptile, securityLens: c.quality.securityLens, quick: c.quality.quick } })
      return { overrides: store.snapshot().settings ?? {}, effective: pick(runner.config), defaults: pick(cfg) }
    },
    pipeline: () => pipelineView(runner.config, staged),
    requests: {
      list: () => requests.all(),
      scan: () => requests.tick(),
      recheck: (hours) => requests.recheck(hours),
      fromMention: (mentionId, ticketId) => requests.fromMention(mentionId, ticketId),
      edit: (id, patch) => requests.edit(id, patch),
      send: (id, quick) => requests.send(id, quick),
      sendAll: (ticketId, quick) => requests.sendAll(ticketId, quick),
      reply: (id, text) => requests.reply(id, text),
      decline: (id, text) => requests.decline(id, text),
      close: (id) => requests.close(id),
      newTicket: (id) => requests.newTicket(id),
      postAddressed: (id, text) => requests.postAddressed(id, text),
    },
  })
  if (cfg.roles.curator !== 'off') scheduleDaily(cfg.roles.curatorAt, () => curate().then(() => undefined, (e: unknown) => log.warn('curator failed', e)))
  telegram.curate = curate
  telegram.learnings = learnings
  if (cfg.pipeline.digestAt) {
    scheduleDaily(cfg.pipeline.digestAt, () => telegram.sendPlain(formatDigest(computeDigest(store.all().filter((t) => !t.replay)))))
  }
  if (cfg.server.tunnel && env.dashboardToken) {
    const token = env.dashboardToken
    const tunnel = new Tunnel(cfg.server.port, (url) => {
      health.tunnel = { ...health.ok(), detail: 'up', url }
      void telegram.sendPlain(`📱 dashboard: ${url}/?c=${sessions.issueCode()}\n(one-time link, 10 minutes; /tunnel for a new one)`)
    })
    health.tunnel = { ok: null, detail: 'starting', at: null, url: null }
    telegram.dashboardLink = () => (tunnel.url ? `${tunnel.url}/?c=${sessions.issueCode()}` : null)
    tunnel.start()
    process.on('exit', () => tunnel.stop())
  }
  // A restart (tsx watch, the app's Stop, Ctrl-C) kills the lanes and parks them with a RESUME.md,
  // instead of leaving them running headless or losing where they were.
  // New code on disk (a pull, an edit, a delivered fix): restart on it as soon as nothing is
  // running, once the files have stopped changing. Started from a terminal, the app only says so.
  setInterval(() => {
    const st = codeWatch.check()
    if (!st.stale || !codeWatch.settled || !st.supervised || !runner.config.daemon.autoRestart || busyWith()) return
    restartForNewCode(`${st.changed} file${st.changed === 1 ? '' : 's'} changed: ${st.files.slice(0, 3).join(', ')}`)
  }, 30_000)
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
  // local checks cut off by the restart: forget them, the next push runs them again
  for (const t of store.all()) {
    if (t.localChecks?.status !== 'running') continue
    const { localChecks: _, ...rest } = t
    store.upsert(rest)
  }
  humanTests.closeOrphans()
  // closed tickets older than three days: slim on the board, full record in data/archive
  const archive = () => {
    const ids = store.compactClosed(3)
    if (ids.length) log.info(`archived the details of ${ids.length} closed ticket(s): ${ids.join(', ')}`)
  }
  archive()
  setInterval(archive, 6 * 3_600_000)
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
  telegram.cycle = () => linear.cycleView?.() ?? Promise.resolve(NO_CYCLE)
  telegram.assign = (ids) => assignAndTrack(ids)
  await poll()
  setInterval(() => void poll(), cfg.pipeline.pollMs)
  void prSync.tick()
  setInterval(() => void prSync.tick(), cfg.pipeline.prSyncMs)
  // Roll call: at each scheduled time (within 3 hours of it, once a day), your PRs waiting for
  // review go to the channel. Nothing new since the last post there: no post.
  setInterval(() => {
    const sl = runner.config.slack
    const alerts = store.snapshot().settings?.alerts ?? {}
    for (const { key, channel } of rollCallsDue(sl, new Date(), alerts)) {
      store.setSettings({ alerts: { [key]: 1 } })
      const text = reviewSummary(store.all().filter((t) => !t.replay))
      if (!text) continue
      const hashKey = `rollCallLast:${channel}`
      const h = textHash(text)
      if (alerts[hashKey] === h) continue
      void slack.postReviewSummary(text, channel).then(
        () => store.setSettings({ alerts: { [hashKey]: h } }),
        (e: unknown) => log.warn('roll call failed', e),
      )
    }
  }, 60_000)
  // Auto nudge (off by default): every 15 minutes, the due nudges go out as your DMs
  setInterval(() => {
    void nudger.auto().then(
      (sent) => sent.length && void telegram.sendPlain(`👋 nudged on Slack: ${sent.map((s) => `${s.login} (${s.numbers.map((n) => `#${n}`).join(', ')})`).join(' · ')}`),
      (e: unknown) => log.warn('auto nudge failed', e),
    )
  }, 15 * 60_000)
  // PRs that are moving (just pushed, CI running) get a look every 45 seconds
  setInterval(() => void prSync.tick({ hot: true }), 45_000)
  void reviews.tick()
  setInterval(() => void reviews.tick(), cfg.pipeline.prSyncMs)
  void mainSync.tick()
  setInterval(() => void mainSync.tick(), cfg.pipeline.mainSyncMinutes * 60_000)
  setInterval(watchQuiet, 60_000)
  void slack.probe()
  void probeFigma()
  setTimeout(() => void slack.pollMentions(), 30_000)
  setInterval(() => void slack.pollMentions(), Math.max(1, cfg.slack.mentionsMinutes) * 60_000)
  // during Night Shift someone is waiting on an answer: look every 20 seconds, not every few minutes
  setInterval(() => {
    if (nightShift.on()) void slack.pollMentions()
  }, 20_000)
  // Night Shift: on and off by your hours, your switch or your Slack status; DMs read while on
  void nightShift.tick()
  setInterval(() => void nightShift.tick().catch((e: unknown) => log.warn('night shift tick failed', e)), 60_000)
  // requests: new comments on your open tickets, every two minutes
  setTimeout(() => void requests.tick().catch((e: unknown) => log.warn('requests tick failed', e)), 30_000)
  setInterval(() => void requests.tick().catch((e: unknown) => log.warn('requests tick failed', e)), 120_000)
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
  prSync.onCiRed = (id) => runner.checkCi(id)
  telegram.importIssue = (ref, assign) => importIssue(ref, assign)
  telegram.revokeSessions = () => sessions.revokeAll()
  store.on('settings', () => void probeEngines())
  // the pinned pstack commit: fetched now, again when you turn it on or accept a newer commit
  const syncPstack = () => void syncPrinciples(runner.config)
  syncPstack()
  store.on('settings', syncPstack)
  // keep the lane logs of a closed ticket even after its worktree goes
  store.on('closed', (id: string) => {
    try {
      const n = runner.archiveLogs(id)
      if (n) log.info(`${id}: archived ${n} lane log(s) to the history`)
    } catch (error) {
      log.warn(`${id}: could not archive lane logs`, error)
    }
  })
}

main().catch((error) => {
  log.error('fatal', error)
  process.exit(1)
})
