import type { AssistAction, TodayItem } from '@ticketflow/shared'
import { InlineKeyboard } from 'grammy'
import type { Assistant } from '../assistant.js'
import type { Telegram } from './index.js'

const ICON = { bad: '🔴', warn: '🟡', accent: '🟣', ok: '🟢', neutral: '⚪️' } as const

// /today, /ask and the buttons under them: the same actions as the app, nothing more.
export function registerAssistant(tg: Telegram, assistant: Assistant): void {
  const plans = new Map<string, readonly AssistAction[]>()
  const keep = (actions: readonly AssistAction[]) => {
    const key = Math.random().toString(36).slice(2, 10)
    plans.set(key, actions)
    if (plans.size > 50) plans.delete(plans.keys().next().value as string)
    return key
  }
  const runKb = (actions: readonly AssistAction[], label: string) => new InlineKeyboard().text(label, `asrun:${keep(actions)}`)

  tg.bot.command('today', async (ctx) => {
    const items = await assistant.today()
    const line = (i: TodayItem) => `${ICON[i.tone]} ${i.id} · ${i.title.slice(0, 60)}\n    ${i.why.slice(0, 160)}`
    const block = (title: string, list: TodayItem[]) => (list.length ? `${title}\n${list.slice(0, 8).map(line).join('\n')}` : '')
    const now = items.filter((i) => i.group === 'now')
    const rev = items.filter((i) => i.group === 'reviews')
    const pick = items.filter((i) => i.group === 'pick')
    const easy = pick.filter((i) => i.triage?.easy).map((i) => i.id)
    const text = [block('needs you', now), block('reviews asked of you', rev), block('from the cycle', pick)].filter(Boolean).join('\n\n') || 'nothing on your plate. /cycle shows what is open.'
    const kb = easy.length ? runKb([{ type: 'take', ids: easy }], `🧹 take the ${easy.length} easy one${easy.length === 1 ? '' : 's'}`) : undefined
    await ctx.reply(`☀️ today\n\n${text}`.slice(0, 4000), { link_preview_options: { is_disabled: true }, ...(kb ? { reply_markup: kb } : {}) })
  })

  const answer = async (q: string) => {
    await tg.sendPlain('🤔 …')
    try {
      const r = await assistant.ask(q)
      const plan = r.plan.length ? `\n\nplan:\n${r.plan.map((p, i) => `${i + 1}. ${p.action.type}${'id' in p.action ? ` ${p.action.id}` : 'ids' in p.action ? ` ${p.action.ids.join(', ')}` : ''} · ${p.why}`).join('\n')}` : ''
      const kb = r.plan.length ? runKb(r.plan.map((p) => p.action), '▶ do it') : undefined
      await tg.bot.api.sendMessage(tg.chatId, `${r.answer}${r.ids.length ? `\n\n${r.ids.join(' · ')}` : ''}${plan}`.slice(0, 4000), { link_preview_options: { is_disabled: true }, ...(kb ? { reply_markup: kb } : {}) })
    } catch (error) {
      await tg.sendPlain(`could not answer: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  tg.askAssistant = answer

  tg.bot.command('ask', async (ctx) => {
    const q = ctx.match.trim()
    if (!q) {
      await ctx.reply('usage: /ask which cycle tickets are only UI? · /ask take the easy ones and review the PRs I was asked for. Or just write the question.')
      return
    }
    await answer(q)
  })

  tg.bot.callbackQuery(/^askq:(.+)$/, async (ctx) => {
    const p = tg.pending.get(ctx.match[1] ?? '')
    await ctx.answerCallbackQuery()
    await ctx.editMessageReplyMarkup()
    if (p) {
      tg.pending.delete(ctx.match[1] ?? '')
      await answer(p.text)
    }
  })

  tg.bot.callbackQuery(/^asrun:(.+)$/, async (ctx) => {
    const actions = plans.get(ctx.match[1] ?? '')
    await ctx.answerCallbackQuery({ text: actions ? 'on it' : 'that plan expired; ask again' })
    if (!actions) return
    await ctx.editMessageReplyMarkup()
    const results = await assistant.run(actions)
    await tg.sendPlain(results.map((r) => `${r.ok ? '✅' : '❌'} ${r.text}`).join('\n'))
  })
}
