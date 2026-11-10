import type { AssistAction, DaemonState, Ticket } from '@ticketflow/shared'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { actions, askMetwo, runAssist } from '../lib/api.js'
import { failed, notice } from '../lib/notice.js'
import { TELL_EVENT } from '../lib/mascot.js'
import { href } from '../lib/route.js'
import { Markdown } from './Markdown.js'

export interface MoMessage {
  readonly role: 'you' | 'mo'
  readonly text: string
  // tickets, PRs and reviews the answer is about
  readonly ids?: readonly string[]
  readonly plan?: readonly { readonly action: AssistAction; readonly why: string }[]
  // asked inside this ticket
  readonly ticket?: string
}

const KEY = 'mevo.mo.chat'
const load = (): MoMessage[] => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.slice(-20) : []
  } catch {
    return []
  }
}
const save = (list: readonly MoMessage[]) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(-20)))
  } catch {
    // not remembered
  }
}

// "open WEB-2109", "llévame al PR 1695": go there instead of answering
const GO = /^(open|go to|show me|take me to|abr[ei]|ve a|ir a|ll[eé]vame a?|mu[eé]strame)\b/i

const describe = (a: AssistAction) =>
  a.type === 'take' ? `Take ${a.ids.join(', ')}` : a.type === 'start' ? `Start ${a.id} (${a.lane})` : a.type === 'review' ? `Review ${a.id}` : a.type === 'resume' ? `Resume ${a.id}` : a.type === 'address_comments' ? `Address ${a.id}'s comments` : a.type === 'preview_qa' ? `QA ${a.id} on preview` : a.type === 'visual' ? `Visual check ${a.id}` : a.type === 'update_main' ? `Update ${a.id} from main` : 'Triage the cycle'

