import { type JournalEntry, questionOptions, type Ticket } from '@ticketflow/shared'
import { motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { Markdown } from './Markdown.js'
import { actions } from '../lib/api.js'
import { failed } from '../lib/notice.js'
import { Button, Mono } from './ui.js'

type Who = 'you' | 'lane' | 'system' | 'mevo'
interface Message {
  readonly at: string
  readonly who: Who
  readonly title: string
  readonly body?: string | undefined
  readonly meta?: string | undefined
  readonly question?: boolean
  // an answer that found something for the lane: what to hand it, and the question it answered
  readonly toLane?: { readonly what: string; readonly asked: string; readonly answer: string }
}

const time = (iso: string) => new Date(iso).toLocaleString([], { hour12: false, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

function toMessage(j: JournalEntry, i: number, all: readonly JournalEntry[]): Message | null {
  if (j.kind === 'ask') {
    const meta = [j.meta?.model ? String(j.meta.model).replace(/^claude:/, '') : '', j.meta?.cost ? `$${j.meta.cost}` : ''].filter(Boolean).join(' · ') || undefined
    if (j.title === 'You asked') return { at: j.at, who: 'you', title: 'You asked', body: j.body }
    const asked = [...all.slice(0, i)].reverse().find((x) => x.kind === 'ask' && x.title === 'You asked')?.body ?? ''
    return { at: j.at, who: 'mevo', title: 'mevo · no lane', body: j.body, meta, ...(j.meta?.toLane ? { toLane: { what: String(j.meta.toLane), asked, answer: j.body ?? '' } } : {}) }
  }
  const meta = [j.meta?.minutes ? `${j.meta.minutes} min` : '', j.meta?.cost ? `$${j.meta.cost}` : ''].filter(Boolean).join(' · ') || undefined
  if (j.kind === 'note' && j.title.startsWith('You asked the lane')) return { at: j.at, who: 'you', title: j.title.replace('You asked the lane', 'You'), body: j.body }
  if (j.kind === 'note' && j.title.startsWith('Queued for when')) return { at: j.at, who: 'you', title: 'You · queued for after the run', body: j.body }
  if (j.kind === 'answer') return j.body ? { at: j.at, who: 'you', title: j.title === 'You answered the lane' ? 'You answered' : j.title, body: j.body } : { at: j.at, who: 'system', title: j.title }
  if (j.kind === 'question') return { at: j.at, who: 'lane', title: 'The lane asked', body: j.body, question: true }
  if (j.kind === 'run') return { at: j.at, who: 'lane', title: j.title, body: j.body, meta }
  if (j.kind === 'ready' || j.kind === 'no_change' || j.kind === 'pr' || j.kind === 'failure') return { at: j.at, who: 'system', title: j.title }
  if (j.kind === 'review' && /^(Supervisor|Review pass)/.test(j.title)) return { at: j.at, who: 'system', title: j.title }
  if (j.kind === 'note' && /^(Stopped|Resumed|Finishing)/.test(j.title)) return { at: j.at, who: 'system', title: j.title }
  return null
}

// What you and the lane said to each other on this ticket: your instructions and answers,
// its questions and what each turn reported, with the hand-offs in between.
export function Chat({ ticket: t }: { ticket: Ticket }) {
  const messages = (t.journal ?? []).map((j, i, all) => toMessage(j, i, all)).filter((m): m is Message => m !== null)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // scroll the chat's own panel to the newest message, never the whole page
    const box = end.current?.closest('.overflow-y-auto')
    if (box && getComputedStyle(box).overflowY === 'auto') box.scrollTop = box.scrollHeight
  }, [messages.length])
  if (messages.length === 0) {
    return <div className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs text-dim">No conversation yet. Ask about this ticket (answered from its history, no lane), or tell the lane what to change.</div>
  }
  return (
    <div className="flex flex-col gap-3 pb-2">
      {messages.map((m, i) => (
        <Bubble key={`${m.at}-${i}`} m={m} ticket={t} open={m.question === true && t.status === 'needs_input' && i === messages.map((x) => x.question).lastIndexOf(true)} />
      ))}
      {t.asking && !t.asking.error && (
        <div className="flex items-center gap-2 text-[11px] text-accent-fg">
          <span className="animate-pulse">mevo is reading the ticket's history…</span>
        </div>
      )}
      {t.asking?.error && <div className="text-[11px] text-bad">Could not answer: {t.asking.error}</div>}
      <div ref={end} />
    </div>
  )
}

function Bubble({ m, ticket: t, open }: { m: Message; ticket: Ticket; open: boolean }) {
  const ticketId = t.id
  const [expanded, setExpanded] = useState(m.who === 'you' || m.question === true || m.who === 'mevo')
  const [sent, setSent] = useState(false)
  if (m.who === 'system') {
    return (
      <div className="flex items-center gap-2 text-[11px] text-dim">
        <span className="h-px flex-1 bg-line" />
        <span>
          {m.title} · {time(m.at)}
        </span>
        <span className="h-px flex-1 bg-line" />
      </div>
    )
  }
  const you = m.who === 'you'
  const long = (m.body?.length ?? 0) > 600
  const options = m.question ? questionOptions(m.body) : []
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className={`flex flex-col gap-1 ${you ? 'items-end' : 'items-start'}`}>
      <span className="flex items-center gap-2 text-[11px] text-dim">
        <span className={you ? 'text-fg-2' : m.question ? 'text-warn' : m.who === 'mevo' ? 'text-fg' : 'text-accent-fg'}>{m.title}</span>
        {m.meta && <Mono className="text-dim">{m.meta}</Mono>}
        <span>{time(m.at)}</span>
      </span>
      {open && <div className="rounded-xl rounded-tl-sm border border-[#3d3522] bg-[#1a1812] px-3 py-2 text-[12px] text-warn">Waiting on you: the question and its options are in the card on the left.</div>}
      {m.body && !open && (
        <div className={`max-w-[92%] rounded-xl border px-3 py-2 ${you ? 'rounded-tr-sm border-accent/40 bg-accent/10' : m.question ? 'rounded-tl-sm border-[#3d3522] bg-[#1a1812]' : m.who === 'mevo' ? 'rounded-tl-sm border-line-2 bg-raised' : 'rounded-tl-sm border-line bg-panel'}`}>
          <div className={!expanded && long ? 'max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]' : ''}>
            <Markdown source={m.body} ticketId={ticketId} className="md-sm" />
          </div>
          {long && (
            <button type="button" className="mt-1 text-[11px] text-accent-fg hover:underline" onClick={() => setExpanded((e) => !e)}>
              {expanded ? 'Show less' : 'Show all'}
            </button>
          )}
          {options.length > 0 && !open && <div className="mt-1.5 text-[11px] text-dim">{options.length} options · answered</div>}
          {m.toLane && (
            <div className="mt-2 flex flex-col gap-1.5 border-t border-line pt-2">
              <span className="text-[11.5px] text-fg-2">For the lane: {m.toLane.what}</span>
              {t.worktree && (
                <span>
                  <Button
                    disabled={sent}
                    onClick={() =>
                      void actions
                        .instruct(t, `${m.toLane?.what ?? ''}\n\nFrom a question in the chat: "${m.toLane?.asked ?? ''}"\nWhat the ticket's history showed:\n${m.toLane?.answer ?? ''}`, [])
                        .then(() => setSent(true), (err: unknown) => failed(err, t.id))
                    }
                  >
                    {sent ? 'Sent to the lane' : 'Send this to the lane'}
                  </Button>
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </motion.div>
  )
}
