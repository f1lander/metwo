import { timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { getConnInfo } from '@hono/node-server/conninfo'
import { serveStatic } from '@hono/node-server/serve-static'
import type { CycleView, Health, LearningProposal, LinearIssueView, PrReview, PrView, ServerEvent, Settings, SettingsView, StartChoice, Ticket, TicketDiff } from '@ticketflow/shared'
import { Hono, type MiddlewareHandler } from 'hono'
import { cors } from 'hono/cors'
import { getCookie, setCookie } from 'hono/cookie'
import { streamSSE } from 'hono/streaming'
import type { LiveLine, LiveLog } from './live-log.js'
import { log } from './log.js'
import type { ReviewEvent, Reviews } from './reviews.js'
import type { Runner } from './runner/index.js'
import type { Store } from './store.js'

const COOKIE = 'tf_token'

// Token gate. Off when no token is configured (plain localhost / Tailscale use).
// The phone opens /?t=<token> once; the cookie carries it for fetch and EventSource after that.
function authMiddleware(token: string | null): MiddlewareHandler {
  return async (c, next) => {
    if (!token) return next()
    // cloudflared also connects from loopback, so tunnel traffic is told apart by its cf-ray header
    const viaTunnel = Boolean(c.req.header('cf-ray') || c.req.header('cf-connecting-ip'))
    const remote = getConnInfo(c).remote.address ?? ''
    const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
    if (isLoopback && !viaTunnel) return next()

    const fromQuery = c.req.query('t')
    if (fromQuery && safeEqual(fromQuery, token)) {
      const isHttps = viaTunnel || c.req.header('x-forwarded-proto') === 'https'
      setCookie(c, COOKIE, token, { httpOnly: true, sameSite: 'Lax', secure: isHttps, path: '/', maxAge: 60 * 60 * 24 * 30 })
      return c.redirect(c.req.path)
    }
    const fromCookie = getCookie(c, COOKIE)
    const fromHeader = c.req.header('authorization')?.replace(/^Bearer\s+/i, '')
    if ((fromCookie && safeEqual(fromCookie, token)) || (fromHeader && safeEqual(fromHeader, token))) return next()
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
  readonly restartBot: () => Promise<void>
  readonly probe: () => Promise<void>
  readonly moveInLinear: (id: string, to: 'qa' | 'done') => Promise<Ticket>
  readonly note: (id: string, text: string) => void
  readonly diff: (id: string) => Promise<TicketDiff>
  readonly openEditor: (id: string) => Promise<string>
  readonly issueView: (id: string) => Promise<LinearIssueView>
  readonly linearFile: (url: string) => Promise<{ bytes: Buffer; type: string } | null>
  readonly prView: (id: string) => Promise<PrView>
  readonly githubLogin: () => void
  readonly learnings: () => { lastRunAt: string | null; proposals: readonly LearningProposal[]; rules: string }
  readonly curate: () => Promise<number>
  readonly decideLearning: (id: string, approve: boolean, text?: string) => LearningProposal | null
  readonly removeRule: (rule: string) => boolean
  readonly testEngine: (id: string) => Promise<{ ok: boolean; text: string; model: string | null; seconds: number; detail: string }>
  readonly cycle: () => Promise<CycleView>
  readonly assign: (ids: readonly string[]) => Promise<{ assigned: string[]; failed: { id: string; error: string }[] }>
  readonly mediaFile: (id: string, name: string) => string | null
  readonly stopAll: (shutdown: boolean) => Promise<{ stopped: readonly string[]; pending: string }>
  readonly settings: () => SettingsView
}

// The desktop shell serves the UI from its own origin and calls the daemon on localhost.
const DESKTOP_ORIGINS = new Set(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost', 'http://localhost:5173'])

export function startServer(port: number, rootDir: string, store: Store, runner: Runner, live: LiveLog, token: string | null, reviews: Reviews, controls: Controls): void {
  const app = new Hono()
  app.use('/api/*', cors({ origin: (origin) => (DESKTOP_ORIGINS.has(origin) ? origin : null), allowMethods: ['GET', 'POST'], allowHeaders: ['content-type'] }))
  app.use('*', authMiddleware(token))
  // every handler can just throw; the app shows the message
  app.onError((error, c) => {
    log.warn(`${c.req.method} ${c.req.path}: ${error.message}`)
    return c.json({ ok: false, error: error.message }, 500)
  })
  // work that outlives the request (lanes, reviews): failures go to the log, the journal has the rest
  const background = (what: string, work: Promise<unknown>) => void work.catch((e: unknown) => log.warn(`${what} failed`, e))

  app.get('/api/health', (c) => c.json(controls.health()))
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
  app.post('/api/control/poll', async (c) => {
    await controls.poll()
    return c.json({ ok: true })
  })
  app.post('/api/control/probe', async (c) => {
    await controls.probe()
    return c.json(controls.health())
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
    runner.enqueue(c.req.param('id'), lane, engine || undefined)
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
  // Linear's uploads need the API key; the board loads them through here
  app.get('/api/linear-file', async (c) => {
    const url = c.req.query('u') ?? ''
    if (!/^https:\/\/uploads\.linear\.app\//.test(url)) return c.text('only Linear uploads', 400)
    const got = await controls.linearFile(url).catch(() => null)
    if (!got) return c.text('not found', 404)
    return new Response(new Uint8Array(got.bytes), { headers: { 'content-type': got.type || 'application/octet-stream', 'cache-control': 'private, max-age=3600' } })
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
  app.post('/api/tickets/:id/skip', (c) => {
    runner.skip(c.req.param('id'))
    return c.json({ ok: true })
  })
  app.post('/api/tickets/:id/answer', async (c) => {
    const { text } = (await c.req.json()) as { text: string }
    background('answer', runner.answer(c.req.param('id'), text))
    return c.json({ ok: true })
  })
  app.post('/api/tickets/:id/push', async (c) => {
    await runner.push(c.req.param('id'))
    return c.json({ ok: true })
  })

  app.post('/api/tickets/:id/ready', async (c) => {
    const { reviewers } = await runner.markReady(c.req.param('id'))
    return c.json({ ok: true, reviewers })
  })
  // text + optional images as base64 (pasted or picked in the app)
  app.post('/api/tickets/:id/instruct', async (c) => {
    const id = c.req.param('id')
    const { text, images } = (await c.req.json()) as { text?: string; images?: { name: string; data: string }[] }
    if (!text?.trim()) return c.json({ ok: false, error: 'say what to change' }, 400)
    const list = (images ?? []).slice(0, 6).map((i) => ({ name: i.name || 'image.png', bytes: Buffer.from(i.data.replace(/^data:[^,]+,/, ''), 'base64') }))
    if (list.some((i) => i.bytes.length > 10 * 1024 * 1024)) return c.json({ ok: false, error: 'images up to 10 MB each' }, 400)
    const t = store.get(id)
    if (!t?.worktree) return c.json({ ok: false, error: `${id} has no worktree yet; start it first` }, 400)
    if (t.status === 'running' || t.status === 'queued') return c.json({ ok: false, error: `${id} has a lane running; send it when it finishes` }, 409)
    background(`${id}: instruction`, runner.instruct(id, text, list))
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
  app.post('/api/tickets/:id/greptile-fix', (c) => {
    const id = c.req.param('id')
    const t = store.get(id)
    if (!t?.pr?.greptile?.findings.length) return c.json({ ok: false, error: 'no Greptile findings on this PR' }, 400)
    background(`${id}: greptile fix`, runner.fixGreptile(id))
    return c.json({ ok: true })
  })
  app.post('/api/tickets/:id/stop', async (c) => {
    await runner.stop(c.req.param('id'))
    return c.json({ ok: true })
  })
  app.post('/api/tickets/:id/resume', (c) => {
    const id = c.req.param('id')
    if (store.get(id)?.status !== 'stopped') return c.json({ ok: false, error: `${id} is not stopped` }, 400)
    background(`${id}: resume`, runner.resume(id))
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
    if (patch.autopilot?.enabled && !store.snapshot().settings?.autopilot?.enabled) store.setSettings({ autopilot: { since: new Date().toISOString() } })
    store.setSettings(patch)
    runner.pump()
    return c.json(controls.settings())
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
    const { picks } = (await c.req.json().catch(() => ({}))) as { picks?: { id: string; note?: string }[] }
    background('fix comments', runner.addressComments(c.req.param('id'), picks))
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
  app.post('/api/reviews/:id/start', (c) => {
    const id = c.req.param('id')
    if (!store.review(id)) return c.json({ ok: false, error: `unknown review ${id}` }, 404)
    background(`${id}: review`, reviews.start(id))
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
      const onTicket = (ticket: Ticket) => void push({ type: 'ticket', ticket })
      const onReview = (review: PrReview) => void push({ type: 'review', review })
      const onLine = (id: string, line: LiveLine) => void push({ type: 'live', id, line })
      const onLabels = (labelColors: Record<string, string>) => void push({ type: 'labels', labelColors })
      store.on('labels', onLabels)
      store.on('ticket', onTicket)
      store.on('review', onReview)
      live.on('line', onLine)
      stream.onAbort(() => {
        store.off('labels', onLabels)
        store.off('ticket', onTicket)
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
    app.get('/', (c) => c.text('metwo daemon running. Build apps/web for the board, or use the Vite dev server on :5173.'))
  }

  serve({ fetch: app.fetch, port }, () => log.info(`http://localhost:${port}`))
}