// Mo's chat: a short conversation next to him. In a ticket it asks about that ticket; anywhere
// else it asks mevo about everything. Answers point to the ticket, PR or review they are about.
export function MoChat({ state, here, onClose, onBusy }: { state: DaemonState; here: Ticket | undefined; onClose: () => void; onBusy: (busy: boolean) => void }) {
  const [list, setList] = useState<MoMessage[]>(load)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => {
    input.current?.focus()
  }, [])
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [list, busy])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [onClose])

  const push = (m: MoMessage) =>
    setList((l) => {
      const next = [...l, m].slice(-20)
      save(next)
      return next
    })

  const target = (text: string): string | null => {
    const id = text.match(/\b([A-Z]{2,}-\d+)\b/i)?.[1]?.toUpperCase()
    if (id && (state.tickets[id] || state.reviews?.[id])) return id
    const n = Number(text.match(/(?:#|pr\s*)(\d{3,})/i)?.[1])
    if (n) {
      const t = Object.values(state.tickets).find((x) => x.pr?.number === n)
      if (t) return t.id
      const r = Object.values(state.reviews ?? {}).find((x) => x.number === n)
      if (r) return r.id
    }
    return null
  }
  const go = (id: string, chat = true) => {
    if (state.reviews?.[id]) location.hash = href.review(id)
    else {
      location.hash = href.ticket(id)
      if (chat) setTimeout(() => dispatchEvent(new CustomEvent(TELL_EVENT, { detail: { handled: false } })), 450)
    }
  }

  const send = async (e?: FormEvent) => {
    e?.preventDefault()
    const text = q.trim()
    if (!text || busy) return
    setQ('')
    push({ role: 'you', text, ...(here ? { ticket: here.id } : {}) })
    const to = GO.test(text) ? target(text) : null
    if (to) {
      push({ role: 'mo', text: `Opening ${to}…` })
      go(to)
      return
    }
    setBusy(true)
    onBusy(true)
    try {
      if (here) {
        const r = await actions.ask(here, text)
        push({ role: 'mo', text: r.answer, ticket: here.id })
      } else {
        const history = list.slice(-8).map((m) => ({ role: m.role === 'you' ? ('you' as const) : ('mevo' as const), text: m.text }))
        const r = await askMetwo(text, history)
        push({ role: 'mo', text: r.answer, ids: r.ids, plan: r.plan })
      }
    } catch (err) {
      push({ role: 'mo', text: `I couldn't answer that: ${err instanceof Error ? err.message : String(err)}` })
    } finally {
      setBusy(false)
      onBusy(false)
    }
  }

  const run = async (a: AssistAction) => {
    try {
      const { results } = await runAssist([a])
      const r = results[0]
      notice({ title: r?.text ?? describe(a), tone: r?.ok === false ? 'bad' : 'ok' })
    } catch (err) {
      failed(err)
    }
  }

  const known = (id: string) => Boolean(state.tickets[id] || state.reviews?.[id])
  const label = (id: string) => {
    const t = state.tickets[id]
    if (t) return t.pr ? `${id} · #${t.pr.number}` : id
    const r = state.reviews?.[id]
    return r ? `Review #${r.number}` : id
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-line-2 bg-panel shadow-2xl shadow-black/40">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-xs">
        <span className="font-semibold text-fg">Mo</span>
        <span className="min-w-0 flex-1 truncate text-muted">{here ? `about ${here.id}` : 'ask about your tickets, PRs and reviews'}</span>
        {here && (
          <button type="button" className="shrink-0 text-accent-fg hover:underline" onClick={() => dispatchEvent(new CustomEvent(TELL_EVENT, { detail: { handled: false } }))}>
            Full chat
          </button>
        )}
        {list.length > 0 && (
          <button type="button" className="shrink-0 text-muted hover:text-fg" onClick={() => (setList([]), save([]))}>
            Clear
          </button>
        )}
        <button type="button" aria-label="Close Mo's chat" className="shrink-0 px-1 text-muted hover:text-fg" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3 text-[13px]">
        {list.length === 0 && (
          <p className="text-muted">
            {here ? `Ask me anything about ${here.id}: what changed, why a check failed, what a reviewer asked.` : 'Hi! Ask me what needs you, which PRs wait on someone, or say "open WEB-2109" and I take you there.'}
          </p>
        )}
        {list.map((m, i) =>
          m.role === 'you' ? (
            <p key={i} className="max-w-[85%] self-end rounded-2xl rounded-br-md bg-accent px-3 py-1.5 text-white">
              {m.text}
            </p>
          ) : (
            <div key={i} className="flex max-w-[92%] flex-col gap-1.5 self-start">
              <div className="rounded-2xl rounded-bl-md bg-raised px-3 py-1.5 text-fg">
                <Markdown source={m.text} {...(m.ticket ? { ticketId: m.ticket } : {})} className="text-[13px] [&_p]:my-0.5" />
              </div>
              {(m.ids?.some(known) || m.plan?.length) && (
                <div className="flex flex-wrap gap-1.5">
                  {m.ids?.filter(known).slice(0, 4).map((id) => (
                    <button key={id} type="button" onClick={() => go(id)} className="rounded-full border border-line-2 px-2 py-0.5 text-[11.5px] text-accent-fg hover:border-accent">
                      {label(id)} →
                    </button>
                  ))}
                  {m.plan?.slice(0, 2).map((p, j) => (
                    <button key={j} type="button" title={p.why} onClick={() => void run(p.action)} className="rounded-full border border-accent/50 bg-accent/10 px-2 py-0.5 text-[11.5px] text-fg hover:border-accent">
                      {describe(p.action)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ),
        )}
        {busy && <p className="self-start rounded-2xl rounded-bl-md bg-raised px-3 py-1.5 text-muted">thinking…</p>}
        <div ref={end} />
      </div>
      <form onSubmit={(e) => void send(e)} className="flex items-center gap-2 border-t border-line px-2 py-2">
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={here ? `Ask about ${here.id}…` : 'Ask Mo…'}
          aria-label="Ask Mo"
          className="min-w-0 flex-1 rounded-lg bg-bg px-2.5 py-1.5 text-[13px] text-fg outline-none placeholder:text-dim focus:ring-1 focus:ring-accent max-md:text-[16px]"
        />
        <button type="submit" disabled={busy || !q.trim()} className="rounded-lg bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-white disabled:opacity-40">
          Send
        </button>
      </form>
    </div>
  )
}
