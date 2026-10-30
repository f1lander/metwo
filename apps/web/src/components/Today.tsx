import type { AskReply, AssistAction, PrReview, Ticket, TodayItem } from '@ticketflow/shared'
import { AnimatePresence, motion } from 'motion/react'
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { askMetwo, loadToday, runAssist, triageNow } from '../lib/api.js'
import { failed, notice } from '../lib/notice.js'
import { href } from '../lib/route.js'
import { useTriageMap } from '../lib/triage.js'
import { openCycle } from './Cycle.js'
import { Markdown } from './Markdown.js'
import { Button, TriageChip } from './ui.js'

const GROUPS: readonly [TodayItem['group'], string, string][] = [
  ['now', 'Needs you', 'Nothing waiting on you.'],
  ['reviews', 'Reviews asked of you', 'No PRs waiting for your review.'],
  ['pick', 'From the cycle', 'Nothing unassigned in the cycle.'],
]
const TONE_DOT = { bad: 'bg-bad', warn: 'bg-warn', accent: 'bg-accent-fg', ok: 'bg-ok-dot', neutral: 'bg-dim' } as const
const SUGGESTIONS = ['What should I do first today?', 'Which cycle tickets are UI only?', 'Take the easy ones', 'Review the PRs I was asked for']

const describe = (a: AssistAction) =>
  a.type === 'take' ? `Take ${a.ids.join(', ')}` : a.type === 'start' ? `Start ${a.id} (${a.lane})` : a.type === 'review' ? `Review ${a.id}` : a.type === 'visual' ? `Visual check on ${a.id}` : a.type === 'preview_qa' ? `QA on preview for ${a.id}` : a.type === 'update_main' ? `Update ${a.id} from main` : a.type === 'address_comments' ? `Address ${a.id}'s comments` : a.type === 'resume' ? `Resume ${a.id}` : 'Triage the cycle'

const linkFor = (i: TodayItem) => (i.href === 'ticket' ? href.ticket(i.id) : i.href === 'review' ? href.review(i.id) : undefined)

interface Turn {
  readonly q: string
  readonly reply?: AskReply
  readonly error?: string
}

