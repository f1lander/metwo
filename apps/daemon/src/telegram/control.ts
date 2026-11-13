import { InlineKeyboard } from 'grammy'
import { computeDigest, formatDigest } from '../digest.js'
import { COMMANDS, normalizeId } from './format.js'
import type { Telegram } from './index.js'

// Running mevo itself: stop and resume, update from main, pause, effort, lanes, health, cycle, learnings.
export function wireControl(tg: Telegram): void {
  tg.bot.command('stop', async (ctx) => {
    const id = normalizeId(ctx.match)
    if (!id) {
      const running = tg.store.byStatus('running', 'queued')
      if (running.length === 0) {
        await ctx.reply('nothing running')
        return
      }
      const kb = new InlineKeyboard()
      running.slice(0, 6).forEach((t) => kb.text(`⏹ ${t.id}`, `stopask:${t.id}`))
      await ctx.reply('which one?', { reply_markup: kb })
      return
    }
    await tg.askStop(id)
  })

  tg.bot.callbackQuery(/^stopask:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    await ctx.editMessageReplyMarkup()
    await tg.askStop(ctx.match[1] ?? '')
  })

  tg.bot.callbackQuery(/^stopyes:(.+)$/, async (ctx) => {
    const id = ctx.match[1] ?? ''
    await ctx.answerCallbackQuery({ text: `stopping ${id}…` })
    await ctx.editMessageReplyMarkup()
    await tg.runner.stop(id).then(
      () => tg.sendPlain(`⏹ ${id} stopped. Where it was is in RESUME.md; /resume ${id} continues it, /resume ${id} codex (or claude:sonnet…) on another engine, add fresh to start over.`),
      (e: unknown) => tg.sendPlain(`could not stop ${id}: ${e instanceof Error ? e.message : String(e)}`),
    )
  })

  tg.bot.callbackQuery('stopno', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'left running' })
    await ctx.editMessageReplyMarkup()
  })

  tg.bot.command('stopall', async (ctx) => {
    const n = tg.runner.activeIds.length
    const kb = new InlineKeyboard().text(`⏹ stop ${n} lane(s)`, 'stopall:lanes').row().text('⏹ stop all and shut the daemon down', 'stopall:daemon').row().text('cancel', 'stopno')
    await ctx.reply(`Stop everything?\n${n} lane(s) running · ${tg.store.byStatus('queued').length} queued.\n\nRunning lanes are killed and parked with a RESUME.md, the queue is paused, and data/pending.md lists what is left.`, { reply_markup: kb })
  })

  tg.bot.callbackQuery(/^stopall:(lanes|daemon)$/, async (ctx) => {
    const shutdown = ctx.match[1] === 'daemon'
    await ctx.answerCallbackQuery({ text: 'stopping…' })
    await ctx.editMessageReplyMarkup()
    if (!tg.stopAll) return
    const r = await tg.stopAll(shutdown)
    if (!shutdown) await tg.sendPlain(`⏹ stopped ${r.stopped.length ? r.stopped.join(', ') : 'nothing (no lane was running)'}. Lanes are paused; /resume starts them again. Pending: ${r.pending}`)
  })

  tg.bot.callbackQuery(/^resume:(.+)$/, async (ctx) => {
    const id = ctx.match[1] ?? ''
    await ctx.answerCallbackQuery({ text: `${id}: resuming` })
    await ctx.editMessageReplyMarkup()
    tg.runner.resume(id).catch((e: unknown) => tg.sendPlain(`${id}: ${e instanceof Error ? e.message : String(e)}`))
  })

  tg.bot.command('update', async (ctx) => {
    const id = normalizeId(ctx.match)
    const t = id ? tg.store.get(id) : undefined
    if (!t) {
      await ctx.reply('usage: /update WEB-123 · merges main into the branch; pushes to the PR when the gates pass')
      return
    }
    await ctx.reply(`⬇️ ${id}: merging main${t.behindMain ? ` (${t.behindMain.commits} commit(s)${t.behindMain.conflicts ? ', with conflicts for the lane to resolve' : ''})` : ''}…`)
    tg.runner.updateFromMain(id).then(
      (outcome) => tg.sendPlain(outcome === 'pushed' ? `⬇️ ${id}: up to date with main, gates green, pushed` : outcome === 'merged' ? `⬇️ ${id}: main merged locally, gates green (no PR to push to yet)` : `⬇️ ${id}: the lane is fixing what the merge broke; you'll get the review message`),
      (e: unknown) => tg.sendPlain(`${id}: update failed: ${e instanceof Error ? e.message : String(e)}`),
    )
  })

  tg.bot.command('autopilot', async (ctx) => {
    const want = ctx.match.trim().toLowerCase()
    const ap = tg.runner.config.autopilot
    if (want === 'on' || want === 'off') {
      tg.store.setSettings({ autopilot: { enabled: want === 'on', ...(want === 'on' ? { since: new Date().toISOString() } : {}) } })
      await ctx.reply(want === 'on' ? `🤖 autopilot on: small tickets start by themselves, move to In Progress${ap.autoPush ? ' and get a draft PR when every check passes' : ''} (up to ${ap.maxPerDay} a day). Anything bigger still asks you.` : 'autopilot off: every ticket asks you again')
      return
    }
    await ctx.reply(`autopilot is ${ap.enabled ? 'on' : 'off'}${ap.enabled ? ` · auto draft PR ${ap.autoPush ? 'on' : 'off'} · up to ${ap.maxPerDay} a day` : ''}. /autopilot on|off`)
  })

  tg.bot.command('budget', async (ctx) => {
    const [what, raw] = ctx.match.trim().toLowerCase().split(/\s+/)
    if ((what === 'day' || what === 'month') && raw) {
      const n = raw === 'off' ? null : Number(raw)
      if (n !== null && !(Number.isFinite(n) && n > 0)) {
        await ctx.reply('usage: /budget day 20 · /budget month 300 · /budget day off')
        return
      }
      tg.store.setSettings({ budget: what === 'day' ? { daily: n } : { monthly: n } })
    }
    const b = tg.runner.budget()
    const line = (label: string, p: { spent: number; limit: number | null }) => `${label}: $${p.spent.toFixed(2)}${p.limit ? ` of $${p.limit} (${Math.round((p.spent / p.limit) * 100)}%)` : ' · no limit'}`
    const level = { normal: 'normal', saver: 'saving: effort capped at medium, lite skips the review pass', tight: 'tight: lite on low effort', over: `over: new lanes on ${b.fallback ?? 'Claude only when you start them'}` }[b.level]
    await ctx.reply([line('today', b.day), line('this month', b.month), `mode: ${b.regulate ? level : 'regulation off'}`].join('\n'))
  })

  tg.bot.command('pause', async (ctx) => {
    tg.runner.paused = true
    await ctx.reply('paused: running lanes finish, nothing new starts')
  })

  tg.bot.command('resume', async (ctx) => {
    const id = normalizeId(ctx.match)
    if (id) {
      const t = tg.store.get(id)
      if (t?.status !== 'stopped') {
        await ctx.reply(t ? `${id} is ${t.status.replace('_', ' ')}, not stopped` : `unknown ticket ${id}`)
        return
      }
      // /resume WEB-123 codex · /resume WEB-123 claude:sonnet fresh
      const [, engine, mode] = ctx.match.trim().split(/\s+/)
      const fresh = mode === 'fresh' || engine === 'fresh'
      const ref = engine && engine !== 'fresh' ? engine : undefined
      await ctx.reply(`▶ ${id}: ${fresh ? 'starting over' : 'resuming'}${ref ? ` on ${ref}` : ''}`)
      tg.runner.resume(id, { ...(ref ? { engine: ref } : {}), fresh }).catch((e: unknown) => tg.sendPlain(`${id}: ${e instanceof Error ? e.message : String(e)}`))
      return
    }
    tg.runner.paused = false
    await ctx.reply('lanes running again')
    tg.runner.pump()
  })

  tg.bot.command('effort', async (ctx) => {
    const want = ctx.match.trim().toLowerCase()
    if (!want) {
      await ctx.reply(`lanes run at ${tg.runner.effort} effort (🔥 max only when you start a ticket with max). /effort low|medium|high to change.`)
      return
    }
    if (want !== 'low' && want !== 'medium' && want !== 'high') {
      await ctx.reply('usage: /effort low|medium|high  (max stays a per-ticket choice)')
      return
    }
    tg.runner.setEffort(want)
    await ctx.reply(`effort set to ${want}; applies to lanes that start from now on`)
  })

  tg.bot.command('lanes', async (ctx) => {
    const n = Number(ctx.match.trim())
    if (!ctx.match.trim()) {
      await ctx.reply(`${tg.runner.activeIds.length} running, up to ${tg.runner.maxParallel} at once. /lanes 4 to change.`)
      return
    }
    if (!Number.isFinite(n)) {
      await ctx.reply('usage: /lanes 4')
      return
    }
    const set = tg.runner.setMaxParallel(n)
    const queued = tg.store.byStatus('queued').length
    await ctx.reply(`up to ${set} lanes at once${queued ? ` · ${queued} still queued` : ''}`)
  })

  tg.bot.command('digest', async (ctx) => {
    await ctx.reply(formatDigest(computeDigest(tg.store.all())))
  })

  tg.bot.command('health', async (ctx) => {
    const h = tg.healthSnapshot?.()
    if (!h) {
      await ctx.reply('health not available')
      return
    }
    const mark = (ok: boolean | null) => (ok === true ? '🟢' : ok === false ? '🔴' : '⚪')
    const lines = [
      `${mark(h.daemon.ok)} daemon · pid ${h.pid} · ${h.daemon.detail}`,
      `${mark(h.telegram.ok)} telegram · ${h.telegram.bot ?? ''} ${h.telegram.detail}`,
      `${mark(h.linear.ok)} linear · ${h.linear.detail}${h.linear.lastPollAt ? ` · last poll ${h.linear.lastPollAt.slice(11, 19)}` : ''}`,
      `${mark(h.github.ok)} github · ${h.github.detail}`,
      `${mark(h.claude.ok)} claude · ${h.claude.detail}`,
      `${mark(h.e2e.ok)} e2e · ${h.e2e.detail}`,
      `${mark(h.tunnel.ok)} tunnel · ${h.tunnel.url ?? h.tunnel.detail}`,
      `lanes · ${h.lanes.active.length}/${h.lanes.max}${h.lanes.paused ? ' · paused' : ''}${h.lanes.active.length ? ` · ${h.lanes.active.join(', ')}` : ''}`,
    ]
    await ctx.reply(lines.join('\n'))
  })

  tg.bot.command('tunnel', async (ctx) => {
    const link = tg.dashboardLink?.()
    // no preview: Telegram's preview fetch would spend the one-time code before you tap it
    await ctx.reply(link ?? 'tunnel is off (server.tunnel in ticketflow.config.json) or still starting', { link_preview_options: { is_disabled: true } })
  })

  tg.bot.command('signout', async (ctx) => {
    const n = tg.revokeSessions?.() ?? 0
    await ctx.reply(`Signed out ${n} dashboard session${n === 1 ? '' : 's'}. /tunnel gives a new one-time link.`)
  })

  tg.bot.command('help', async (ctx) => {
    await ctx.reply([...COMMANDS.filter((c) => c.command !== 'help').map((c) => `/${c.command} – ${c.description}`), 'reply to a ❓ message to answer the lane'].join('\n'))
  })

  tg.bot.command('ghlogin', async (ctx) => {
    if (!tg.githubLogin) {
      await ctx.reply('browser uploads are off (github.screenshots is not "browser")')
      return
    }
    await ctx.reply('opened a Chrome window on the Mac at github.com/login. Sign in there (Google or password, 2FA works), then close that window. I’ll tell you when it’s done.')
    tg.githubLogin()
      .then((login) => tg.sendPlain(`🔐 signed in to GitHub as ${login}. Screenshots and videos will attach to PRs.`))
      .catch((error: unknown) => tg.sendPlain(`GitHub sign-in did not finish: ${error instanceof Error ? error.message : String(error)}`))
  })

  tg.bot.command('cycle', async (ctx) => {
    await tg.sendCycle((text, kb) => ctx.reply(text, { link_preview_options: { is_disabled: true }, ...(kb ? { reply_markup: kb } : {}) }))
  })

  tg.bot.callbackQuery(/^asg:(.+)$/, async (ctx) => {
    const id = ctx.match[1] ?? ''
    await ctx.answerCallbackQuery({ text: `taking ${id}…` })
    await tg.sendPlain(await tg.assignReply([id]))
  })

  tg.bot.callbackQuery('asgall', async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'taking them all…' })
    await ctx.editMessageReplyMarkup()
    await tg.sendPlain(tg.lastCycle.length ? await tg.assignReply(tg.lastCycle) : 'list expired, send /cycle again')
  })

  tg.bot.command('learn', async (ctx) => {
    if (!tg.curate) return
    await ctx.reply('📚 reading recent PR feedback…')
    tg.curate().then(
      (n) => tg.sendPlain(n ? `📚 ${n} proposed rule(s) above; approve or reject each` : '📚 nothing new worth a rule'),
      (e: unknown) => tg.sendPlain(`curator failed: ${e instanceof Error ? e.message : String(e)}`),
    )
  })

  tg.bot.command('learnings', async (ctx) => {
    const view = tg.learnings?.view()
    if (!view?.proposals.length) {
      await ctx.reply('no proposals waiting. /learn reads the latest feedback')
      return
    }
    await tg.notifyLearnings(view.proposals)
  })

  tg.bot.callbackQuery(/^lrn:(ok|no):(.+)$/, async (ctx) => {
    const approve = ctx.match[1] === 'ok'
    const p = tg.learnings?.decide(ctx.match[2] ?? '', approve)
    await ctx.answerCallbackQuery({ text: p ? (approve ? 'added to learnings/rules.md' : 'rejected') : 'already decided' })
    await ctx.editMessageReplyMarkup()
  })

}
