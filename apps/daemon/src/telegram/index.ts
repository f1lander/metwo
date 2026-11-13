import { Bot, InlineKeyboard } from 'grammy'
import { type CycleView, type Health, type LearningProposal, modelName, type Ticket } from '@ticketflow/shared'
import { explainFailure } from '../failure.js'
import type { HealthTracker } from '../health.js'
import type { Learnings } from '../learnings.js'
import type { LinearWriter } from '../linear-writer.js'
import type { LiveLog } from '../live-log.js'
import { log } from '../log.js'
import type { Reviews } from '../reviews.js'
import type { Runner } from '../runner/index.js'
import type { Store } from '../store.js'
import { wireControl } from './control.js'
import { COMMANDS, esc, STATUS_ICON } from './format.js'
import { wireMessages } from './messages.js'
import { makeNotifier } from './notifier.js'
import { wireReviews } from './reviews.js'
import { wireTickets } from './tickets.js'

function readinessLines(t: Ticket): string {
  const r = t.readiness
  if (!r) return ''
  const icon = r.verdict === 'ready' ? '✅' : r.verdict === 'clarify' ? '❓' : '⏸'
  const head = `${icon} ${esc(`${r.verdict === 'ready' ? 'ready to start' : r.verdict === 'clarify' ? 'needs clarification' : 'hold'} · ${r.confidence}% · ${r.why}`)}`
  return `${[head, ...r.questions.slice(0, 4).map((q) => esc(`• ${q}`))].join('\n')}\n`
}

export class Telegram {
  readonly bot: Bot
  readonly chatId: string
  // message id → ticket id, so a plain reply to a question reaches the right lane
  readonly questionMessages = new Map<number, string>()
  lastCycle: readonly string[] = []
  photos: { name: string; bytes: Buffer; at: number }[] = []

  // wired by the daemon after construction
  dashboardLink: (() => string | null) | null = null
  // signs every phone and browser out of the dashboard
  revokeSessions: (() => number) | null = null
  linearWriter: LinearWriter | null = null
  healthSnapshot: (() => Health) | null = null
  githubLogin: (() => Promise<string>) | null = null
  curate: (() => Promise<number>) | null = null
  learnings: Learnings | null = null
  reviews: Reviews | null = null
  stopAll: ((shutdown: boolean) => Promise<{ stopped: readonly string[]; pending: string }>) | null = null
  cycle: (() => Promise<CycleView>) | null = null
  assign: ((ids: readonly string[]) => Promise<{ assigned: string[]; failed: { id: string; error: string }[] }>) | null = null

