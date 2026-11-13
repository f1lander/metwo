import { InlineKeyboard } from 'grammy'
import { normalizeId, ticketIn } from './format.js'
import type { Telegram } from './index.js'

// Plain messages and screenshots: answers to questions, instructions for a lane, PR links to review.
export function wireMessages(tg: Telegram): void {
  tg.bot.command('tell', async (ctx) => {
    const m = /^\s*([a-z]+-?\d+)\s+([\s\S]+)$/i.exec(ctx.match)
    if (!m) {
      await ctx.reply('usage: /tell WEB-654 fix the title that overlaps the back button (or just write it, with a screenshot)')
      return
    }
    await tg.proposeInstruction(normalizeId(m[1] ?? ''), m[2] ?? '', tg.takePhotos())
  })

  tg.bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text
    if (text.startsWith('/')) return next()
    const replied = ctx.message.reply_to_message
    const question = replied ? tg.questionMessages.get(replied.message_id) : undefined
    if (question) {
      tg.questionMessages.delete(replied?.message_id as number)
      await ctx.reply(`→ ${question} resuming with your answer`)
      void tg.runner.answer(question, text)
      return
    }
    // a PR link with no ticket in sight: someone asked you to review it (pasted from Slack)
    const pr = /github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/.exec(text)
    if (pr && !ticketIn(text) && tg.reviews) {
      const kb = new InlineKeyboard().text(`🔎 review #${pr[1]}`, `rvadd:${pr[1]}`).text('no', 'stopno')
      await ctx.reply(`Review PR #${pr[1]}? mevo checks it out, runs it and drafts findings; nothing is posted until you say so.`, { reply_markup: kb })
      return
    }
    // a Linear issue link that is not on the board yet: take it, or only track it
    const lin = /linear\.app\/[^/\s]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)/i.exec(text)?.[1]?.toUpperCase()
    if (lin && tg.importIssue && !tg.store.get(lin)) {
      const kb = new InlineKeyboard().text('🙋 take it', `limp:${lin}`).text('👀 only track', `ladd:${lin}`).text('no', 'stopno')
      await ctx.reply(`${lin} isn't on the board. Take it (assigns it to you in Linear) or only track it?`, { reply_markup: kb })
      return
    }
    // plain words about a ticket: "fix the title over the back button in WEB-654",
    // or a reply to any message of that ticket
    const id = ticketIn(text) ?? ticketIn(replied?.text ?? replied?.caption ?? '')
    await tg.proposeInstruction(id, text, tg.takePhotos())
  })

  tg.bot.callbackQuery(/^(limp|ladd):(.+)$/, async (ctx) => {
    const id = ctx.match[2] ?? ''
    await ctx.editMessageReplyMarkup()
    if (!tg.importIssue) return ctx.answerCallbackQuery()
    try {
      const t = await tg.importIssue(id, ctx.match[1] === 'limp')
      await ctx.answerCallbackQuery({ text: `${t.id} is on the board` })
    } catch (error) {
      await ctx.answerCallbackQuery({ text: error instanceof Error ? error.message.slice(0, 180) : String(error) })
    }
  })

  // a screenshot: its caption is the instruction; with no caption it waits for the next message
  tg.bot.on('message:photo', async (ctx) => {
    const sizes = ctx.message.photo
    const best = sizes.at(-1)
    if (!best) return
    const bytes = await tg.download(best.file_id)
    if (!bytes) {
      await ctx.reply('could not download that image, try again')
      return
    }
    tg.photos.push({ name: `telegram-${best.file_unique_id}.jpg`, bytes, at: Date.now() })
    const caption = ctx.message.caption?.trim()
    const replied = ctx.message.reply_to_message
    if (ctx.message.media_group_id && !caption) return // the rest of an album; the captioned one carries it
    if (!caption) {
      await ctx.reply('got the screenshot. Now tell me what to fix and on which ticket, e.g. “WEB-654 the title overlaps the back button”')
      return
    }
    // albums arrive as separate messages; give the others a moment to land
    if (ctx.message.media_group_id) await new Promise((r) => setTimeout(r, 1500))
    const id = ticketIn(caption) ?? ticketIn(replied?.text ?? replied?.caption ?? '')
    await tg.proposeInstruction(id, caption, tg.takePhotos())
  })

  tg.bot.callbackQuery(/^tell:(\w+)$/, async (ctx) => {
    const key = ctx.match[1] ?? ''
    const p = tg.pending.get(key)
    tg.pending.delete(key)
    await ctx.editMessageReplyMarkup()
    if (!p?.id) {
      await ctx.answerCallbackQuery({ text: 'that instruction expired, send it again' })
      return
    }
    const busy = ['running', 'queued'].includes(tg.store.get(p.id)?.status ?? '')
    await ctx.answerCallbackQuery({ text: busy ? `${p.id}: queued for when this run ends` : `${p.id}: lane is on it` })
    tg.runner.instruct(p.id, p.text, p.images).catch(async (error: unknown) => {
      await tg.sendPlain(`could not send it to ${p.id}: ${error instanceof Error ? error.message : String(error)}`)
    })
    await tg.sendPlain(
      busy
        ? `⏳ ${p.id}: a lane is running, so this waits and goes to it as soon as the run comes back.`
        : `🛠 ${p.id}: sent to the lane${p.images.length ? ` with ${p.images.length} screenshot(s)` : ''}. You’ll get the usual review message when it’s done.`,
    )
  })

  tg.bot.callbackQuery(/^tellfor:(\w+):(.+)$/, async (ctx) => {
    const p = tg.pending.get(ctx.match[1] ?? '')
    if (p) p.id = ctx.match[2] ?? null
    await ctx.answerCallbackQuery()
    await ctx.editMessageReplyMarkup()
    if (p) await tg.confirmInstruction(ctx.match[1] ?? '', p)
  })

  tg.bot.callbackQuery(/^tellno:(\w+)$/, async (ctx) => {
    tg.pending.delete(ctx.match[1] ?? '')
    await ctx.answerCallbackQuery({ text: 'dropped' })
    await ctx.editMessageReplyMarkup()
  })

}
