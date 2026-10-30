import { InlineKeyboard } from 'grammy'
import type { PrComment, PrReview, Ticket } from '@ticketflow/shared'
import { log } from '../log.js'
import { esc, section400, STATUS_ICON, SUPERVISION_LABEL, VISUAL_LABEL } from './format.js'
import type { Telegram } from './index.js'

// Every message metwo sends on its own: reviews ready, questions, PR events, review requests.
export function makeNotifier(tg: Telegram) {
  return {
  reviewReady: async (ticket: Ticket) => {
    if (ticket.greptileFixing) {
      const fixes = section400(ticket.summary, 'Greptile')
      const kb = new InlineKeyboard().text('🚀 push (Greptile re-reviews)', `push:${ticket.id}`).text('progress', `progress:${ticket.id}`)
      await tg.send(
        `🦎 *${esc(ticket.id)}* Greptile fixes ready for your review\n` +
          `\`\`\`\n${esc(ticket.commits ?? '')}\n\`\`\`\n` +
          (fixes ? `${esc(fixes.slice(0, 1200))}\n` : '') +
          `worktree: \`${esc(ticket.worktree ?? '')}\``,
        kb,
      )
      return
    }
    const kb = new InlineKeyboard().text('🚀 push + draft PR', `push:${ticket.id}`).text('discard', `skip:${ticket.id}`)
    const manual = section400(ticket.summary, 'Needs manual test')
    const risks = section400(ticket.summary, 'Known risks')
    await tg.send(
      `${STATUS_ICON.review_ready} *${esc(ticket.id)}* ready for your review\n` +
        `\`\`\`\n${esc(ticket.commits ?? '')}\n\n${esc(ticket.diffStat ?? '')}\n\`\`\`\n` +
        (ticket.supervision ? `supervisor ${esc(ticket.supervision.engine)}: *${esc(SUPERVISION_LABEL[ticket.supervision.verdict])}*${ticket.supervision.summary ? ` · ${esc(ticket.supervision.summary.slice(0, 200))}` : ''}\n` : '') +
        (ticket.visual ? `visual: *${esc(VISUAL_LABEL[ticket.visual.verdict])}*${ticket.visual.summary ? ` · ${esc(ticket.visual.summary.slice(0, 220))}` : ''}\n` : 'visual: no verdict\n') +
        (manual ? `manual test: ${esc(manual)}\n` : '') +
        (risks ? `risks: ${esc(risks)}\n` : '') +
        (ticket.autopilot?.held ? `🤖 autopilot stopped before the PR: ${esc(ticket.autopilot.held)}\n` : '') +
        `worktree: \`${esc(ticket.worktree ?? '')}\``,
      kb,
    )
  },
  needsInput: async (ticket: Ticket) => {
    const msg = await tg.send(`${STATUS_ICON.needs_input} *${esc(ticket.id)}* needs you \\(reply to this message\\):\n${esc(ticket.question ?? '')}`)
    if (msg) tg.questionMessages.set(msg.message_id, ticket.id)
  },
  prOpened: async (ticket: Ticket) => {
    const kb = new InlineKeyboard().text('→ move to QA', `lin:qa:${ticket.id}`)
    const pushed = ticket.events.at(-1)?.message.startsWith('pushed to existing') === true
    await tg.send(`${STATUS_ICON.pr_draft} *${esc(ticket.id)}* ${pushed ? 'pushed to the PR' : 'draft PR open'}${!pushed || ticket.pr?.greptile ? ' · Greptile tagged' : ''}\n${esc(ticket.prUrl ?? '')}`, kb)
  },
  failed: async (ticket: Ticket) => {
    const f = ticket.failure
    const kb = new InlineKeyboard()
      .text('↻ retry lite', `start:lite:${ticket.id}`)
      .text('↻ retry full', `start:full:${ticket.id}`)
      .text('🔥 max', `start:max:${ticket.id}`)
      .row()
      .text('progress', `progress:${ticket.id}`)
      .text('dismiss', `done:${ticket.id}`)
    const detail = (f?.detail ?? ticket.error ?? '').replace(/\s+/g, ' ').slice(0, 400)
    await tg.send(
      `${STATUS_ICON.failed} *${esc(ticket.id)}* · ${esc(f?.title ?? 'failed')}\n` +
        `_${esc(ticket.title.slice(0, 80))}_\n\n` +
        (detail ? `${esc(detail)}\n\n` : '') +
        (f?.hint ? `→ ${esc(f.hint)}` : ''),
      kb,
    )
  },
  noChange: async (ticket: Ticket) => {
    const kb = new InlineKeyboard()
      .text('✓ done in Linear', `lin:done:${ticket.id}`)
      .text('dismiss', `done:${ticket.id}`)
      .row()
      .text('🏗 retry full', `start:full:${ticket.id}`)
      .text('🔥 max', `start:max:${ticket.id}`)
    const outcome = (ticket.summary ?? '').split('\n').find((l) => /outcome|no code change|already/i.test(l)) ?? ticket.events.at(-1)?.message ?? ''
    await tg.send(
      `${STATUS_ICON.no_change} *${esc(ticket.id)}* no change needed\n${esc(outcome.replace(/[*`]/g, '').slice(0, 500))}\n` +
        `full summary: \`${esc(`${ticket.worktree ?? ''}/ARM-SUMMARY.md`)}\``,
      kb,
    )
  },
  prComments: async (ticket: Ticket, comments: readonly PrComment[]) => {
    const kb = new InlineKeyboard().text(comments.length > 1 ? '🛠 address all' : '🛠 let the lane fix it', `fix:${ticket.id}`)
    if (ticket.pr?.url) kb.url('open PR', ticket.pr.url)
    if (comments.length > 1) {
      comments.slice(0, 6).forEach((c, i) => {
        if (`cfix:${ticket.id}:${c.id}`.length > 64) return
        kb.row().text(`🛠 only #${i + 1}`, `cfix:${ticket.id}:${c.id}`).text(`🙈 ignore #${i + 1}`, `cign:${ticket.id}:${c.id}`)
      })
    }
    const kindOf = (c: PrComment) => (c.kind === 'inline' ? 'on the code' : c.kind === 'review' ? 'review' : 'comment')
    const body = comments
      .slice(0, 6)
      .map((c, i) => `${comments.length > 1 ? `*${i + 1}\\.*` : '•'} *${esc(c.author)}* · ${kindOf(c)}${c.path ? ` \\(${esc(c.path.split('/').slice(-2).join('/'))}${c.line ? `:${c.line}` : ''}\\)` : ''}\n  ${esc(c.body.replace(/\s+/g, ' ').trim().slice(0, 280))}`)
      .join('\n')
    const more = comments.length > 6 ? `\n…and ${comments.length - 6} more` : ''
    await tg.send(
      `💬 *${esc(ticket.id)}* ${comments.length === 1 ? 'a teammate commented' : `${comments.length} new comments from teammates`} on PR \\#${ticket.pr?.number ?? ''}\n${body}${esc(more)}\n\n_reply to this message to tell the lane something specific_`,
      kb,
    )
  },
  visualDone: async (ticket: Ticket) => {
    const v = ticket.visual
    const mark = { pass: '✅', fail: '❌', not_checked: '➖' } as const
    const kb = new InlineKeyboard()
    const open = ticket.prUrl && v ? await tg.runner.openChecks(ticket.id).catch(() => 0) : 0
    if (ticket.prUrl && v) kb.text(`📝 update PR description${open ? ` (${open} open)` : ''}`, `visdesc:${ticket.id}`).row().text('💬 post as comment', `vispost:${ticket.id}`)
    kb.text('▶ run again', `visrun:${ticket.id}`)
    const lines = v ? v.checks.slice(0, 10).map((c) => `${mark[c.result]} ${c.what}`).join('\n') : 'no VISUAL.json written'
    await tg.bot.api.sendMessage(tg.chatId, `👁 ${ticket.id} visual check: ${v ? VISUAL_LABEL[v.verdict] : 'no verdict'}\n${v?.summary ?? ''}\n\n${lines}`, { reply_markup: kb, link_preview_options: { is_disabled: true } }).catch((e: unknown) => log.warn('telegram send failed', e))
  },
  descReady: async (ticket: Ticket) => {
    const p = ticket.descProposal
    if (!p) return
    const kb = new InlineKeyboard()
    if (p.changes.length) kb.text(`✅ apply ${p.changes.length} + comment`, `descok:${ticket.id}`).text('apply, no comment', `descnc:${ticket.id}`).row()
    kb.text('💬 comment instead', `vispost:${ticket.id}`).text('discard', `descno:${ticket.id}`)
    const lines = p.changes.slice(0, 12).map((c) => `− ${c.from.trim().slice(0, 120)}\n+ ${c.to.trim().slice(0, 120)}`).join('\n\n')
    await tg.bot.api
      .sendMessage(tg.chatId, `📝 ${ticket.id} PR description: ${p.changes.length ? `${p.changes.length} change(s)` : 'nothing to change'}\n${p.log}\n\n${lines}`.slice(0, 4000), { reply_markup: kb, link_preview_options: { is_disabled: true } })
      .catch((e: unknown) => log.warn('telegram send failed', e))
  },
  qaRequested: async (ticket: Ticket) => {
    const preview = tg.runner.previewOf(ticket.id)
    const auto = tg.runner.config.github.qa.auto
    const kb = new InlineKeyboard()
    if (!auto) kb.text('🧪 test on preview', `qarun:${ticket.id}`)
    if (ticket.pr?.url) kb.url('open PR', ticket.pr.url)
    await tg.send(
      `🧪 *${esc(ticket.id)}* QA requested on PR \\#${ticket.pr?.number ?? ''}\n` +
        (preview ? `preview: ${esc(preview.url)}${preview.current ? '' : ' \\(not the latest commit yet\\)'}\n` : 'no preview deploy found yet\n') +
        (auto ? '_running the QA round on the preview now_' : '_test it on the preview before QA does?_'),
      kb,
    )
    if (auto && preview?.current) tg.runner.runPreviewQa(ticket.id).catch((e: unknown) => tg.sendPlain(`${ticket.id}: ${e instanceof Error ? e.message : String(e)}`))
  },
  previewQaDone: async (ticket: Ticket) => {
    const qa = ticket.previewQa
    if (!qa) return
    const mark = { pass: '✅', fail: '❌', not_checked: '➖' } as const
    const kb = new InlineKeyboard().text('💬 post to PR', `qapost:${ticket.id}`).text('📝 + update description', `qadesc:${ticket.id}`).row().text('▶ run again', `qarun:${ticket.id}`)
    const lines = (qa.checks ?? []).slice(0, 12).map((c) => `${mark[c.result]} ${c.what}`).join('\n')
    await tg.bot.api
      .sendMessage(tg.chatId, `🧪 ${ticket.id} QA on preview: ${qa.verdict}\n${qa.url}\n${qa.summary ?? ''}\n\n${lines}`.slice(0, 4000), { reply_markup: kb, link_preview_options: { is_disabled: true } })
      .catch((e: unknown) => log.warn('telegram send failed', e))
  },
  outsidePush: async (ticket: Ticket) => {
    const kb = new InlineKeyboard().text('🦎 ask Greptile again', `retag:${ticket.id}`)
    if (ticket.visual) kb.text('👁 re-run visual check', `visrun:${ticket.id}`)
    await tg.send(`⬆️ *${esc(ticket.id)}* new commits on PR \\#${ticket.pr?.number ?? ''} pushed outside metwo\n${esc(ticket.pr?.url ?? '')}`, kb)
  },
  prCi: async (ticket: Ticket) => {
    const kb = new InlineKeyboard().text('🛠 let the lane look', `fix:${ticket.id}`)
    await tg.send(`🔴 *${esc(ticket.id)}* CI failing on PR \\#${ticket.pr?.number ?? '?'}\n${esc(ticket.pr?.url ?? '')}`, kb)
  },
  greptile: async (ticket: Ticket) => {
    const g = ticket.pr?.greptile
    if (!g) return
    const head = `🦎 *${esc(ticket.id)}* Greptile ${g.score ?? '?'}/5${g.impact ? ` · ${esc(g.impact)}` : ''}`
    if (g.findings.length === 0) {
      const kb = new InlineKeyboard()
      if (ticket.pr?.isDraft) kb.text('✅ ready for review', `ready:${ticket.id}`)
      kb.text('→ move to QA', `lin:qa:${ticket.id}`)
      await tg.send(`${head}\nnothing to fix\n${esc(g.url)}`, kb)
      return
    }
    const list = g.findings
      .slice(0, 8)
      .map((f) => `• ${f.level ? `*${esc(f.level)}* ` : ''}${esc(f.title)}${f.path ? ` \\(${esc(f.path.split('/').slice(-2).join('/'))}${f.line ? `:${f.line}` : ''}\\)` : ''}`)
      .join('\n')
    const kb = new InlineKeyboard().text('🛠 fix them', `gfix:${ticket.id}`).text('ignore', `gignore:${ticket.id}`)
    await tg.send(`${head} · ${g.findings.length} to look at\n${list}\n${esc(g.url)}`, kb)
  },
  greptileDeclined: async (ticket: Ticket) => {
    const why = section400(ticket.summary, 'Greptile')
    const kb = new InlineKeyboard().text('→ move to QA', `lin:qa:${ticket.id}`)
    await tg.send(`🦎 *${esc(ticket.id)}* the lane checked Greptile's findings and changed nothing\n${esc((why || 'see ARM-SUMMARY.md').slice(0, 1200))}`, kb)
  },
  quiet: async (ticket: Ticket, minutes: number, last: string) => {
    const kb = new InlineKeyboard().text('⏹ stop…', `stopask:${ticket.id}`).text('progress', `progress:${ticket.id}`)
    await tg.bot.api
      .sendMessage(tg.chatId, `⏳ ${ticket.id} has been quiet for ${minutes} min.\nlast: ${last.slice(0, 200) || '(nothing yet)'}\n\nIt may be in a long command (tests, a build), or stuck. Leave it, or stop it and resume later.`, { reply_markup: kb })
      .catch((e: unknown) => log.warn('telegram send failed', e))
  },
  reviewRequested: async (r: PrReview) => {
    const kb = new InlineKeyboard().text('🔎 review it', `rvstart:${r.id}`).text('dismiss', `rvdismiss:${r.id}`).row().url('open PR', r.url)
    await tg.send(`👀 *PR \\#${r.number}* ${esc(r.title)}\n${esc(r.sourceNote)}`, kb)
  },
  reviewDone: async (r: PrReview) => {
    const rep = r.report
    if (!rep) return
    const sev = (s: string) => rep.findings.filter((f) => f.severity === s).length
    const counts = ['P0', 'P1', 'P2', 'P3'].map((s) => (sev(s) ? `${sev(s)} ${s}` : '')).filter(Boolean).join(' · ')
    const gates = rep.gates.filter((g) => !g.ok).map((g) => g.name)
    const list = rep.findings
      .slice(0, 6)
      .map((f) => `• *${esc(f.severity)}* ${esc(f.title)}${f.file ? ` \\(${esc(f.file.split('/').slice(-2).join('/'))}${f.line ? `:${f.line}` : ''}\\)` : ''}`)
      .join('\n')
    const kb = new InlineKeyboard()
    if (rep.findings.length) kb.text('📤 post P0–P2 as comments', `rvpost:${r.id}`)
    if (tg.dashboardLink?.()) kb.url('open in metwo', `${tg.dashboardLink?.() ?? ''}#/r/${r.id}`)
    kb.row().url('open PR', r.url)
    await tg.send(
      `🔎 *PR \\#${r.number}* reviewed: *${esc(rep.verdict.replace('_', ' '))}*${counts ? ` · ${esc(counts)}` : ' · nothing to flag'}\n${esc(r.title)}\n\n${esc(rep.summary.slice(0, 500))}${gates.length ? `\n🔴 ${esc(gates.join(', '))} failed` : ''}${list ? `\n\n${list}` : ''}\n\n_nothing is posted until you choose; edit findings in the app_`,
      kb,
    )
  },
  reviewFailed: async (r: PrReview) => {
    const kb = new InlineKeyboard().text('↻ try again', `rvstart:${r.id}`)
    await tg.send(`${STATUS_ICON.failed} *PR \\#${r.number}* review failed\n${esc((r.error ?? '').slice(0, 400))}`, kb)
  },
  reviewMoved: async (r: PrReview) => {
    const kb = new InlineKeyboard().text('🔎 review again', `rvstart:${r.id}`)
    await tg.send(`⬆️ *PR \\#${r.number}* has new commits since your review\n${esc(r.title)}`, kb)
  },
  prMerged: async (ticket: Ticket) => {
    await tg.send(`${STATUS_ICON.done} *${esc(ticket.id)}* merged\\. Worktree can be torn down: \`${esc(ticket.worktree ?? '')}\``)
  },
  }
}