  async moveInLinear(id: string, to: 'qa' | 'done'): Promise<string> {
    if (!this.linearWriter) return 'Linear is not wired yet'
    try {
      const t = await this.linearWriter.move(id, to)
      return `${id} → ${t.linearState} in Linear${to === 'qa' ? ' · hand-off comment posted' : ''}`
    } catch (error) {
      return `could not move ${id}: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  async notifyStopped(tickets: readonly Ticket[]): Promise<void> {
    const kb = new InlineKeyboard()
    tickets.slice(0, 6).forEach((t, i) => {
      kb.text(`▶ ${t.id}`, `resume:${t.id}`)
      if (i % 3 === 2) kb.row()
    })
    const lines = tickets.slice(0, 10).map((t) => `${t.id} · ${t.stopped?.reason ?? 'stopped'}\n   ${t.title.slice(0, 80)}`)
    await this.bot.api.sendMessage(this.chatId, `⏹ ${tickets.length} ticket(s) stopped mid-run, waiting for you to resume:\n\n${lines.join('\n')}`, { reply_markup: kb, link_preview_options: { is_disabled: true } }).catch((e: unknown) => log.warn('telegram send failed', e))
  }

  async askStop(id: string): Promise<void> {
    const t = this.store.get(id)
    if (!t || !['running', 'queued'].includes(t.status)) {
      await this.sendPlain(t ? `${id} is ${t.status.replace('_', ' ')}, nothing to stop` : `unknown ticket ${id}`)
      return
    }
    const kb = new InlineKeyboard().text('⏹ yes, stop it', `stopyes:${id}`).text('cancel', 'stopno')
    await this.bot.api.sendMessage(this.chatId, `Stop ${id}?\n${t.title}\n\nThe lane and the dev servers it started are killed. Commits stay, and RESUME.md keeps where it was so Resume can continue.`, { reply_markup: kb })
  }

  async notifyLearnings(proposals: readonly LearningProposal[]): Promise<void> {
    for (const p of proposals.slice(0, 5)) {
      const kb = new InlineKeyboard().text('✅ approve', `lrn:ok:${p.id}`).text('✕ reject', `lrn:no:${p.id}`)
      await this.bot.api.sendMessage(this.chatId, `📚 proposed rule · ${p.area}\n${p.rule}\n\nwhy: ${p.why}${p.sources.length ? `\n${p.sources.join('\n')}` : ''}`, { reply_markup: kb, link_preview_options: { is_disabled: true } }).catch((e: unknown) => log.warn('telegram send failed', e))
    }
  }

  async sendCycle(reply?: (text: string, kb?: InlineKeyboard) => Promise<unknown>): Promise<void> {
    const say = reply ?? ((text: string, kb?: InlineKeyboard) => this.bot.api.sendMessage(this.chatId, text, { link_preview_options: { is_disabled: true }, ...(kb ? { reply_markup: kb } : {}) }))
    if (!this.cycle) return
    try {
      const view = await this.cycle()
      if (!view.cycle) {
        await say('no active cycle for the team right now')
        return
      }
      const list = view.issues.slice(0, 10)
      this.lastCycle = list.map((i) => i.id)
      if (list.length === 0) {
        await say(`${view.cycle.name}: nothing unassigned left 🎉`)
        return
      }
      const kb = new InlineKeyboard()
      list.forEach((i, n) => {
        kb.text(`＋ ${i.id}`, `asg:${i.id}`)
        if (n % 3 === 2) kb.row()
      })
      kb.row().text(`take all ${list.length}`, 'asgall')
      const lines = list.map((i) => `${i.id} · ${i.priorityLabel}${i.estimate ? ` · ${i.estimate}pt` : ''} · ${i.state}\n   ${i.title.slice(0, 90)}`)
      await say(`📥 ${view.cycle.name} · ${view.issues.length} unassigned (ends ${view.cycle.endsAt.slice(0, 10)})\n\n${lines.join('\n')}`, kb)
    } catch (error) {
      await say(`could not read the cycle: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async assignReply(ids: readonly string[]): Promise<string> {
    if (!this.assign) return 'assigning is not wired'
    const r = await this.assign(ids)
    return [r.assigned.length ? `assigned to you: ${r.assigned.join(', ')}` : '', ...r.failed.map((f) => `could not take ${f.id}: ${f.error}`)].filter(Boolean).join('\n') || 'nothing assigned'
  }

  async ready(id: string): Promise<string> {
    try {
      const { ticket: t, reviewers } = await this.runner.markReady(id)
      const g = t.pr?.greptile
      return [
        `✅ ${id} ready for review${g ? ` · Greptile ${g.score ?? '?'}/5${g.findings.length ? ` with ${g.findings.length} open finding(s)` : ''}` : ''}`,
        reviewers.length ? `review requested from ${reviewers.join(', ')}` : 'no suggested reviewers to add (CODEOWNERS still applies)',
        t.prUrl ?? '',
      ].join('\n')
    } catch (error) {
      return `could not mark ${id} ready: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  async sendPlain(text: string): Promise<void> {
    await this.bot.api.sendMessage(this.chatId, text, { link_preview_options: { is_disabled: true } }).catch((e: unknown) => log.error('telegram send failed', e))
  }

  constructor(
    readonly token: string,
    chatId: string,
    readonly store: Store,
    readonly runner: Runner,
    readonly live: LiveLog,
    readonly health: HealthTracker,
  ) {
    // no token: mevo runs without Telegram, every send is a no-op
    this.bot = new Bot(token || '0:off')
    if (!token) this.bot.api.config.use(async () => ({ ok: true, result: true }) as never)
    this.chatId = chatId
    this.wire()
  }

  async start(): Promise<void> {
    if (!this.token) {
      this.health.telegram = { ok: null, detail: 'off: no TELEGRAM_BOT_TOKEN', at: new Date().toISOString(), bot: null }
      return
    }
    try {
      const me = await this.bot.api.getMe()
      this.health.telegram = { ...this.health.ok(), detail: 'polling', bot: `@${me.username}` }
    } catch (error) {
      this.health.telegram = { ...this.health.bad(`cannot reach Telegram: ${String(error)}`), bot: null }
    }
    await this.bot.api.setMyCommands(COMMANDS).catch((e: unknown) => log.warn('setMyCommands failed', e))
    void this.bot.start({ onStart: () => log.info('telegram bot polling') }).catch((error: unknown) => {
      log.error('telegram polling stopped', error)
      this.health.telegram = { ...this.health.bad(`polling stopped: ${String(error)}`), bot: this.health.telegram.bot }
    })
  }

  async restart(): Promise<void> {
    await this.bot.stop().catch(() => undefined)
    await this.start()
  }

  async notifyNew(ticket: Ticket): Promise<void> {
    const kb = new InlineKeyboard()
      .text('⚡ lite', `start:lite:${ticket.id}`)
      .text('🏗 full', `start:full:${ticket.id}`)
      .text('🔥 max', `start:max:${ticket.id}`)
      .row()
    // other enabled engines get their own row: same lite lane, different implementer
    for (const e of this.runner.engineList.filter((x) => x.id !== 'claude')) kb.text(`⚡ ${e.label}`, `starte:${e.id}:${ticket.id}`)
    kb.row().text('skip', `skip:${ticket.id}`)
    await this.send(
      `${STATUS_ICON.assigned} *${esc(ticket.id)}* ${esc(ticket.title)}\n` +
        `by ${esc(ticket.createdBy)} · ${esc(ticket.labels.join(', ') || 'no labels')} · ${esc(ticket.linearState)}\n` +
        `suggest: *${ticket.suggestedLane}* — ${esc(ticket.reason)}\n${readinessLines(ticket)}${esc(ticket.url)}`,
      kb,
    )
  }

  progressText(id: string): string | null {
    const t = id ? this.store.get(id) : undefined
    if (!t) return null
    const events = t.events.slice(-8).map((e) => `${e.at.slice(11, 16)} ${e.kind}: ${e.message.slice(0, 120)}`)
    const live = this.live.recent(t.id, 6).map((l) => `${l.at.slice(11, 16)} ${l.text.split('\n')[0]?.slice(0, 140)}`)
    const failure = t.status === 'failed' && t.failure ? `${t.failure.title}\n→ ${t.failure.hint}` : t.status === 'failed' && t.error ? `error: ${t.error}` : ''
    return [
      `${STATUS_ICON[t.status]} ${t.id} · ${t.status.replace('_', ' ')}${t.lane ? ` (${t.lane}${t.model ? ` · ${modelName(t.model)} ${t.effort ?? ''}` : ''})` : ''}`,
      t.title,
      t.worktree ? `worktree: ${t.worktree}${t.port ? ` · :${t.port}` : ''}` : '',
      t.prUrl ? `pr: ${t.prUrl}` : '',
      t.question ? `question: ${t.question.slice(0, 300)}` : '',
      failure,
      '',
      ...events,
      ...(live.length ? ['', 'last activity:', ...live.map((l) => `  ${l}`)] : []),
    ]
      .filter((l, i, arr) => l !== '' || (i > 0 && arr[i - 1] !== ''))
      .join('\n')
  }

  async notifyPushFailed(id: string, error: unknown): Promise<void> {
    const f = explainFailure(error instanceof Error ? error.message : String(error))
    const message = error instanceof Error ? error.message : String(error)
    if (message.startsWith('Local checks failed')) {
      const kb = new InlineKeyboard().text('🔧 lane fixes it', `fixlocal:${id}`).text('push anyway', `pushf:${id}`)
      await this.send(`❌ *${esc(id)}* not pushed: ${esc(message)}`, kb)
      return
    }
    const kb = new InlineKeyboard().text('↻ try push again', `push:${id}`)
    await this.send(`${STATUS_ICON.failed} *${esc(id)}* · push failed: ${esc(f.title)}\n${esc(f.detail.slice(0, 400))}\n\n→ ${esc(f.hint)}`, kb)
  }

  async notifyAutoStarted(ticket: Ticket): Promise<void> {
    const push = this.runner.config.autopilot.autoPush
    await this.send(
      `🤖 *${esc(ticket.id)}* autopilot took it \\(lite\\): ${esc(ticket.reason)}\n${esc(ticket.title)}\n_moves to In Progress in Linear${push ? ' and opens a draft PR if every check passes' : '; you push when it is ready'}_`,
    )
  }

  readonly notifier = makeNotifier(this)

  private wire(): void {
    this.bot.use(async (ctx, next) => {
      if (String(ctx.chat?.id) !== this.chatId) return
      const data = ctx.callbackQuery?.data
      const text = ctx.message?.text
      if (data || text?.startsWith('/')) this.store.history.record({ type: 'action', via: 'telegram', action: data ?? text?.split(/\s/)[0] ?? '', ...(/(WEB-\d+|[A-Z]+-\d+)/.exec(data ?? text ?? '')?.[1] ? { ticket: /(WEB-\d+|[A-Z]+-\d+)/.exec(data ?? text ?? '')?.[1] } : {}) })
      else if (text) this.store.history.record({ type: 'action', via: 'telegram', action: 'message' })
      await next()
    })

    wireTickets(this)
    wireControl(this)
    wireReviews(this)
    wireMessages(this)

    this.bot.catch((err) => log.error('telegram', err.error))
  }

  // Adds a PR to your reviews and, when asked, starts it right away.
  async offerReview(input: string, start = false): Promise<void> {
    if (!this.reviews) return
    try {
      const r = await this.reviews.add(input)
      if (start || r.status === 'new') {
        await this.sendPlain(`🔎 #${r.number} ${r.title}: review started. You'll get the findings here.`)
        this.reviews.start(r.id).catch((e: unknown) => this.sendPlain(`#${r.number}: ${e instanceof Error ? e.message : String(e)}`))
      } else {
        await this.sendPlain(`#${r.number} is already on your list (${r.status})`)
      }
    } catch (error) {
      await this.sendPlain(`could not add that PR: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // set by registerAssistant: plain questions go to the assistant
  askAssistant: ((question: string) => Promise<void>) | null = null
  // a Linear link or id pasted here: onto the board (assigned to you, or only tracked)
  importIssue: ((ref: string, assign: boolean) => Promise<Ticket>) | null = null
  readonly pending = new Map<string, { id: string | null; text: string; images: { name: string; bytes: Buffer }[] }>()

  // screenshots sent in the last 5 minutes go with the next instruction
  takePhotos(): { name: string; bytes: Buffer }[] {
    const fresh = this.photos.filter((p) => Date.now() - p.at < 5 * 60_000)
    this.photos = []
    return fresh.map(({ name, bytes }) => ({ name, bytes }))
  }

  async download(fileId: string): Promise<Buffer | null> {
    try {
      const file = await this.bot.api.getFile(fileId)
      if (!file.file_path) return null
      const res = await fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`)
      return res.ok ? Buffer.from(await res.arrayBuffer()) : null
    } catch {
      return null
    }
  }

  // Nothing runs until you confirm: shows what will be sent, or asks which ticket.
  async proposeInstruction(id: string | null, text: string, images: { name: string; bytes: Buffer }[]): Promise<void> {
    const key = Math.random().toString(36).slice(2, 10)
    const p = { id: id && this.store.get(id) ? id : null, text: text.trim(), images }
    this.pending.set(key, p)
    setTimeout(() => this.pending.delete(key), 30 * 60_000)
    if (p.id) {
      await this.confirmInstruction(key, p)
      return
    }
    const open = this.store.all().filter((t) => t.worktree && !['done', 'skipped', 'running', 'queued'].includes(t.status)).slice(0, 8)
    // no ticket named and nothing with images: most likely a question for the assistant
    if (this.askAssistant && (open.length === 0 || (p.images.length === 0 && /\?\s*$|^(what|which|que|qué|cual|cuál|cuales|cuáles|how|como|cómo|dame|show|muestra|take|toma|review|revisa)\b/i.test(p.text)))) {
      this.pending.delete(key)
      await this.askAssistant(p.text)
      return
    }
    const kb = new InlineKeyboard()
    if (this.askAssistant) kb.text('🤔 ask mevo instead', `askq:${key}`).row()
    open.forEach((t, i) => {
      kb.text(t.id, `tellfor:${key}:${t.id}`)
      if (i % 3 === 2) kb.row()
    })
    kb.row().text('cancel', `tellno:${key}`)
    await this.bot.api.sendMessage(this.chatId, `Which ticket is this for?\n“${p.text.slice(0, 200)}”`, { reply_markup: kb })
  }

  async confirmInstruction(key: string, p: { id: string | null; text: string; images: unknown[] }): Promise<void> {
    const t = p.id ? this.store.get(p.id) : undefined
    if (!t) return
    const busy = t.status === 'running' || t.status === 'queued'
    const kb = new InlineKeyboard().text('🛠 send to the lane', `tell:${key}`).text('cancel', `tellno:${key}`)
    await this.bot.api.sendMessage(
      this.chatId,
      `${t.id} · ${t.title}\n\n“${p.text.slice(0, 600)}”${p.images.length ? `\n📎 ${p.images.length} screenshot(s)` : ''}\n\n${busy ? '⚠️ a lane is running on it now; this will fail until it finishes.' : `The lane fixes it in the worktree, re-checks it${p.images.length ? ' visually' : ''} and comes back for your review. Nothing is pushed.`}`,
      { reply_markup: kb },
    )
  }

  async send(text: string, kb?: InlineKeyboard) {
    const extra = { link_preview_options: { is_disabled: true }, ...(kb ? { reply_markup: kb } : {}) }
    try {
      const msg = await this.bot.api.sendMessage(this.chatId, text, { parse_mode: 'MarkdownV2', ...extra })
      this.health.telegram = { ...this.health.telegram, ok: true, detail: 'polling', at: new Date().toISOString() }
      return msg
    } catch (error) {
      // A formatting slip must not swallow the notification: resend as plain text.
      log.warn('telegram markdown send failed, retrying plain', error)
      try {
        return await this.bot.api.sendMessage(this.chatId, text.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, '$1'), extra)
      } catch (plainError) {
        log.error('telegram send failed', plainError)
        this.health.telegram = { ...this.health.bad(`send failed: ${String(plainError)}`), bot: this.health.telegram.bot }
        return null
      }
    }
  }
}
