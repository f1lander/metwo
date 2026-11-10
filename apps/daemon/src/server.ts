import { timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { getConnInfo } from '@hono/node-server/conninfo'
import { serveStatic } from '@hono/node-server/serve-static'
import { canFinishChecks } from '@ticketflow/shared'
import type { EngineSetup } from './engine-setup.js'
import type { Sessions } from './sessions.js'
import type { AskReply, AssistAction, BranchUpdateResult, CommentTriage, FixLogView, SlackMention, Leaderboard, PrMeta, CycleView, FindScope, FoundIssue, LinearProject, Health, LearningProposal, LinearIssueView, PrinciplesUpdate, PrReview, HumanTestMode, HumanTestRun, PrView, Readiness, ServerEvent, TestPlan, Settings, SettingsView, StartChoice, Ticket, TicketDiff, TodayItem, Triage, NightShiftState, LinearSyncRow, MascotStatus, SlackChannel } from '@ticketflow/shared'
import { githubAvatar } from './avatars.js'
import { knowledgeDir } from './config.js'
import { Hono, type MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'

// adb serials: USB ids, ip:port, or mDNS names for wireless debugging
const SERIAL = /^[A-Za-z0-9._:-]{1,120}$/
type PhoneInput = { type: 'tap'; x: number; y: number } | { type: 'swipe'; x: number; y: number; x2: number; y2: number; ms?: number } | { type: 'key'; key: 'back' | 'home' | 'apps' }
import { streamSSE } from 'hono/streaming'
import type { LiveLine, LiveLog } from './live-log.js'
import { log } from './log.js'
import type { NudgeDraft } from './nudger.js'
import type { ReviewEvent, Reviews } from './reviews.js'
import { ReadyHeld, type Runner } from './runner/index.js'
import type { Store } from './store.js'

const COOKIE = 'tf_session'
const OLD_COOKIE = 'tf_token'

// Token gate. Off when no token is configured (plain localhost / Tailscale use).
// The phone opens /?c=<one-time code> (from Telegram) or /?t=<token> once; either becomes its own
// session cookie, so the token itself never sits in a cookie or travels again.
function authMiddleware(token: string | null, sessions: Sessions): MiddlewareHandler {
  return async (c, next) => {
    if (!token) return next()
    // cloudflared also connects from loopback, so tunnel traffic is told apart by its cf-ray header
    const viaTunnel = Boolean(c.req.header('cf-ray') || c.req.header('cf-connecting-ip'))
    const remote = getConnInfo(c).remote.address ?? ''
    const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
    if (isLoopback && !viaTunnel) return next()

    const code = c.req.query('c')
    // link previews and prefetchers (Telegram, Slack, WhatsApp…) must not spend the one-time code
    if (code && (c.req.method === 'HEAD' || PREVIEW_BOT.test(c.req.header('user-agent') ?? ''))) return c.text('mevo', 200)
    const fromQuery = c.req.query('t')
    const sid = code ? sessions.redeem(code) : fromQuery && safeEqual(fromQuery, token) ? sessions.create() : null
    if (sid) {
      const isHttps = viaTunnel || c.req.header('x-forwarded-proto') === 'https'
      setCookie(c, COOKIE, sid, { httpOnly: true, sameSite: 'Lax', secure: isHttps, path: '/', maxAge: 60 * 60 * 24 * 30 })
      // a single leading slash only: "//host" would leave the site
      return c.redirect(`/${c.req.path.replace(/^\/+/, '')}`)
    }
    if (code) return c.text('that sign-in link was already used or expired; ask Telegram for /tunnel again', 401)
    const session = getCookie(c, COOKIE)
    const old = getCookie(c, OLD_COOKIE)
    const fromHeader = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
    if (old && safeEqual(old, token)) {
      // a cookie from before sessions held the token itself: swap it for a session
      setCookie(c, COOKIE, sessions.create(), { httpOnly: true, sameSite: 'Lax', secure: viaTunnel || c.req.header('x-forwarded-proto') === 'https', path: '/', maxAge: 60 * 60 * 24 * 30 })
      deleteCookie(c, OLD_COOKIE, { path: '/' })
      return next()
    }
    if ((session && sessions.valid(session)) || (fromHeader && safeEqual(fromHeader, token))) return next()
    return c.text('unauthorized', 401)
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export interface Controls {
  readonly health: () => Health
  readonly poll: () => Promise<void>
  // Linear and the PRs, right now (the board's Refresh)
  readonly refresh: () => Promise<void>
  readonly restartBot: () => Promise<void>
  // restart the daemon on its new code (only when the desktop app runs it)
  readonly restartDaemon: () => { ok: boolean; error?: string }
  readonly probe: () => Promise<void>
  readonly moveInLinear: (id: string, to: 'qa' | 'done') => Promise<Ticket>
  readonly note: (id: string, text: string) => void
  readonly diff: (id: string) => Promise<TicketDiff>
  readonly openEditor: (id: string) => Promise<string>
  readonly issueView: (id: string) => Promise<LinearIssueView>
  readonly linearFile: (url: string) => Promise<{ bytes: Buffer; type: string } | null>
  readonly prView: (id: string) => Promise<PrView>
  readonly prMeta: (kind: 'ticket' | 'review', id: string) => Promise<PrMeta | null>
  readonly leaderboard: (period: 'week' | 'month', fresh: boolean) => Promise<Leaderboard>
  readonly knowledge: { readonly view: () => FixLogView; readonly learn: (prs?: readonly number[]) => Promise<number> }
  readonly triageComments: (id: string, ids: readonly string[]) => Promise<Readonly<Record<string, CommentTriage>>>
  readonly readiness: (id: string) => Promise<Readiness | null>
  // testing it by hand in a real browser while mevo watches
  readonly handTest: {
    readonly plan: (id: string) => Promise<TestPlan>
    readonly savePlan: (id: string, steps: unknown) => TestPlan
    readonly start: (id: string, mode: HumanTestMode, device?: string) => Promise<HumanTestRun>
    readonly stop: (id: string) => void
  }
  // an Android phone over adb: its screen as live H.264 and taps from the mirror
  readonly phone: {
    readonly watch: (serial: string, send: (nal: Uint8Array) => void) => () => void
    readonly input: (serial: string, e: PhoneInput) => Promise<void>
  }
  // one PR from GitHub now (its ticket was opened in the app)
  readonly syncPr: (id: string) => Promise<void>
  readonly askInLinear: (id: string, text: string) => Promise<string | null>
  readonly mascot: { readonly sip: (sips: number) => MascotStatus; readonly set: (energy: number) => MascotStatus }
  readonly linearSync: { readonly check: () => Promise<LinearSyncRow[]>; readonly fix: (ids?: readonly string[]) => Promise<LinearSyncRow[]> }
  readonly slack: {
    readonly mentions: () => readonly SlackMention[]
    readonly summarize: (id: string) => Promise<SlackMention>
    readonly reply: (id: string, text: string) => Promise<string>
    readonly done: (id: string) => void
    readonly doneAll: () => number
    readonly check: () => Promise<void>
    readonly announce: (ticketId: string, to?: string) => Promise<string>
    readonly channels: (fresh?: boolean) => Promise<SlackChannel[]>
    // your PRs waiting for review: the text, and posting it to the channel
    readonly reviewSummary: () => string | null
    readonly postReviewSummary: (text: string, to?: string) => Promise<string>
    readonly night: {
      readonly set: (manual: 'on' | 'off' | null) => Promise<NightShiftState>
      readonly post: (id: string, text?: string) => Promise<SlackMention>
      readonly seen: () => void
      readonly test: (text: string, from?: string) => Promise<SlackMention>
    }
    readonly nudgeDraft: (picks: readonly { id: string; login: string }[]) => Promise<NudgeDraft[]>
    readonly nudgeSend: (login: string, slackId: string, text: string, ids: readonly string[]) => Promise<void>
    readonly people: () => Record<string, string>
    readonly setPerson: (login: string, id: string) => void
  }
  readonly githubLogin: () => void
  readonly learnings: () => { lastRunAt: string | null; proposals: readonly LearningProposal[]; rules: string }
  readonly curate: () => Promise<number>
  readonly decideLearning: (id: string, approve: boolean, text?: string) => LearningProposal | null
  readonly removeRule: (rule: string) => boolean
  readonly testEngine: (id: string) => Promise<{ ok: boolean; text: string; model: string | null; seconds: number; detail: string }>
  readonly engineSetup: EngineSetup
  readonly sessions: Sessions
  readonly cycle: () => Promise<CycleView>
  readonly assign: (ids: readonly string[]) => Promise<{ assigned: string[]; failed: { id: string; error: string }[] }>
  readonly find: (scope: FindScope, opts: { query?: string; project?: string; team?: string }) => Promise<readonly FoundIssue[]>
  readonly projects: (query?: string) => Promise<readonly LinearProject[]>
  readonly projectByLink: (link: string) => Promise<LinearProject | null>
  readonly lookup: (ref: string) => Promise<FoundIssue | null>
  readonly importIssue: (ref: string, assign: boolean) => Promise<Ticket>
  readonly mediaFile: (id: string, name: string) => string | null
  readonly stopAll: (shutdown: boolean) => Promise<{ stopped: readonly string[]; pending: string }>
  readonly settings: () => SettingsView
  readonly principlesUpdate: () => Promise<PrinciplesUpdate>
  readonly updateBranches: (ids: readonly string[]) => Promise<readonly BranchUpdateResult[]>
  readonly today: () => Promise<TodayItem[]>
  readonly triage: (force: boolean) => Promise<number>
  readonly ask: (question: string, history: readonly { role: 'you' | 'mevo'; text: string }[]) => Promise<AskReply>
  readonly runActions: (actions: readonly AssistAction[]) => Promise<{ action: AssistAction; ok: boolean; text: string }[]>
}

// Requests from this Mac skip the token, so a web page in your browser must not pass for one.
// Host: only localhost names (a DNS-rebound domain arrives with its own name). Writes: only from
// the app's own origins, as JSON (a cross-site form or text/plain POST is refused before it runs).
function localGuard(port: number, allowed: ReadonlySet<string>): MiddlewareHandler {
  // Vite's proxy keeps its own Host (localhost:5173) when forwarding in dev
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, ...(process.env.METWO_DEV === '1' ? ['localhost:5173', '127.0.0.1:5173'] : [])])
  return async (c, next) => {
    const viaTunnel = Boolean(c.req.header('cf-ray') || c.req.header('cf-connecting-ip'))
    const host = (c.req.header('host') ?? '').toLowerCase()
    const remote = getConnInfo(c).remote.address ?? ''
    const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
    if (isLoopback && !viaTunnel && !hosts.has(host)) return c.text('forbidden host', 403)
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD' && c.req.method !== 'OPTIONS') {
      // tunnel requests carry the token cookie (SameSite=Lax) and cloudflared may rewrite Host
      const origin = c.req.header('origin')
      if (origin && !viaTunnel) {
        let same = false
        try {
          same = new URL(origin).host.toLowerCase() === host
        } catch {
          same = false
        }
        if (!same && !allowed.has(origin)) return c.text('forbidden origin', 403)
      }
      if (c.req.path.startsWith('/api/') && !(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) return c.text('send JSON', 415)
    }
    await next()
  }
}

const PREVIEW_BOT = /bot\b|TelegramBot|Slackbot|WhatsApp|facebookexternalhit|Discordbot|Twitterbot|LinkedInBot|preview|crawler|spider/i

// Ticket and review ids reach file paths (worktrees, flow folders, media): only real-looking ids.
const ID = /^[A-Za-z][A-Za-z0-9_]*-\d+$/
// routes that sit where an id would (/api/reviews/open): not ids, so not checked
const NAMED = new Set(['open', 'pick', 'refresh'])
const validId: MiddlewareHandler = async (c, next) => {
  const id = c.req.param('id')
  if (id !== undefined && !NAMED.has(id) && !ID.test(id)) return c.text('bad id', 400)
  await next()
}

// The desktop shell serves the UI from its own origin and calls the daemon on localhost.
// The Vite dev server (5173) only counts when mevo runs in dev mode (METWO_DEV=1).
const DEV = process.env.METWO_DEV === '1'
const DESKTOP_ORIGINS = new Set(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost', ...(DEV ? ['http://localhost:5173'] : [])])

export function startServer(port: number, host: string, rootDir: string, store: Store, runner: Runner, live: LiveLog, token: string | null, reviews: Reviews, controls: Controls): void {
  const app = new Hono()
  app.use('/api/*', cors({ origin: (origin) => (DESKTOP_ORIGINS.has(origin) ? origin : null), allowMethods: ['GET', 'POST'], allowHeaders: ['content-type'] }))
  app.use('*', localGuard(port, DESKTOP_ORIGINS))
  app.use('*', authMiddleware(token, controls.sessions))
  app.use('/api/tickets/:id', validId)
  app.use('/api/tickets/:id/*', validId)
  app.use('/api/reviews/:id', validId)
  app.use('/api/reviews/:id/*', validId)
  // every action from the app or the tunnel, for the history log
  app.use('/api/*', async (c, next) => {
    await next()
    if (c.req.method !== 'POST') return
    const p = c.req.path
    store.history.record({ type: 'action', via: c.req.header('cf-connecting-ip') ? 'tunnel' : 'app', action: p.replace(/^\/api\//, ''), ...(/^\/api\/tickets\/([^/]+)/.exec(p)?.[1] ? { ticket: /^\/api\/tickets\/([^/]+)/.exec(p)?.[1] } : {}), status: c.res.status })
  })
  // every handler can just throw; the app shows the message
  app.onError((error, c) => {
    log.warn(`${c.req.method} ${c.req.path}: ${error.message}`)
    return c.json({ ok: false, error: error.message }, 500)
  })
  // work that outlives the request (lanes, reviews): failures go to the log, the journal has the rest
  const background = (what: string, work: Promise<unknown>) => void work.catch((e: unknown) => log.warn(`${what} failed`, e))

  app.get('/api/health', (c) => c.json(controls.health()))
  app.get('/api/today', async (c) => c.json(await controls.today()))
  app.post('/api/triage', async (c) => {
    const { force } = (await c.req.json().catch(() => ({}))) as { force?: boolean }
    background('triage', controls.triage(Boolean(force)))
    return c.json({ ok: true })
  })
  app.post('/api/ask', async (c) => {
    const { question, history } = (await c.req.json()) as { question: string; history?: { role: 'you' | 'mevo'; text: string }[] }
    if (!question?.trim()) return c.json({ ok: false, error: 'ask something' }, 400)
    return c.json(await controls.ask(question.trim(), history ?? []))
  })
  app.post('/api/assist/run', async (c) => {
    const { actions } = (await c.req.json()) as { actions: AssistAction[] }
    return c.json({ results: await controls.runActions(actions ?? []) })
  })
  app.post('/api/control/pause', (c) => {
    runner.paused = true
    return c.json({ ok: true })
  })
  app.post('/api/control/resume', (c) => {
    runner.paused = false
    runner.pump()
    return c.json({ ok: true })
  })
  app.post('/api/control/effort', async (c) => {
    const { effort } = (await c.req.json()) as { effort: string }
    if (effort !== 'low' && effort !== 'medium' && effort !== 'high') return c.json({ ok: false, error: 'effort must be low, medium or high' }, 400)
    runner.setEffort(effort)
    return c.json(controls.health())
  })
  app.post('/api/control/parallel', async (c) => {
    const { n } = (await c.req.json()) as { n: number }
    if (!Number.isFinite(n)) return c.json({ ok: false, error: 'n must be a number' }, 400)
    runner.setMaxParallel(n)
    return c.json(controls.health())
  })
  app.post('/api/control/refresh', async (c) => {
    await controls.refresh()
    return c.json({ ok: true })
  })
  app.post('/api/control/poll', async (c) => {
    await controls.poll()
    return c.json({ ok: true })
  })
  app.post('/api/control/sessions/revoke', (c) => c.json({ ok: true, revoked: controls.sessions.revokeAll() }))
  app.post('/api/control/probe', async (c) => {
    await controls.probe()
    return c.json(controls.health())
  })
  app.post('/api/control/restart-daemon', (c) => {
    const r = controls.restartDaemon()
    return r.ok ? c.json({ ok: true }) : c.json({ ok: false, error: r.error ?? 'could not restart' }, 409)
  })
  app.post('/api/control/restart-bot', async (c) => {
    await controls.restartBot()
    return c.json(controls.health())
  })

  app.get('/api/state', (c) => c.json(store.snapshot()))
  app.get('/api/live', (c) => c.json(live.since(c.req.query('since') ?? '')))
  app.get('/api/tickets/:id/live', (c) => c.json(live.recent(c.req.param('id'))))

  app.post('/api/tickets/:id/start', async (c) => {
    const { lane, engine } = (await c.req.json()) as { lane: StartChoice; engine?: string }
    if (lane !== 'lite' && lane !== 'full' && lane !== 'max') return c.json({ ok: false, error: 'lane must be lite, full or max' }, 400)
    if (engine && !runner.engineList.some((e) => e.id === engine.split(':')[0])) return c.json({ ok: false, error: `${engine} is not enabled (engines in the config)` }, 400)
    try {
      runner.enqueue(c.req.param('id'), lane, engine || undefined)
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 409)
    }
    runner.pump()
    return c.json({ ok: true })
  })
  app.post('/api/tickets/:id/linear', async (c) => {
    const { to } = (await c.req.json()) as { to: 'qa' | 'done' }
    if (to !== 'qa' && to !== 'done') return c.json({ ok: false, error: 'to must be qa or done' }, 400)
    await controls.moveInLinear(c.req.param('id'), to)
    return c.json({ ok: true })
  })
  app.get('/api/tickets/:id/diff', async (c) => {
    return c.json(await controls.diff(c.req.param('id')))
  })
  app.post('/api/tickets/:id/open-editor', async (c) => {
    return c.json({ ok: true, editor: await controls.openEditor(c.req.param('id')) })
  })
  app.get('/api/tickets/:id/issue', async (c) => {
    return c.json(await controls.issueView(c.req.param('id')))
  })
  app.get('/api/tickets/:id/pr-view', async (c) => {
    return c.json(await controls.prView(c.req.param('id')))
  })
  app.get('/api/avatar/id/:id', async (c) => {
    const got = await githubAvatar(path.dirname(knowledgeDir()), `id:${c.req.param('id')}`, Number(c.req.query('s')) || 40)
    if (!got) return c.text('not found', 404, { 'cache-control': 'private, max-age=3600' })
    return new Response(new Uint8Array(got.bytes), { headers: { 'content-type': got.type, 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'", 'cache-control': 'private, max-age=86400' } })
  })
  app.get('/api/avatar/:login', async (c) => {
    const got = await githubAvatar(path.dirname(knowledgeDir()), c.req.param('login'), Number(c.req.query('s')) || 40)
    if (!got) return c.text('not found', 404, { 'cache-control': 'private, max-age=3600' })
    return new Response(new Uint8Array(got.bytes), { headers: { 'content-type': got.type, 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'", 'cache-control': 'private, max-age=86400' } })
  })
  // Linear's uploads need the API key; the board loads them through here
  app.get('/api/linear-file', async (c) => {
    const url = c.req.query('u') ?? ''
    if (!/^https:\/\/uploads\.linear\.app\//.test(url)) return c.text('only Linear uploads', 400)
    const got = await controls.linearFile(url).catch(() => null)
    if (!got) return c.text('not found', 404)
    // served on the daemon's own origin: only images and video inline, anything else as a download
    const type = (got.type || '').toLowerCase()
    const inline = /^(image\/(png|jpe?g|gif|webp|avif)|video\/(mp4|webm|quicktime))$/.test(type.split(';')[0]?.trim() ?? '')
    return new Response(new Uint8Array(got.bytes), {
      headers: {
        'content-type': inline ? type : 'application/octet-stream',
        ...(inline ? {} : { 'content-disposition': 'attachment' }),
        'x-content-type-options': 'nosniff',
        'content-security-policy': "sandbox; default-src 'none'",
        'cache-control': 'private, max-age=3600',
      },
    })
  })
  app.get('/api/tickets/:id/media', (c) => c.json(runner.mediaList(c.req.param('id'))))
  app.get('/api/tickets/:id/media/:name', (c) => {
    const file = controls.mediaFile(c.req.param('id'), c.req.param('name'))
    if (!file) return c.text('not found', 404)
    const ext = path.extname(file).slice(1).toLowerCase()
    const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' }[ext] ?? 'application/octet-stream'
    return new Response(new Uint8Array(readFileSync(file)), { headers: { 'content-type': type } })
  })
  app.get('/api/linear/cycle', async (c) => {
    return c.json(await controls.cycle())
  })
  app.post('/api/linear/assign', async (c) => {
    const { ids } = (await c.req.json()) as { ids: string[] }
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 25) return c.json({ ok: false, error: 'send 1 to 25 issue ids' }, 400)
    return c.json({ ok: true, ...(await controls.assign(ids)) })
  })
  app.get('/api/linear/find', async (c) => {
    const scope = c.req.query('scope') as FindScope
    if (!['backlog', 'project', 'search', 'mine'].includes(scope)) return c.json({ ok: false, error: 'scope: backlog, project, search or mine' }, 400)
    const q = c.req.query('q')
    const project = c.req.query('project')
    const team = c.req.query('team')
    return c.json(await controls.find(scope, { ...(q ? { query: q.slice(0, 200) } : {}), ...(project ? { project } : {}), ...(team ? { team } : {}) }))
  })
  app.get('/api/linear/projects', async (c) => c.json(await controls.projects((c.req.query('q') ?? '').slice(0, 100) || undefined)))
  app.get('/api/linear/project', async (c) => c.json({ project: await controls.projectByLink((c.req.query('link') ?? '').slice(0, 400)) }))
  app.get('/api/linear/lookup', async (c) => c.json({ issue: await controls.lookup((c.req.query('ref') ?? '').slice(0, 300)) }))
  app.post('/api/linear/import', async (c) => {
    const { ref, assign } = (await c.req.json()) as { ref?: string; assign?: boolean }
    if (!ref?.trim()) return c.json({ ok: false, error: 'paste a Linear link or an id like WEB-123' }, 400)
    try {
      return c.json({ ok: true, ticket: await controls.importIssue(ref.slice(0, 300), assign !== false) })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400)
    }
  })
  app.get('/api/learnings', (c) => c.json(controls.learnings()))
  app.post('/api/learnings/run', async (c) => {
    return c.json({ ok: true, proposed: await controls.curate() })
  })
  app.post('/api/learnings/remove', async (c) => {
    const { rule } = (await c.req.json()) as { rule: string }
    return c.json({ ok: controls.removeRule(rule) })
  })
  app.post('/api/learnings/:id', async (c) => {
    const { approve, text } = (await c.req.json()) as { approve: boolean; text?: string }
    const p = controls.decideLearning(c.req.param('id'), approve === true, text)
    return p ? c.json({ ok: true, proposal: p }) : c.json({ ok: false, error: 'not found or already decided' }, 404)
  })
  app.get('/api/engines/setup', (c) => c.json(controls.engineSetup.list()))
  app.post('/api/engines/:id/install', async (c) => {
    const { confirm } = (await c.req.json().catch(() => ({}))) as { confirm?: boolean }
    if (confirm !== true) return c.json({ ok: false, error: 'confirm the install first' }, 400)
    try {
      return c.json({ ok: true, status: controls.engineSetup.install(c.req.param('id')) })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400)
    }
  })
  app.post('/api/engines/:id/terminal', async (c) => {
    const { step } = (await c.req.json().catch(() => ({}))) as { step?: 'install' | 'login' }
    try {
      return c.json({ ok: true, app: await controls.engineSetup.open(c.req.param('id'), step === 'install' ? 'install' : 'login') })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400)
    }
  })
  app.post('/api/engines/:id/test', async (c) => {
    return c.json(await controls.testEngine(c.req.param('id')))
  })
  app.post('/api/control/github-login', (c) => {
    controls.githubLogin()
    return c.json({ ok: true })
  })
  app.post('/api/tickets/:id/note', async (c) => {
    const { text } = (await c.req.json()) as { text: string }
    if (!text?.trim()) return c.json({ ok: false, error: 'empty note' }, 400)
    controls.note(c.req.param('id'), text.trim())
    return c.json({ ok: true })
  })
  app.post('/api/tickets/:id/done', (c) => {
    runner.markDone(c.req.param('id'))
    return c.json({ ok: true })
  })
  app.post('/api/prs/update-from-main', async (c) => {
    const { ids } = (await c.req.json()) as { ids?: unknown }
    if (!Array.isArray(ids) || !ids.length || !ids.every((i) => typeof i === 'string' && ID.test(i))) return c.json({ ok: false, error: 'ids must be ticket ids' }, 400)
    return c.json({ ok: true, results: await controls.updateBranches(ids as string[]) })
  })
  app.post('/api/tickets/:id/dismiss', (c) => c.json({ ok: true, status: runner.dismiss(c.req.param('id')).status }))
  app.post('/api/tickets/:id/reopen', async (c) => c.json({ ok: true, ...(await runner.reopen(c.req.param('id'))) }))
  app.post('/api/tickets/:id/skip', (c) => {
    runner.skip(c.req.param('id'))
    return c.json({ ok: true })
  })
  app.post('/api/tickets/:id/answer', async (c) => {
    const { text } = (await c.req.json()) as { text: string }
    background('answer', runner.answer(c.req.param('id'), text))
    return c.json({ ok: true })
  })
  app.post('/api/tickets/:id/ci/check', async (c) => c.json({ ok: true, ci: (await runner.checkCi(c.req.param('id')))?.ci ?? null }))
  app.post('/api/tickets/:id/ci/rerun', async (c) => {
    try {
      return c.json({ ok: true, runs: await runner.rerunCi(c.req.param('id')) })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400)
    }
  })
  app.post('/api/tickets/:id/ci/fix', (c) => {
    const id = c.req.param('id')
    const t = store.get(id)
    if (!t?.pr || t.status === 'running' || t.status === 'queued') return c.json({ ok: false, error: `${id} needs an open PR and no lane running` }, 400)
    background(`${id}: fix CI`, runner.fixCi(id))
    return c.json({ ok: true })
  })
  app.post('/api/tickets/:id/dismiss-question', (c) => {
    try {
      runner.dismissQuestion(c.req.param('id'))
      return c.json({ ok: true })
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 400)
    }
  })
  // force: push past failed local checks (the app asked you first)
  app.post('/api/tickets/:id/push', async (c) => {
    const { force } = (await c.req.json().catch(() => ({}))) as { force?: unknown }
    const result = await runner.requestPush(c.req.param('id'), force === true)
    return c.json({ ok: true, result })
  })
  app.post('/api/tickets/:id/sync', async (c) => {
    await controls.syncPr(c.req.param('id'))
    return c.json({ ok: true })
  })
  app.post('/api/tickets/:id/local-checks', async (c) => {
    const id = c.req.param('id')
    const t = store.get(id)
    if (t?.status === 'running' || t?.localChecks?.status === 'running') return c.json({ ok: false, error: `${id} is busy; try when it finishes` }, 409)
    background(`local checks ${id}`, runner.localCheck(id, undefined, false, false, true))
    return c.json({ ok: true })
  })
  app.post('/api/tickets/:id/local-checks/fix', async (c) => {
    const id = c.req.param('id')
    background(`fix local checks ${id}`, runner.fixLocalChecks(id))
    return c.json({ ok: true })
  })

  app.post('/api/tickets/:id/ready', async (c) => {
    const force = c.req.query('force') === '1'
    try {
      const { reviewers } = await runner.markReady(c.req.param('id'), force)
      return c.json({ ok: true, reviewers })
    } catch (error) {
      if (error instanceof ReadyHeld) return c.json({ ok: false, error: error.message, held: true }, 409)
      throw error
    }
  })
  // text + optional images as base64 (pasted or picked in the app)
  app.post('/api/tickets/:id/instruct', async (c) => {
    const id = c.req.param('id')
    const { text, images, quick } = (await c.req.json()) as { text?: string; images?: { name: string; data: string }[]; quick?: boolean }
    if (!text?.trim()) return c.json({ ok: false, error: 'say what to change' }, 400)
    const list = (images ?? []).slice(0, 6).map((i) => ({ name: i.name || 'image.png', bytes: Buffer.from(i.data.replace(/^data:[^,]+,/, ''), 'base64') }))
    if (list.some((i) => i.bytes.length > 10 * 1024 * 1024)) return c.json({ ok: false, error: 'images up to 10 MB each' }, 400)
    const t = store.get(id)
    if (!t?.worktree) return c.json({ ok: false, error: `${id} has no worktree yet; start it first` }, 400)
    const queued = t.status === 'running' || t.status === 'queued'
    if (queued && t.queuedInstruction) return c.json({ ok: false, error: `${id} already has an instruction waiting; cancel it first` }, 409)
    background(`${id}: instruction`, runner.instruct(id, text, list, quick === true))
    return c.json({ ok: true, queued })
  })
  app.post('/api/tickets/:id/quick-check', (c) => c.json({ ok: true, ticket: runner.quickChecked(c.req.param('id')) }))
  app.post('/api/tickets/:id/instruct/cancel', (c) => {
    runner.dropQueued(c.req.param('id'))
    return c.json({ ok: true })
  })
  app.post('/api/tickets/:id/visual', (c) => {
    const id = c.req.param('id')
    const t = store.get(id)
    if (!t?.worktree) return c.json({ ok: false, error: `${id} has no worktree yet` }, 400)
    if (t.status === 'running' || t.status === 'queued') return c.json({ ok: false, error: `${id} has a lane running; try when it finishes` }, 409)
    background(`${id}: visual check`, runner.runVisualCheck(id))
    return c.json({ ok: true })
  })
  app.post('/api/tickets/:id/visual/post', async (c) => {
    return c.json({ ok: true, url: await runner.postVisual(c.req.param('id')) })
  })
  app.post('/api/tickets/:id/finish-checks', (c) => {
    const id = c.req.param('id')
    const t = store.get(id)
    if (!t || !canFinishChecks(t)) return c.json({ ok: false, error: `${id} has no finished lane turn to check; retry it instead` }, 400)
    background(`${id}: finish checks`, runner.finishChecks(id))
    return c.json({ ok: true })
  })
  app.post('/api/tickets/:id/pause-after', async (c) => {
    const { on } = (await c.req.json().catch(() => ({}))) as { on?: boolean }
    runner.setPauseAfter(c.req.param('id'), on !== false)
    return c.json({ ok: true })
  })
  app.post('/api/tickets/:id/open-claude', async (c) => c.json({ ok: true, ...(await runner.openClaude(c.req.param('id'))) }))
  app.get('/api/tickets/:id/preview', (c) => c.json({ preview: runner.previewOf(c.req.param('id')) }))
  app.post('/api/tickets/:id/preview-qa', async (c) => {
    const id = c.req.param('id')
    const { force } = (await c.req.json().catch(() => ({}))) as { force?: boolean }
    const t = store.get(id)
    if (!t?.pr) return c.json({ ok: false, error: `${id} has no PR yet` }, 400)
    if (t.status === 'running' || t.status === 'queued') return c.json({ ok: false, error: `${id} has a lane running; try when it finishes` }, 409)
    const preview = runner.previewOf(id)
    if (!preview) return c.json({ ok: false, error: 'no preview deploy found on the PR yet' }, 409)
    if (!preview.current && !force) return c.json({ ok: false, error: `the preview is from ${preview.sha?.slice(0, 7)}, not the PR's latest commit yet` }, 409)
    background(`${id}: QA on preview`, runner.runPreviewQa(id, force))
    return c.json({ ok: true })
  })
  app.post('/api/tickets/:id/preview-qa/post', async (c) => c.json({ ok: true, url: await runner.postPreviewQa(c.req.param('id')) }))
  app.get('/api/tickets/:id/pr-desc', async (c) => {
    return c.json({ open: await runner.openChecks(c.req.param('id')).catch(() => 0) })
  })
  app.post('/api/tickets/:id/pr-desc/propose', async (c) => {
    const id = c.req.param('id')
    const { trigger } = (await c.req.json().catch(() => ({}))) as { trigger?: 'visual' | 'manual' }
    const t = store.get(id)
    if (!t?.prUrl) return c.json({ ok: false, error: `${id} has no PR yet` }, 400)
    if (t.status === 'running' || t.status === 'queued') return c.json({ ok: false, error: `${id} has a lane running; try when it finishes` }, 409)
    background(`${id}: PR description`, runner.proposeDescription(id, trigger === 'manual' ? 'manual' : 'visual'))
    return c.json({ ok: true })
  })
  app.post('/api/tickets/:id/checks/work', (c) => {
    const id = c.req.param('id')
    const t = store.get(id)
    if (!t?.pr || !t.worktree) return c.json({ ok: false, error: `${id} has no PR yet` }, 400)
    if (t.status === 'running' || t.status === 'queued' || t.descProposal?.status === 'preparing') return c.json({ ok: false, error: `${id} is busy; try when it finishes` }, 409)
    background(`${id}: PR checks`, runner.workChecks(id))
    return c.json({ ok: true })
  })
  app.post('/api/tickets/:id/checks/tick', async (c) => {
    const { lines } = (await c.req.json()) as { lines?: unknown }
    if (!Array.isArray(lines) || !lines.length || !lines.every((l) => typeof l === 'string')) return c.json({ ok: false, error: 'lines must be a list of checkbox lines' }, 400)
    return c.json({ ok: true, ticked: await runner.tickChecks(c.req.param('id'), lines as string[]) })
  })
  app.post('/api/tickets/:id/pr-desc/apply', async (c) => {
    const input = (await c.req.json().catch(() => ({}))) as { accept?: string[]; comment?: string | null; log?: string }
    return c.json({ ok: true, ...(await runner.applyDescription(c.req.param('id'), input)) })
  })
  app.post('/api/tickets/:id/pr-desc/discard', (c) => {
    runner.dropDescProposal(c.req.param('id'))
    return c.json({ ok: true })
  })
  app.post('/api/tickets/:id/visual/override', async (c) => {
    const { value } = (await c.req.json()) as { value: 'on' | 'off' | null }
    runner.setVisualOverride(c.req.param('id'), value === 'on' || value === 'off' ? value : null)
    return c.json({ ok: true })
  })
  app.post('/api/tickets/:id/greptile-fix', async (c) => {
    const id = c.req.param('id')
    const { quick } = (await c.req.json().catch(() => ({}))) as { quick?: boolean }
    const t = store.get(id)
    if (!t?.pr?.greptile?.findings.length) return c.json({ ok: false, error: 'no Greptile findings on this PR' }, 400)
    background(`${id}: greptile fix`, runner.fixGreptile(id, typeof quick === 'boolean' ? quick : undefined))
    return c.json({ ok: true })
  })
  app.post('/api/tickets/:id/stop', async (c) => {
    await runner.stop(c.req.param('id'))
    return c.json({ ok: true })
  })
  // engine: continue on another engine/model; fresh: start over (the old work goes to a backup branch)
  app.post('/api/tickets/:id/resume', async (c) => {
    const id = c.req.param('id')
    const { engine, fresh } = (await c.req.json().catch(() => ({}))) as { engine?: unknown; fresh?: unknown }
    if (store.get(id)?.status !== 'stopped') return c.json({ ok: false, error: `${id} is not stopped` }, 400)
    if (engine !== undefined && (typeof engine !== 'string' || !/^[a-z]+(:[\w./:@-]+)?$/i.test(engine))) return c.json({ ok: false, error: 'engine: like codex or claude:sonnet' }, 400)
    if (typeof engine === 'string' && !runner.engineList.some((e) => e.id === engine.split(':')[0])) return c.json({ ok: false, error: `${engine} is not enabled` }, 400)
    background(`${id}: resume`, runner.resume(id, { ...(typeof engine === 'string' && engine ? { engine } : {}), fresh: fresh === true }))
    return c.json({ ok: true })
  })
  // conflicts with main, resolved by hand in the editor
  app.post('/api/tickets/:id/merge/start', async (c) => c.json({ ok: true, ...(await runner.startManualMerge(c.req.param('id'))) }))
  app.post('/api/tickets/:id/merge/check', async (c) => c.json({ ok: true, left: await runner.checkManualMerge(c.req.param('id')) }))
  app.post('/api/tickets/:id/merge/finish', async (c) => c.json({ ok: true, outcome: await runner.finishManualMerge(c.req.param('id')) }))
  app.post('/api/tickets/:id/merge/abort', async (c) => {
    await runner.abortManualMerge(c.req.param('id'))
    return c.json({ ok: true })
  })
  app.post('/api/tickets/:id/update-main', (c) => {
    const id = c.req.param('id')
    const t = store.get(id)
    if (!t?.worktree) return c.json({ ok: false, error: `${id} has no worktree` }, 400)
    if (t.status === 'running' || t.status === 'queued') return c.json({ ok: false, error: `${id} has a lane running; try when it finishes` }, 409)
    background(`${id}: update from main`, runner.updateFromMain(id))
    return c.json({ ok: true })
  })
  app.get('/api/settings', (c) => c.json(controls.settings()))
  app.post('/api/settings', async (c) => {
    const patch = (await c.req.json()) as Settings
    if (patch.principles?.ref !== undefined && !/^[0-9a-f]{40}$/.test(patch.principles.ref)) return c.json({ ok: false, error: 'principles.ref must be a full commit sha' }, 400)
    const rc = patch.slack?.rollCalls
    if (rc !== undefined && (!Array.isArray(rc) || rc.length > 6 || rc.some((x) => !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(x?.at)) || (x.days !== 'weekdays' && x.days !== 'daily') || (x.channel !== undefined && (typeof x.channel !== 'string' || x.channel.length > 80)))))
      return c.json({ ok: false, error: 'slack.rollCalls: up to 6 of { at: "HH:MM", days: "weekdays" | "daily", channel? }' }, 400)
    if (patch.slack?.autoNudge !== undefined && typeof patch.slack.autoNudge !== 'boolean') return c.json({ ok: false, error: 'slack.autoNudge: true or false' }, 400)
    if (patch.daemon !== undefined && (typeof patch.daemon !== 'object' || (patch.daemon.autoRestart !== undefined && typeof patch.daemon.autoRestart !== 'boolean'))) return c.json({ ok: false, error: 'daemon: { autoRestart?: boolean }' }, 400)
    const q = patch.quality
    const lim = (v: unknown, lo: number, hi: number) => v === undefined || v === null || (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi)
    if (q !== undefined && (typeof q !== 'object' || !lim(q.targetLines, 20, 5000) || !lim(q.maxLines, 20, 5000) || !lim(q.minGreptile, 1, 5) || (q.securityLens !== undefined && typeof q.securityLens !== 'boolean')))
      return c.json({ ok: false, error: 'quality: { targetLines, maxLines: 20 to 5000 or null, minGreptile: 1 to 5 or null, securityLens: boolean }' }, 400)
    const ms = patch.mascot
    if (ms !== undefined && (typeof ms !== 'object' || (ms.enabled !== undefined && typeof ms.enabled !== 'boolean') || (ms.coffee !== undefined && typeof ms.coffee !== 'boolean'))) return c.json({ ok: false, error: 'mascot: { enabled?: boolean, coffee?: boolean }' }, 400)
    const ns = patch.slack?.nightShift
    const time = (v: unknown) => v === undefined || /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))
    if (ns !== undefined && (typeof ns !== 'object' || !time(ns.from) || !time(ns.to) || (ns.mode !== undefined && ns.mode !== 'shadow' && ns.mode !== 'facts') || (ns.days !== undefined && ns.days !== 'weekdays' && ns.days !== 'daily') || (ns.wake !== undefined && (!Array.isArray(ns.wake) || ns.wake.length > 20 || ns.wake.some((w) => typeof w !== 'string' || w.length > 40))) || (ns.dmAsMe !== undefined && typeof ns.dmAsMe !== 'boolean')))
      return c.json({ ok: false, error: 'slack.nightShift: { enabled, mode: shadow|facts, from/to: "HH:MM", days, followSlack, wake: [words] }' }, 400)
    if (patch.autopilot?.enabled && !store.snapshot().settings?.autopilot?.enabled) store.setSettings({ autopilot: { since: new Date().toISOString() } })
    store.setSettings(patch)
    runner.pump()
    return c.json(controls.settings())
  })
  app.post('/api/principles/update', async (c) => c.json(await controls.principlesUpdate()))
  app.post('/api/tickets/:id/principles', async (c) => {
    const { on } = (await c.req.json()) as { on: boolean | null }
    const t = store.get(c.req.param('id'))
    if (!t) return c.json({ ok: false, error: 'no such ticket' }, 404)
    if (on !== null && typeof on !== 'boolean') return c.json({ ok: false, error: 'on must be true, false or null' }, 400)
    const { principles: _old, ...rest } = t
    store.upsert(on === null ? rest : { ...rest, principles: on })
    return c.json({ ok: true })
  })
  app.post('/api/settings/reset', async (c) => {
    const { key } = (await c.req.json()) as { key: string }
    store.resetSetting(key)
    return c.json(controls.settings())
  })
  app.post('/api/control/stop-all', async (c) => {
    const { shutdown } = (await c.req.json().catch(() => ({}))) as { shutdown?: boolean }
    return c.json({ ok: true, ...(await controls.stopAll(shutdown === true)) })
  })
  app.post('/api/tickets/:id/comments/ignore', async (c) => {
    const { ids, reopen } = (await c.req.json()) as { ids: string[]; reopen?: boolean }
    if (reopen) for (const x of ids) runner.reopenComment(c.req.param('id'), x)
    else runner.ignoreComments(c.req.param('id'), ids)
    return c.json({ ok: true })
  })
  app.post('/api/tickets/:id/comments/draft', async (c) => {
    const { comment, hint } = (await c.req.json()) as { comment: string; hint?: string }
    return c.json({ ok: true, text: await runner.draftReply(c.req.param('id'), comment, hint) })
  })
  app.post('/api/tickets/:id/comments/reply', async (c) => {
    const { comment, body } = (await c.req.json()) as { comment: string; body: string }
    return c.json({ ok: true, url: await runner.replyComment(c.req.param('id'), comment, body) })
  })
  app.post('/api/tickets/:id/fix-comments', async (c) => {
    const { picks, quick } = (await c.req.json().catch(() => ({}))) as { picks?: { id: string; note?: string }[]; quick?: boolean }
    background('fix comments', runner.addressComments(c.req.param('id'), picks, quick === true))
    return c.json({ ok: true })
  })

  app.post('/api/reviews', async (c) => {
    const { url } = (await c.req.json()) as { url?: string }
    return c.json({ ok: true, review: await reviews.add(url ?? '') })
  })
  app.post('/api/reviews/refresh', async (c) => {
    await reviews.tick()
    return c.json({ ok: true })
  })
  app.get('/api/tickets/:id/pr-meta', async (c) => c.json(await controls.prMeta('ticket', c.req.param('id'))))
  app.get('/api/reviews/:id/meta', async (c) => {
    const id = c.req.param('id')
    if (!/^PR-\d+$/.test(id)) return c.text('bad id', 400)
    return c.json(await controls.prMeta('review', id))
  })
  app.get('/api/knowledge/reviews', (c) => c.json(controls.knowledge.view()))
  app.post('/api/knowledge/reviews/learn', async (c) => {
    const { prs } = (await c.req.json().catch(() => ({}))) as { prs?: unknown }
    const list = Array.isArray(prs) ? prs.filter((n): n is number => Number.isInteger(n) && n > 0).slice(0, 30) : undefined
    return c.json({ ok: true, queued: await controls.knowledge.learn(list) })
  })
  app.post('/api/tickets/:id/comments/triage', async (c) => {
    const { ids } = (await c.req.json()) as { ids?: unknown }
    if (!Array.isArray(ids) || !ids.length || !ids.every((x) => typeof x === 'string')) return c.json({ ok: false, error: 'ids: the comments to analyze' }, 400)
    return c.json({ ok: true, triage: await controls.triageComments(c.req.param('id'), ids as string[]) })
  })
  app.post('/api/tickets/:id/readiness', async (c) => c.json({ ok: true, readiness: await controls.readiness(c.req.param('id')) }))
  app.post('/api/tickets/:id/readiness/ask', async (c) => {
    const { text } = (await c.req.json()) as { text?: unknown }
    if (typeof text !== 'string' || !text.trim() || text.length > 5000) return c.json({ ok: false, error: 'text: the comment to post' }, 400)
    return c.json({ ok: true, url: await controls.askInLinear(c.req.param('id'), text.trim()) })
  })
  app.get('/api/slack/mentions', (c) => c.json(controls.slack.mentions()))
  app.post('/api/slack/mentions/check', async (c) => {
    await controls.slack.check()
    return c.json(controls.slack.mentions())
  })
  app.post('/api/slack/mentions/:mid/summarize', async (c) => c.json(await controls.slack.summarize(c.req.param('mid'))))
  app.post('/api/slack/mentions/:mid/reply', async (c) => {
    const { text } = (await c.req.json()) as { text?: string }
    if (!text?.trim()) return c.json({ ok: false, error: 'empty reply' }, 400)
    return c.json({ ok: true, ts: await controls.slack.reply(c.req.param('mid'), text.trim()) })
  })
  app.post('/api/slack/mentions/done-all', (c) => c.json({ ok: true, done: controls.slack.doneAll() }))
  app.post('/api/slack/mentions/:mid/done', (c) => {
    controls.slack.done(c.req.param('mid'))
    return c.json({ ok: true })
  })
  app.post('/api/tickets/:id/slack/announce', async (c) => {
    const { channel } = (await c.req.json().catch(() => ({}))) as { channel?: unknown }
    if (channel !== undefined && (typeof channel !== 'string' || channel.length > 200)) return c.json({ ok: false, error: 'channel: an id, #name or link' }, 400)
    return c.json({ ok: true, channel: await controls.slack.announce(c.req.param('id'), (channel as string | undefined) || undefined) })
  })
  app.get('/api/leaderboard', async (c) => c.json(await controls.leaderboard(c.req.query('period') === 'month' ? 'month' : 'week', c.req.query('fresh') === '1')))
  app.get('/api/reviews/open', async (c) => c.json(await reviews.openPrs()))
  app.post('/api/reviews/pick', async (c) => {
    const { number, depth } = (await c.req.json()) as { number?: unknown; depth?: unknown }
    if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) return c.json({ ok: false, error: 'number must be a PR number' }, 400)
    return c.json({ ok: true, review: await reviews.pick(number, depth === 'code' ? 'code' : 'full') })
  })
  app.post('/api/reviews/:id/start', async (c) => {
    const id = c.req.param('id')
    if (!store.review(id)) return c.json({ ok: false, error: `unknown review ${id}` }, 404)
    const { depth } = (await c.req.json().catch(() => ({}))) as { depth?: unknown }
    background(`${id}: review`, reviews.start(id, depth === 'code' || depth === 'full' ? depth : undefined))
    return c.json({ ok: true })
  })
  app.post('/api/reviews/:id/stop', (c) => {
    reviews.stop(c.req.param('id'))
    return c.json({ ok: true })
  })
  app.post('/api/reviews/:id/dismiss', (c) => {
    reviews.dismiss(c.req.param('id'))
    return c.json({ ok: true })
  })
  app.post('/api/reviews/:id/followup', async (c) => c.json({ ok: true, review: await reviews.readFollowUp(c.req.param('id')) }))
  app.post('/api/reviews/:id/followup/check', async (c) => c.json({ ok: true, review: await reviews.checkFollowUp(c.req.param('id')) }))
  app.post('/api/reviews/:id/threads/:tid/resolve', async (c) => c.json({ ok: true, review: await reviews.resolveMine(c.req.param('id'), c.req.param('tid')) }))
  app.post('/api/reviews/:id/threads/:tid/reply', async (c) => {
    const { text } = (await c.req.json()) as { text?: unknown }
    if (typeof text !== 'string' || !text.trim()) return c.json({ ok: false, error: 'text: the reply' }, 400)
    return c.json({ ok: true, review: await reviews.replyMine(c.req.param('id'), c.req.param('tid'), text.trim()) })
  })
  app.post('/api/reviews/:id/approve', async (c) => {
    const { body } = (await c.req.json().catch(() => ({}))) as { body?: unknown }
    return c.json({ ok: true, review: await reviews.approve(c.req.param('id'), typeof body === 'string' ? body.trim() : '') })
  })
  app.post('/api/reviews/:id/ping', async (c) => {
    const { text } = (await c.req.json()) as { text?: unknown }
    if (typeof text !== 'string' || !text.trim()) return c.json({ ok: false, error: 'text: the message' }, 400)
    return c.json({ ok: true, review: await reviews.ping(c.req.param('id'), text.trim()) })
  })
  app.post('/api/tickets/:id/test-plan', async (c) => c.json({ ok: true, plan: await controls.handTest.plan(c.req.param('id')) }))
  app.post('/api/tickets/:id/test-plan/save', async (c) => {
    const { steps } = (await c.req.json()) as { steps?: unknown }
    return c.json({ ok: true, plan: controls.handTest.savePlan(c.req.param('id'), steps) })
  })
  app.post('/api/tickets/:id/hand-test', async (c) => {
    const { mode, device } = (await c.req.json()) as { mode?: unknown; device?: unknown }
    if (mode !== 'mock' && mode !== 'preview' && mode !== 'chrome') return c.json({ ok: false, error: 'mode: mock, preview or chrome' }, 400)
    if (device !== undefined && (typeof device !== 'string' || !SERIAL.test(device))) return c.json({ ok: false, error: 'device: an adb serial' }, 400)
    return c.json({ ok: true, run: await controls.handTest.start(c.req.param('id'), mode, device) })
  })
  app.get('/api/devices/:serial/screen', (c) => {
    const serial = c.req.param('serial')
    if (!SERIAL.test(serial)) return c.json({ ok: false, error: 'bad serial' }, 400)
    let unwatch: (() => void) | null = null
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        try {
          unwatch = controls.phone.watch(serial, (nal) => {
            try {
              ctrl.enqueue(nal)
            } catch {
              unwatch?.()
            }
          })
        } catch (error) {
          ctrl.error(error)
        }
      },
      cancel() {
        unwatch?.()
      },
    })
    c.req.raw.signal.addEventListener('abort', () => unwatch?.(), { once: true })
    return new Response(body, { headers: { 'content-type': 'video/h264', 'cache-control': 'no-store' } })
  })
  app.post('/api/devices/:serial/input', async (c) => {
    const serial = c.req.param('serial')
    if (!SERIAL.test(serial)) return c.json({ ok: false, error: 'bad serial' }, 400)
    const e = (await c.req.json()) as Record<string, unknown>
    const n = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
    let input: PhoneInput
    if (e.type === 'tap' && n(e.x) && n(e.y)) input = { type: 'tap', x: e.x as number, y: e.y as number }
    else if (e.type === 'swipe' && n(e.x) && n(e.y) && n(e.x2) && n(e.y2)) input = { type: 'swipe', x: e.x as number, y: e.y as number, x2: e.x2 as number, y2: e.y2 as number, ...(n(e.ms) ? { ms: e.ms as number } : {}) }
    else if (e.type === 'key' && (e.key === 'back' || e.key === 'home' || e.key === 'apps')) input = { type: 'key', key: e.key }
    else return c.json({ ok: false, error: 'a tap {x,y}, a swipe {x,y,x2,y2} or a key (back, home, apps)' }, 400)
    await controls.phone.input(serial, input)
    return c.json({ ok: true })
  })
  app.post('/api/tickets/:id/hand-test/stop', (c) => {
    controls.handTest.stop(c.req.param('id'))
    return c.json({ ok: true })
  })
  app.post('/api/tickets/:id/ask', async (c) => {
    const { text } = (await c.req.json()) as { text?: unknown }
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) return c.json({ ok: false, error: 'text: the question' }, 400)
    return c.json({ ok: true, ...(await runner.ask(c.req.param('id'), text.trim())) })
  })
  app.post('/api/tickets/:id/pull', async (c) => c.json({ ok: true, ...(await runner.pullFromGithub(c.req.param('id'))) }))
  app.post('/api/tickets/:id/tell-reviewers', async (c) => c.json({ ok: true, ...(await runner.tellReviewers(c.req.param('id'))) }))
  app.get('/api/slack/review-summary', (c) => c.json({ text: controls.slack.reviewSummary() }))
  app.post('/api/slack/review-summary', async (c) => {
    const { text, channel } = (await c.req.json()) as { text?: unknown; channel?: unknown }
    if (typeof text !== 'string' || !text.trim()) return c.json({ ok: false, error: 'nothing to post' }, 400)
    if (channel !== undefined && (typeof channel !== 'string' || channel.length > 200)) return c.json({ ok: false, error: 'channel: an id, #name or link' }, 400)
    return c.json({ ok: true, channel: await controls.slack.postReviewSummary(text, (channel as string | undefined) || undefined) })
  })
  app.get('/api/slack/channels', async (c) => c.json({ ok: true, channels: await controls.slack.channels(c.req.query('fresh') === '1') }))
  app.post('/api/night-shift/test', async (c) => {
    const { text, from } = (await c.req.json().catch(() => ({}))) as { text?: unknown; from?: unknown }
    if (typeof text !== 'string' || !text.trim() || text.length > 1000 || (from !== undefined && (typeof from !== 'string' || from.length > 80))) return c.json({ ok: false, error: 'text (up to 1000), from?' }, 400)
    return c.json({ ok: true, mention: await controls.slack.night.test(text, from as string | undefined) })
  })
  app.post('/api/night-shift', async (c) => {
    const { manual } = (await c.req.json()) as { manual?: unknown }
    if (manual !== 'on' && manual !== 'off' && manual !== null) return c.json({ ok: false, error: 'manual: on, off or null' }, 400)
    return c.json({ ok: true, night: await controls.slack.night.set(manual) })
  })
  app.post('/api/night-shift/seen', (c) => {
    controls.slack.night.seen()
    return c.json({ ok: true })
  })
  app.post('/api/night-shift/post', async (c) => {
    const { id, text } = (await c.req.json()) as { id?: unknown; text?: unknown }
    if (typeof id !== 'string' || (text !== undefined && typeof text !== 'string')) return c.json({ ok: false, error: 'id, text?' }, 400)
    return c.json({ ok: true, mention: await controls.slack.night.post(id, text as string | undefined) })
  })
  app.post('/api/nudges/draft', async (c) => {
    const { picks } = (await c.req.json()) as { picks?: unknown }
    const list = Array.isArray(picks) ? picks.filter((p): p is { id: string; login: string } => typeof p?.id === 'string' && typeof p?.login === 'string' && /^[A-Za-z0-9-]{1,39}(\[bot\])?$/.test(p.login)).slice(0, 40) : []
    if (!list.length) return c.json({ ok: false, error: 'picks: [{ id, login }]' }, 400)
    return c.json({ ok: true, drafts: await controls.slack.nudgeDraft(list) })
  })
  app.post('/api/nudges/send', async (c) => {
    const { login, slackId, text, ids } = (await c.req.json()) as { login?: unknown; slackId?: unknown; text?: unknown; ids?: unknown }
    if (typeof login !== 'string' || typeof slackId !== 'string' || typeof text !== 'string' || !Array.isArray(ids)) return c.json({ ok: false, error: 'login, slackId, text, ids' }, 400)
    await controls.slack.nudgeSend(login, slackId.trim(), text, ids.filter((x): x is string => typeof x === 'string').slice(0, 40))
    return c.json({ ok: true })
  })
  app.post('/api/mascot/coffee', async (c) => {
    const { sips } = (await c.req.json().catch(() => ({}))) as { sips?: unknown }
    if (typeof sips !== 'number' || !Number.isFinite(sips) || sips < 1) return c.json({ ok: false, error: 'sips: a number from 1' }, 400)
    return c.json({ ok: true, mascot: controls.mascot.sip(sips) })
  })
  app.post('/api/mascot/energy', async (c) => {
    const { energy } = (await c.req.json().catch(() => ({}))) as { energy?: unknown }
    if (typeof energy !== 'number' || !Number.isFinite(energy) || energy < 0 || energy > 1) return c.json({ ok: false, error: 'energy: 0 to 1' }, 400)
    return c.json({ ok: true, mascot: controls.mascot.set(energy) })
  })
  app.get('/api/linear-sync', async (c) => c.json({ ok: true, rows: await controls.linearSync.check() }))
  app.post('/api/linear-sync', async (c) => {
    const { ids } = (await c.req.json()) as { ids?: unknown }
    if (ids !== undefined && (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string'))) return c.json({ ok: false, error: 'ids?: [ticket ids]' }, 400)
    return c.json({ ok: true, rows: await controls.linearSync.fix(ids as string[] | undefined) })
  })
  app.get('/api/slack/people', (c) => c.json(controls.slack.people()))
  app.post('/api/slack/people', async (c) => {
    const { login, id } = (await c.req.json()) as { login?: unknown; id?: unknown }
    if (typeof login !== 'string' || typeof id !== 'string') return c.json({ ok: false, error: 'login and id' }, 400)
    controls.slack.setPerson(login, id.trim())
    return c.json({ ok: true })
  })
  app.post('/api/reviews/:id/post', async (c) => {
    const input = (await c.req.json()) as { event?: string; body?: string; findings?: { id: string; body: string }[] }
    const event = (['APPROVE', 'REQUEST_CHANGES', 'COMMENT'].includes(input.event ?? '') ? input.event : 'COMMENT') as ReviewEvent
    return c.json({ ok: true, review: await reviews.post(c.req.param('id'), { event, body: input.body ?? '', findings: input.findings ?? [] }) })
  })

  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      const push = (event: ServerEvent) => stream.writeSSE({ data: JSON.stringify(event) })
      await push({ type: 'snapshot', state: store.snapshot() })
      // so cards show the lane's latest step right away, not only after the next line arrives
      for (const id of [...Object.keys(store.snapshot().tickets), ...Object.keys(store.snapshot().reviews ?? {})]) {
        for (const line of live.recent(id, 1)) await push({ type: 'live', id, line })
      }
      // a ticket patched many times in a row (stages, syncs) goes out once per 300ms, its latest
      const dirty = new Map<string, Ticket>()
      let flush: ReturnType<typeof setTimeout> | null = null
      const onTicket = (ticket: Ticket) => {
        dirty.set(ticket.id, ticket)
        flush ??= setTimeout(() => {
          flush = null
          const out = [...dirty.values()]
          dirty.clear()
          for (const t of out) void push({ type: 'ticket', ticket: t })
        }, 300)
      }
      const onReview = (review: PrReview) => void push({ type: 'review', review })
      const onLine = (id: string, line: LiveLine) => void push({ type: 'live', id, line })
      const onLabels = (labelColors: Record<string, string>) => void push({ type: 'labels', labelColors })
      const onTriage = (triage: Record<string, Triage>) => void push({ type: 'triage', triage })
      const onSlack = (mentions: SlackMention[]) => void push({ type: 'slack', mentions })
      const onNight = (night: NightShiftState) => void push({ type: 'night', night })
      const onMascot = (mascot: MascotStatus) => void push({ type: 'mascot', mascot })
      store.on('night', onNight)
      store.on('mascot', onMascot)
      store.on('slack', onSlack)
      store.on('labels', onLabels)
      store.on('triage', onTriage)
      store.on('ticket', onTicket)
      store.on('review', onReview)
      live.on('line', onLine)
      stream.onAbort(() => {
        store.off('night', onNight)
        store.off('mascot', onMascot)
        store.off('slack', onSlack)
        store.off('labels', onLabels)
        store.off('triage', onTriage)
        store.off('ticket', onTicket)
        if (flush) clearTimeout(flush)
        store.off('review', onReview)
        live.off('line', onLine)
      })
      while (!stream.aborted) {
        await stream.sleep(15000)
        await stream.writeSSE({ event: 'ping', data: '' })
      }
    }),
  )

  const webDist = path.join(rootDir, 'apps', 'web', 'dist')
  if (existsSync(webDist)) {
    app.use('/*', serveStatic({ root: path.relative(process.cwd(), webDist) }))
    app.get('*', serveStatic({ path: path.relative(process.cwd(), path.join(webDist, 'index.html')) }))
  } else {
    app.get('/', (c) => c.text('mevo daemon running. Build apps/web for the board, or use the Vite dev server on :5173.'))
  }

  // on this Mac only, unless you set server.host (then the token is required)
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1'
  const bind = !loopback && !token ? '127.0.0.1' : host
  if (bind !== host) log.error(`server.host ${host} needs DASHBOARD_TOKEN; listening on 127.0.0.1 only`)
  serve({ fetch: app.fetch, port, hostname: bind === 'localhost' ? '127.0.0.1' : bind }, () => log.info(`http://localhost:${port} (${bind})`))
  // macOS resolves localhost to ::1 first; listen there too so the app's fetches land
  if (bind === '127.0.0.1' || bind === 'localhost') {
    const v6 = serve({ fetch: app.fetch, port, hostname: '::1' })
    v6.on('error', () => undefined)
  }
}
