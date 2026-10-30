import { modelName, type StartChoice, type Ticket } from '@ticketflow/shared'
import { esc, normalizeId, STATUS_ICON } from './format.js'
import type { Telegram } from './index.js'

// Ticket commands and buttons: status, start, push, ready, Linear moves, visual check, Greptile.
export function wireTickets(tg: Telegram): void {
  tg.bot.command('status', async (ctx) => {
    const lines = tg.store
      .all()
      .filter((t) => !['done', 'skipped'].includes(t.status))
      .map((t) => {
        const tail = tg.live.last(t.id)?.text.slice(0, 120)
        return `${STATUS_ICON[t.status]} ${t.id} ${t.status}${t.lane ? ` (${t.lane}${t.model ? ` · ${modelName(t.model)} ${t.effort ?? ''}` : ''})` : ''}${tail ? `\n   ${tail}` : ''}`
      })
    await ctx.reply(lines.join('\n') || 'nothing in flight')
  })

  tg.bot.command('list', async (ctx) => {
    const waiting = tg.store.byStatus('assigned')
    if (waiting.length === 0) {
      await ctx.reply('nothing waiting for a decision')
      return
    }
    for (const t of waiting) await tg.notifyNew(t)
  })

  tg.bot.command('tickets', async (ctx) => {
    const groups = new Map<string, string[]>()
    for (const t of tg.store.all()) {
      const list = groups.get(t.status) ?? []
      list.push(`  ${t.id} ${t.title.slice(0, 48)}${t.prUrl ? ` · PR` : ''}`)
      groups.set(t.status, list)
    }
    const order: Ticket['status'][] = ['needs_input', 'review_ready', 'no_change', 'stopped', 'running', 'queued', 'assigned', 'pr_draft', 'failed', 'done', 'skipped']
    const text = order
      .filter((s) => groups.has(s))
      .map((s) => `${STATUS_ICON[s]} ${s} (${groups.get(s)?.length})\n${groups.get(s)?.join('\n')}`)
      .join('\n\n')
    await ctx.reply(text || 'no tickets tracked yet')
  })

  tg.bot.callbackQuery(/^progress:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    await ctx.reply(tg.progressText(ctx.match[1] ?? '') ?? 'unknown ticket')
  })

  tg.bot.command('progress', async (ctx) => {
    const text = tg.progressText(normalizeId(ctx.match))
    await ctx.reply(text ?? 'usage: /progress WEB-123')
  })

  tg.bot.command('start', async (ctx) => {
    const [rawId, rawLane, rawEngine] = ctx.match.trim().split(/\s+/)
    const id = normalizeId(rawId ?? '')
    const lane: StartChoice = rawLane === 'full' || rawLane === 'max' ? rawLane : 'lite'
    const t = id ? tg.store.get(id) : undefined
    if (!t) {
      await ctx.reply('usage: /start WEB-123 lite|full|max [claude|codex|cursor|opencode|hermes]')
      return
    }
    if (!['assigned', 'skipped', 'failed', 'no_change'].includes(t.status)) {
      await ctx.reply(`${t.id} is ${t.status}; can only start assigned, skipped, failed or no_change tickets`)
      return
    }
    const engine = rawEngine && tg.runner.engineList.some((e) => e.id === rawEngine.split(':')[0]) ? rawEngine : undefined
    if (rawEngine && !engine) {
      await ctx.reply(`${rawEngine} is not enabled; see the engines section of the config`)
      return
    }
    tg.runner.enqueue(t.id, lane, engine)
    await ctx.reply(`${t.id} queued (${lane}${engine ? ` on ${engine}` : ''})`)
    tg.runner.pump()
  })

  tg.bot.command('push', async (ctx) => {
    const id = normalizeId(ctx.match)
    const t = id ? tg.store.get(id) : undefined
    if (!t || t.status !== 'review_ready') {
      await ctx.reply(t ? `${t.id} is ${t.status}, not review_ready` : 'usage: /push WEB-123')
      return
    }
    await ctx.reply(`pushing ${t.id}…`)
    try {
      await tg.runner.push(t.id)
    } catch (error) {
      await tg.notifyPushFailed(t.id, error)
    }
  })

  tg.bot.command('skip', async (ctx) => {
    const id = normalizeId(ctx.match)
    const t = id ? tg.store.get(id) : undefined
    if (!t) {
      await ctx.reply('usage: /skip WEB-123')
      return
    }
    tg.runner.skip(t.id)
    await ctx.reply(`${t.id} skipped`)
  })

  for (const to of ['qa', 'done'] as const) {
    tg.bot.command(to, async (ctx) => {
      const id = normalizeId(ctx.match)
      if (!id || !tg.store.get(id)) {
        await ctx.reply(`usage: /${to} WEB-123`)
        return
      }
      await ctx.reply(await tg.moveInLinear(id, to))
    })
  }

  tg.bot.callbackQuery(/^lin:(qa|done):(.+)$/, async (ctx) => {
    const to = ctx.match[1] as 'qa' | 'done'
    const id = ctx.match[2] ?? ''
    await ctx.answerCallbackQuery({ text: `moving ${id}…` })
    await ctx.editMessageReplyMarkup()
    await ctx.reply(await tg.moveInLinear(id, to))
  })

  tg.bot.command('dismiss', async (ctx) => {
    const id = normalizeId(ctx.match)
    if (!id || !tg.store.get(id)) {
      await ctx.reply('usage: /dismiss WEB-123')
      return
    }
    tg.runner.markDone(id)
    await ctx.reply(`${id} closed in metwo (Linear untouched)`)
  })

  tg.bot.command('note', async (ctx) => {
    const [rawId = '', ...rest] = ctx.match.trim().split(/\s+/)
    const id = normalizeId(rawId)
    const text = rest.join(' ').trim()
    if (!id || !tg.store.get(id) || !text) {
      await ctx.reply('usage: /note WEB-123 what you want to remember')
      return
    }
    tg.store.journal(id, { kind: 'note', title: 'Note (from Telegram)', body: text })
    await ctx.reply(`noted on ${id}`)
  })

  tg.bot.callbackQuery(/^starte:(\w+):(.+)$/, async (ctx) => {
    const engine = ctx.match[1] ?? ''
    const id = ctx.match[2] ?? ''
    tg.runner.enqueue(id, 'lite', engine)
    tg.runner.pump()
    await ctx.answerCallbackQuery({ text: `${id}: lite on ${engine}` })
    await ctx.editMessageReplyMarkup()
  })

  tg.bot.callbackQuery(/^start:(lite|full|max):(.+)$/, async (ctx) => {
    const lane = ctx.match[1] as StartChoice
    const id = ctx.match[2] ?? ''
    tg.runner.enqueue(id, lane)
    tg.runner.pump()
    const waiting = tg.store.get(id)?.status === 'queued'
    await ctx.answerCallbackQuery({ text: waiting ? `${id} queued: ${tg.runner.maxParallel} lane(s) busy. /lanes to raise it` : `${id} started (${lane})` })
    await ctx.editMessageReplyMarkup()
  })

  tg.bot.callbackQuery(/^done:(.+)$/, async (ctx) => {
    const id = ctx.match[1] ?? ''
    tg.runner.markDone(id)
    await ctx.answerCallbackQuery({ text: `${id} done` })
    await ctx.editMessageReplyMarkup()
  })

  tg.bot.callbackQuery(/^skip:(.+)$/, async (ctx) => {
    const id = ctx.match[1] ?? ''
    tg.runner.skip(id)
    await ctx.answerCallbackQuery({ text: `${id} skipped` })
    await ctx.editMessageReplyMarkup()
  })

  tg.bot.callbackQuery(/^push:(.+)$/, async (ctx) => {
    const id = ctx.match[1] ?? ''
    await ctx.answerCallbackQuery({ text: `pushing ${id}…` })
    await ctx.editMessageReplyMarkup()
    try {
      await tg.runner.push(id)
    } catch (error) {
      await tg.notifyPushFailed(id, error)
    }
  })

  tg.bot.callbackQuery(/^fix:(.+)$/, async (ctx) => {
    const id = ctx.match[1] ?? ''
    await ctx.answerCallbackQuery({ text: `${id} lane resuming on the comments` })
    await ctx.editMessageReplyMarkup()
    tg.runner.addressComments(id).catch(async (error: unknown) => {
      await tg.send(`${STATUS_ICON.failed} *${esc(id)}* ${esc(error instanceof Error ? error.message : String(error))}`)
    })
  })

  tg.bot.callbackQuery(/^cfix:([^:]+):(.+)$/, async (ctx) => {
    const id = ctx.match[1] ?? ''
    const comment = ctx.match[2] ?? ''
    await ctx.answerCallbackQuery({ text: `${id}: lane on that comment` })
    tg.runner.addressComments(id, [{ id: comment }]).catch(async (error: unknown) => {
      await tg.send(`${STATUS_ICON.failed} *${esc(id)}* ${esc(error instanceof Error ? error.message : String(error))}`)
    })
  })

  tg.bot.callbackQuery(/^cign:([^:]+):(.+)$/, async (ctx) => {
    tg.runner.ignoreComments(ctx.match[1] ?? '', [ctx.match[2] ?? ''])
    await ctx.answerCallbackQuery({ text: 'ignored; it will not come back' })
  })

  tg.bot.callbackQuery(/^ready:(.+)$/, async (ctx) => {
    const id = ctx.match[1] ?? ''
    await ctx.answerCallbackQuery({ text: `${id}: marking ready…` })
    await ctx.editMessageReplyMarkup()
    await tg.sendPlain(await tg.ready(id))
  })

  tg.bot.command('ready', async (ctx) => {
    const id = normalizeId(ctx.match)
    if (!id || !tg.store.get(id)) {
      await ctx.reply('usage: /ready WEB-123')
      return
    }
    await ctx.reply(await tg.ready(id))
  })

  tg.bot.callbackQuery(/^retag:(.+)$/, async (ctx) => {
    const id = ctx.match[1] ?? ''
    await ctx.answerCallbackQuery({ text: `${id}: tagging Greptile` })
    await ctx.editMessageReplyMarkup()
    await tg.runner.retagGreptile(id).then(
      () => tg.sendPlain(`🦎 ${id}: asked Greptile for a new review`),
      (e: unknown) => tg.sendPlain(`could not tag Greptile on ${id}: ${e instanceof Error ? e.message : String(e)}`),
    )
  })

  tg.bot.command('visual', async (ctx) => {
    const id = normalizeId(ctx.match)
    if (!id || !tg.store.get(id)) {
      await ctx.reply('usage: /visual WEB-123 · shoots the changed screens again and gives a verdict (no code changes)')
      return
    }
    await ctx.reply(`👁 ${id}: visual check started`)
    tg.runner.runVisualCheck(id).catch((e: unknown) => tg.sendPlain(`${id}: ${e instanceof Error ? e.message : String(e)}`))
  })

  tg.bot.callbackQuery(/^visrun:(.+)$/, async (ctx) => {
    const id = ctx.match[1] ?? ''
    await ctx.answerCallbackQuery({ text: `${id}: visual check started` })
    await ctx.editMessageReplyMarkup()
    tg.runner.runVisualCheck(id).catch((e: unknown) => tg.sendPlain(`${id}: ${e instanceof Error ? e.message : String(e)}`))
  })

  tg.bot.callbackQuery(/^qarun:(.+)$/, async (ctx) => {
    const id = ctx.match[1] ?? ''
    await ctx.answerCallbackQuery({ text: `${id}: QA on the preview started` })
    await ctx.editMessageReplyMarkup()
    tg.runner.runPreviewQa(id).catch((e: unknown) => tg.sendPlain(`${id}: ${e instanceof Error ? e.message : String(e)}`))
  })

  for (const [key, desc] of [['qapost', false], ['qadesc', true]] as const) {
    tg.bot.callbackQuery(new RegExp(`^${key}:(.+)$`), async (ctx) => {
      const id = ctx.match?.[1] ?? ''
      await ctx.answerCallbackQuery({ text: `${id}: posting the QA round` })
      await ctx.editMessageReplyMarkup()
      await tg.runner.postPreviewQa(id).then(
        (url) => tg.sendPlain(`🧪 ${id}: posted ${url ?? ''}${desc ? '\npreparing the description changes…' : ''}`),
        (e: unknown) => tg.sendPlain(`${id}: ${e instanceof Error ? e.message : String(e)}`),
      )
      if (desc) tg.runner.proposeDescription(id, 'manual').catch((e: unknown) => tg.sendPlain(`${id}: ${e instanceof Error ? e.message : String(e)}`))
    })
  }

  tg.bot.command('preview', async (ctx) => {
    const id = normalizeId(ctx.match)
    if (!id || !tg.store.get(id)) {
      await ctx.reply('usage: /preview WEB-123 · test the PR on its preview deploy')
      return
    }
    await ctx.reply(`🧪 ${id}: testing on the preview…`)
    tg.runner.runPreviewQa(id).catch((e: unknown) => tg.sendPlain(`${id}: ${e instanceof Error ? e.message : String(e)}`))
  })

  tg.bot.callbackQuery(/^visdesc:(.+)$/, async (ctx) => {
    const id = ctx.match[1] ?? ''
    await ctx.answerCallbackQuery({ text: `${id}: reading the PR description` })
    await ctx.editMessageReplyMarkup()
    tg.runner.proposeDescription(id, 'visual').catch((e: unknown) => tg.sendPlain(`${id}: ${e instanceof Error ? e.message : String(e)}`))
  })

  for (const [key, comment] of [['descok', true], ['descnc', false]] as const) {
    tg.bot.callbackQuery(new RegExp(`^${key}:(.+)$`), async (ctx) => {
      const id = ctx.match?.[1] ?? ''
      await ctx.answerCallbackQuery({ text: `${id}: updating the PR` })
      await ctx.editMessageReplyMarkup()
      await tg.runner.applyDescription(id, comment ? {} : { comment: null }).then(
        (r) => tg.sendPlain(`📝 ${id}: description updated, ${r.applied} line(s)${r.skipped ? ` (${r.skipped} skipped: edited meanwhile)` : ''} ${r.url ?? ''}`),
        (e: unknown) => tg.sendPlain(`${id}: ${e instanceof Error ? e.message : String(e)}`),
      )
    })
  }

  tg.bot.callbackQuery(/^descno:(.+)$/, async (ctx) => {
    const id = ctx.match[1] ?? ''
    tg.runner.dropDescProposal(id)
    await ctx.answerCallbackQuery({ text: 'discarded' })
    await ctx.editMessageReplyMarkup()
  })

  tg.bot.command('desc', async (ctx) => {
    const id = normalizeId(ctx.match)
    if (!id || !tg.store.get(id)) {
      await ctx.reply('usage: /desc WEB-123 · update the PR description checklists from the latest work')
      return
    }
    await ctx.reply(`📝 ${id}: reading the PR description, the visual check and the commits…`)
    tg.runner.proposeDescription(id, 'manual').catch((e: unknown) => tg.sendPlain(`${id}: ${e instanceof Error ? e.message : String(e)}`))
  })

  tg.bot.callbackQuery(/^vispost:(.+)$/, async (ctx) => {
    const id = ctx.match[1] ?? ''
    await ctx.answerCallbackQuery({ text: `${id}: posting to the PR` })
    await ctx.editMessageReplyMarkup()
    await tg.runner.postVisual(id).then(
      (url) => tg.sendPlain(url ? `📤 ${id}: posted ${url}` : `${id}: nothing new to post`),
      (e: unknown) => tg.sendPlain(`${id}: ${e instanceof Error ? e.message : String(e)}`),
    )
  })

  tg.bot.command('greptile', async (ctx) => {
    const id = normalizeId(ctx.match)
    if (!id || !tg.store.get(id)) {
      await ctx.reply('usage: /greptile WEB-123 · asks Greptile for a new review')
      return
    }
    await tg.runner.retagGreptile(id).then(
      () => ctx.reply(`🦎 ${id}: asked Greptile for a new review`),
      (e: unknown) => ctx.reply(`could not tag Greptile: ${e instanceof Error ? e.message : String(e)}`),
    )
  })

  tg.bot.callbackQuery(/^gfix:(.+)$/, async (ctx) => {
    const id = ctx.match[1] ?? ''
    await ctx.answerCallbackQuery({ text: `${id}: lane is on Greptile's findings` })
    await ctx.editMessageReplyMarkup()
    tg.runner.fixGreptile(id).catch(async (error: unknown) => {
      await tg.send(`${STATUS_ICON.failed} *${esc(id)}* ${esc(error instanceof Error ? error.message : String(error))}`)
    })
  })

  tg.bot.callbackQuery(/^gignore:(.+)$/, async (ctx) => {
    const id = ctx.match[1] ?? ''
    tg.store.journal(id, { kind: 'note', title: "Ignored Greptile's findings" })
    await ctx.answerCallbackQuery({ text: 'ignored' })
    await ctx.editMessageReplyMarkup()
  })

}
