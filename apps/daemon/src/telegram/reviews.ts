import { InlineKeyboard } from 'grammy'
import type { Telegram } from './index.js'

// PRs you were asked to review.
export function wireReviews(tg: Telegram): void {
  tg.bot.command('review', async (ctx) => {
    if (!tg.reviews) return
    const arg = ctx.match.trim()
    if (!arg) {
      await ctx.reply('usage: /review https://github.com/owner/repo/pull/123 (or just the number)')
      return
    }
    await tg.offerReview(arg)
  })

  tg.bot.command('reviews', async (ctx) => {
    const open = tg.store.reviews().filter((r) => ['new', 'queued', 'reviewing', 'reviewed', 'stopped', 'failed'].includes(r.status))
    if (open.length === 0) {
      await ctx.reply('no PRs waiting for your review. /review <link> adds one')
      return
    }
    const kb = new InlineKeyboard()
    open.slice(0, 6).forEach((r, i) => {
      if (r.status === 'new' || r.status === 'stopped' || r.status === 'failed') kb.text(`🔎 #${r.number}`, `rvstart:${r.id}`)
      if (i % 3 === 2) kb.row()
    })
    await ctx.reply(open.map((r) => `#${r.number} · ${r.status}${r.stale ? ' · new commits' : ''} · ${r.title.slice(0, 70)}\n   ${r.sourceNote}`).join('\n'), { reply_markup: kb, link_preview_options: { is_disabled: true } })
  })

  tg.bot.callbackQuery(/^rvstart:(.+)$/, async (ctx) => {
    const id = ctx.match[1] ?? ''
    await ctx.answerCallbackQuery({ text: `${id}: review started` })
    await ctx.editMessageReplyMarkup()
    tg.reviews?.start(id).catch((e: unknown) => tg.sendPlain(`${id}: ${e instanceof Error ? e.message : String(e)}`))
  })

  tg.bot.callbackQuery(/^rvfollow:(.+)$/, async (ctx) => {
    const id = ctx.match[1] ?? ''
    await ctx.answerCallbackQuery({ text: `${id}: checking your comments` })
    await ctx.editMessageReplyMarkup()
    try {
      const r = await tg.reviews?.checkFollowUp(id)
      const open = (r?.followUp?.threads ?? []).filter((t) => !t.resolved)
      const icon = { addressed: '✅', partly: '🟡', not_addressed: '❌', answered: '💬' } as const
      await tg.sendPlain(`#${r?.number} ${r?.followUp?.checked?.summary ?? ''}\n${open.map((t) => `${t.verdict ? icon[t.verdict] : '·'} ${t.path ?? ''}${t.line ? `:${t.line}` : ''} ${t.note ?? ''}`).join('\n')}\nOpen it in the app to resolve, reply, approve or ping on Slack.`)
    } catch (e) {
      await tg.sendPlain(`${id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  })

  tg.bot.callbackQuery(/^rvdismiss:(.+)$/, async (ctx) => {
    tg.reviews?.dismiss(ctx.match[1] ?? '')
    await ctx.answerCallbackQuery({ text: 'dismissed' })
    await ctx.editMessageReplyMarkup()
  })

  tg.bot.callbackQuery(/^rvadd:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery()
    await ctx.editMessageReplyMarkup()
    await tg.offerReview(ctx.match[1] ?? '', true)
  })

  tg.bot.callbackQuery(/^rvpost:(.+)$/, async (ctx) => {
    const id = ctx.match[1] ?? ''
    const r = tg.store.review(id)
    await ctx.answerCallbackQuery({ text: 'posting…' })
    await ctx.editMessageReplyMarkup()
    if (!r?.report || !tg.reviews) return
    const picked = r.report.findings.filter((f) => ['P0', 'P1', 'P2'].includes(f.severity)).map((f) => ({ id: f.id, body: f.body }))
    const event = r.report.verdict === 'request_changes' ? 'REQUEST_CHANGES' : 'COMMENT'
    await tg.reviews.post(id, { event, body: r.report.summary, findings: picked }).then(
      (done) => tg.sendPlain(`📤 posted your review on #${r.number}${done.posted?.url ? `: ${done.posted.url}` : ''}`),
      (e: unknown) => tg.sendPlain(`could not post on #${r.number}: ${e instanceof Error ? e.message : String(e)}`),
    )
  })

}