// Today's brief from rules (no AI): what needs you, PRs to review, what to pick from the cycle,
// each with its button. Asking in plain words is below and is the only part that uses AI.
export function TodayPage({ tickets, reviews }: { tickets: readonly Ticket[]; reviews: readonly PrReview[] }) {
  const [items, setItems] = useState<TodayItem[] | null>(null)
  const [turns, setTurns] = useState<Turn[]>([])
  const [q, setQ] = useState('')
  const [asking, setAsking] = useState(false)
  const triage = useTriageMap()
  const stamp = useMemo(() => tickets.map((t) => `${t.id}:${t.status}:${t.pr?.syncedAt ?? ''}`).join('|') + reviews.map((r) => r.status).join(), [tickets, reviews])
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)

  useEffect(() => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void loadToday().then(setItems, () => setItems([])), 400)
    return () => clearTimeout(timer.current)
  }, [stamp, triage])

  const ask = async (e?: FormEvent, text = q) => {
    e?.preventDefault()
    const question = text.trim()
    if (!question || asking) return
    setQ('')
    setAsking(true)
    const history = turns.flatMap((t) => [{ role: 'you' as const, text: t.q }, ...(t.reply ? [{ role: 'metwo' as const, text: t.reply.answer }] : [])])
    setTurns((list) => [...list, { q: question }].slice(-5))
    try {
      const reply = await askMetwo(question, history)
      setTurns((list) => list.map((t, i) => (i === list.length - 1 ? { ...t, reply } : t)))
    } catch (err) {
      setTurns((list) => list.map((t, i) => (i === list.length - 1 ? { ...t, error: err instanceof Error ? err.message : String(err) } : t)))
    } finally {
      setAsking(false)
    }
  }

  const run = async (actions: AssistAction[]) => {
    try {
      const { results } = await runAssist(actions)
      for (const r of results) notice({ title: r.ok ? 'Done' : 'Did not work', detail: r.text, tone: r.ok ? 'ok' : 'bad' })
      setItems(await loadToday())
    } catch (err) {
      failed(err)
    }
  }

  const groups = GROUPS.map(([group, title, empty]) => ({ group, title, empty, list: (items ?? []).filter((i) => i.group === group) }))
  const count = (g: TodayItem['group']) => groups.find((x) => x.group === g)?.list.length ?? 0
  const easy = (items ?? []).filter((i) => i.group === 'pick' && i.triage?.easy).map((i) => i.id)
  const running = tickets.filter((t) => t.status === 'running' || t.status === 'queued').length
  const brief = items
    ? [
        count('now') ? `${count('now')} thing${count('now') === 1 ? '' : 's'} need${count('now') === 1 ? 's' : ''} you` : 'nothing is waiting on you',
        count('reviews') ? `${count('reviews')} PR${count('reviews') === 1 ? '' : 's'} to review` : '',
        easy.length ? `${easy.length} easy ticket${easy.length === 1 ? '' : 's'} in the cycle` : '',
        running ? `${running} lane${running === 1 ? '' : 's'} working` : '',
      ].filter(Boolean)
    : []
  const [open, setOpen] = useState<Record<string, boolean>>({})

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[920px] flex-col gap-4 px-6 py-6 max-md:px-4 max-md:pb-24">
        <header>
          <h1 className="text-lg font-semibold">Today</h1>
          <p className="text-sm text-fg-2">{items ? `${brief.join(', ')}.`.replace(/^./, (c) => c.toUpperCase()) : 'Loading…'}</p>
          <p className="mt-0.5 text-[11px] text-dim">From your tickets, PRs, reviews and the cycle, as they are right now. No AI runs here until you ask below.</p>
        </header>

        {groups.map(({ group, title, empty, list }) => {
          const shown = open[group] ? list : list.slice(0, 3)
          return (
            <section key={group} className="flex flex-col gap-1 rounded-xl border border-line bg-panel px-3 py-3">
              <div className="flex items-center gap-2 px-1 text-xs font-medium text-muted">
                {title}
                <span className="text-dim">{items ? list.length : ''}</span>
                {group === 'pick' && (
                  <span className="ml-auto flex items-center gap-3 font-normal">
                    {easy.length > 1 && (
                      <button type="button" className="text-ok hover:brightness-125" onClick={() => void run([{ type: 'take', ids: easy }])}>
                        Take the {easy.length} easy ones
                      </button>
                    )}
                    <button type="button" className="hover:text-fg" title="sizes the cycle with AI (costs a little)" onClick={() => void triageNow().then(() => notice({ title: 'Triaging the cycle', detail: 'sizes appear as they come in', tone: 'accent' }))}>
                      Triage
                    </button>
                    <button type="button" className="hover:text-fg" onClick={openCycle}>
                      Whole cycle
                    </button>
                  </span>
                )}
              </div>
              {items && list.length === 0 && <div className="px-1 py-1.5 text-xs text-dim">{empty}</div>}
              {shown.map((i) => (
                <Item key={i.key} item={i} onRun={run} />
              ))}
              {list.length > 3 && (
                <button type="button" className="self-start px-1 pt-1 text-xs text-muted hover:text-fg" onClick={() => setOpen({ ...open, [group]: !open[group] })}>
                  {open[group] ? 'Show less' : `Show ${list.length - 3} more`}
                </button>
              )}
            </section>
          )
        })}

        <section className="flex flex-col gap-2 pt-2">
          <div className="px-1 text-xs font-medium text-muted">Ask metwo</div>
          <form onSubmit={(e) => void ask(e)} className="flex items-center gap-2 rounded-xl border border-line-2 bg-panel px-3 py-2 focus-within:border-accent/60">
            <span className="text-accent-fg" aria-hidden="true">
              ✦
            </span>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Anything about your tickets, PRs or the cycle. Uses AI only when you send."
              aria-label="ask metwo"
              className="min-w-0 flex-1 bg-transparent py-1 text-sm text-fg outline-none placeholder:text-dim"
            />
            <Button variant="primary" type="submit" disabled={asking || !q.trim()}>
              {asking ? 'Thinking…' : 'Ask'}
            </Button>
          </form>
          {turns.length === 0 && (
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => setQ(s)} className="rounded-full border border-line px-2.5 py-0.5 text-xs text-muted hover:border-line-2 hover:text-fg">
                  {s}
                </button>
              ))}
            </div>
          )}
          <AnimatePresence initial={false}>
            {turns.map((t, i) => (
              <motion.div key={`${i}-${t.q}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-2 rounded-xl border border-line bg-panel px-4 py-3">
                <div className="text-xs text-muted">{t.q}</div>
                {!t.reply && !t.error && <div className="text-xs text-dim">Reading your tickets, PRs and the cycle…</div>}
                {t.error && <div className="text-xs text-bad">{t.error}</div>}
                {t.reply && <Answer reply={t.reply} tickets={tickets} reviews={reviews} known={items ?? []} onRun={run} />}
              </motion.div>
            ))}
          </AnimatePresence>
        </section>
      </div>
    </div>
  )
}

// A one-line pointer on Home: what Today holds, without the list.
export function TodayLink({ tickets }: { tickets: readonly Ticket[] }) {
  const [items, setItems] = useState<TodayItem[] | null>(null)
  const stamp = tickets.map((t) => `${t.id}:${t.status}`).join('|')
  useEffect(() => {
    void loadToday().then(setItems, () => setItems([]))
  }, [stamp])
  if (!items) return null
  const n = (g: TodayItem['group']) => items.filter((i) => i.group === g).length
  const easy = items.filter((i) => i.group === 'pick' && i.triage?.easy).length
  return (
    <a href={href.today} className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-xl border border-line bg-panel px-4 py-3 text-sm hover:border-accent/50">
      <span className="font-medium">Today</span>
      <span className={n('now') ? 'text-warn' : 'text-muted'}>{n('now')} need you</span>
      <span className="text-muted">{n('reviews')} to review</span>
      <span className={easy ? 'text-ok' : 'text-muted'}>{easy} easy in the cycle</span>
      <span className="ml-auto text-xs text-accent-fg">Open →</span>
    </a>
  )
}

function Item({ item: i, onRun }: { item: TodayItem; onRun: (a: AssistAction[]) => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const link = linkFor(i)
  return (
    <div className="group flex items-start gap-2 rounded-lg px-1 py-1.5 hover:bg-raised/60">
      <span className={`mt-1.5 size-1.5 shrink-0 rounded-full ${TONE_DOT[i.tone]}`} aria-hidden="true" />
      <a href={link} onClick={link ? undefined : openCycle} className="min-w-0 flex-1 cursor-pointer">
        <div className="flex items-center gap-1.5 text-xs">
          <span className="shrink-0 text-muted">{i.id}</span>
          <span className="truncate text-fg">{i.title}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] leading-snug text-dim">
          <TriageChip triage={i.triage} />
          <span className="line-clamp-2">{i.triage ? i.triage.why : i.why}</span>
        </div>
      </a>
      {i.action && (
        <Button
          className="shrink-0 !px-2 !py-0.5 text-[11px]"
          disabled={busy}
          onClick={async () => {
            const act = i.action?.do
            if (!act) return
            if (act.type === 'address_comments') {
              window.location.hash = href.ticket(i.id)
              return
            }
            setBusy(true)
            await onRun([act])
            setBusy(false)
          }}
        >
          {i.action.label}
        </Button>
      )}
    </div>
  )
}

function Answer({ reply, tickets, reviews, known, onRun }: { reply: AskReply; tickets: readonly Ticket[]; reviews: readonly PrReview[]; known: readonly TodayItem[]; onRun: (a: AssistAction[]) => Promise<void> }) {
  const [keep, setKeep] = useState<Set<number>>(() => new Set(reply.plan.map((_, i) => i)))
  const [done, setDone] = useState(false)
  const triage = useTriageMap()
  const card = (id: string) => {
    const t = tickets.find((x) => x.id === id)
    const r = reviews.find((x) => x.id === id)
    const title = t?.title ?? r?.title ?? known.find((k) => k.id === id)?.title ?? ''
    const sub = t ? t.status.replace('_', ' ') : r ? `PR review · ${r.status}` : 'cycle'
    const to = t ? href.ticket(id) : r ? href.review(id) : undefined
    return (
      <a key={id} href={to} onClick={to ? undefined : openCycle} className="flex min-w-0 cursor-pointer flex-col gap-0.5 rounded-lg border border-line bg-bg px-2.5 py-2 text-xs hover:border-line-2">
        <span className="flex items-center gap-1.5 text-muted">
          {id} · {sub} <TriageChip triage={triage[id]} />
        </span>
        {title && <span className="truncate text-fg">{title}</span>}
      </a>
    )
  }
  return (
    <>
      <Markdown source={reply.answer} className="text-[13px]" />
      {reply.ids.length > 0 && <div className="grid grid-cols-2 gap-1.5 max-md:grid-cols-1">{reply.ids.map(card)}</div>}
      {reply.plan.length > 0 && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-accent/30 bg-bg px-3 py-2">
          <div className="text-[11px] text-muted">Plan · nothing runs until you press Run</div>
          {reply.plan.map((p, i) => (
            <label key={i} className={`flex items-start gap-2 text-xs ${keep.has(i) ? '' : 'opacity-50'}`}>
              <input
                type="checkbox"
                className="mt-0.5 accent-[var(--color-accent)]"
                checked={keep.has(i)}
                disabled={done}
                onChange={() =>
                  setKeep((s) => {
                    const n = new Set(s)
                    if (n.has(i)) n.delete(i)
                    else n.add(i)
                    return n
                  })
                }
              />
              <span>
                <span className="text-fg">{describe(p.action)}</span>
                {p.why && <span className="text-dim"> · {p.why}</span>}
              </span>
            </label>
          ))}
          <Button
            variant="primary"
            className="self-start"
            disabled={done || keep.size === 0}
            onClick={async () => {
              setDone(true)
              await onRun(reply.plan.filter((_, i) => keep.has(i)).map((p) => p.action))
            }}
          >
            {done ? 'Sent' : `Run ${keep.size}`}
          </Button>
        </div>
      )}
    </>
  )
}
