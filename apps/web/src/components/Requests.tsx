import { type ChangeRequest, openRequests, type Ticket } from '@ticketflow/shared'
import { AnimatePresence, motion } from 'motion/react'
import { createContext, useContext, useState } from 'react'
import { actions } from '../lib/api.js'
import { failed, notice } from '../lib/notice.js'
import { href } from '../lib/route.js'
import { Button, Count, Pill, timeAgo } from './ui.js'

// open requests per ticket, for the chip on the ticket's card
export const RequestCounts = createContext<Readonly<Record<string, number>>>({})
export const useRequestCount = (id: string) => useContext(RequestCounts)[id] ?? 0

export function requestCounts(rs: readonly ChangeRequest[] | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const r of openRequests(rs)) out[r.ticketId] = (out[r.ticketId] ?? 0) + 1
  return out
}

const READ: Record<ChangeRequest['read'], { label: string; tone: 'ok' | 'warn' | 'neutral' }> = {
  makes_sense: { label: 'makes sense', tone: 'ok' },
  check: { label: 'check it', tone: 'warn' },
  out_of_scope: { label: 'out of scope', tone: 'neutral' },
}
const SOURCE: Record<ChangeRequest['sources'][number]['kind'], string> = { linear: 'Linear', github: 'PR', slack: 'Slack' }

// The Requests column: asks for changes on your tickets, read by mevo, waiting for you to send them
// to the lane, answer or decline. Grouped by ticket; sent ones stay until their reply is posted.
export function RequestsColumn({ requests, tickets }: { requests: readonly ChangeRequest[]; tickets: readonly Ticket[] }) {
  const live = requests.filter((r) => r.status === 'new' || r.status === 'sent' || r.status === 'addressed')
  const byTicket = [...new Set(live.map((r) => r.ticketId))]
  const [scanning, setScanning] = useState(false)
  const scan = async () => {
    setScanning(true)
    try {
      await actions.requestScan()
    } catch (err) {
      failed(err)
    } finally {
      setScanning(false)
    }
  }
  const waiting = openRequests(requests).length
  return (
    <section className="flex min-h-0 w-[88vw] max-w-[420px] shrink-0 snap-start flex-col md:w-auto md:max-w-none md:min-w-0">
      <h2 className={`flex shrink-0 items-center gap-2 whitespace-nowrap pt-4 pb-2 text-xs font-medium max-md:hidden ${waiting ? 'text-fg' : 'text-muted'}`}>
        <span className="size-2 rounded-full bg-[#e0a458]" aria-hidden="true" />
        Requests
        <Count value={waiting} className="text-dim" />
        <button type="button" onClick={() => void scan()} disabled={scanning} className="ml-auto text-dim hover:text-fg" title="read new Linear comments, PR comments and Slack messages now">
          {scanning ? 'checking…' : 'check now'}
        </button>
      </h2>
      <div className="-mx-1 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain px-1 pt-4 pb-4 max-md:pb-24 md:pt-0">
        <AnimatePresence mode="popLayout" initial={false}>
          {byTicket.map((id) => {
            const t = tickets.find((x) => x.id === id)
            const rs = live.filter((r) => r.ticketId === id)
            const fresh = rs.filter((r) => r.status === 'new')
            return (
              <motion.div key={id} layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96 }} className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-xs">
                  <a href={href.ticket(id)} className="min-w-0 truncate text-muted hover:text-fg">
                    <span className="text-fg">{id}</span> {t?.title ?? ''}
                  </a>
                  {fresh.length > 1 && <SendAll ticketId={id} n={fresh.length} />}
                </div>
                {rs.map((r) => (
                  <RequestCard key={r.id} r={r} ticket={t} />
                ))}
              </motion.div>
            )
          })}
        </AnimatePresence>
        {byTicket.length === 0 && (
          <div className="rounded-lg border border-dashed border-line px-3 py-6 text-center text-xs text-dim">
            No requests. Asks for changes in Linear, on your PRs or in Slack show up here.
          </div>
        )}
      </div>
    </section>
  )
}

function SendAll({ ticketId, n }: { ticketId: string; n: number }) {
  const [busy, setBusy] = useState(false)
  const go = async () => {
    setBusy(true)
    try {
      await actions.requestSendAll(ticketId)
      notice({ id: ticketId, title: `Sent ${n} requests to the lane`, tone: 'ok' })
    } catch (err) {
      failed(err, ticketId)
    } finally {
      setBusy(false)
    }
  }
  return (
    <button type="button" disabled={busy} onClick={() => void go()} className="ml-auto shrink-0 text-accent-fg hover:underline" title="every open request on this ticket, as one instruction in one run">
      Send all {n}
    </button>
  )
}

function RequestCard({ r, ticket }: { r: ChangeRequest; ticket: Ticket | undefined }) {
  const [instruction, setInstruction] = useState(r.instruction)
  const [answer, setAnswer] = useState<null | 'reply' | 'decline'>(null)
  const [text, setText] = useState(r.reply)
  const [draft, setDraft] = useState(r.addressed?.draft ?? '')
  const [busy, setBusy] = useState(false)
  const act = (fn: () => Promise<unknown>, done?: string) => async () => {
    setBusy(true)
    try {
      await fn()
      if (done) notice({ id: r.ticketId, title: done, tone: 'ok' })
      setAnswer(null)
    } catch (err) {
      failed(err, r.ticketId)
    } finally {
      setBusy(false)
    }
  }
  const saveInstruction = () => {
    if (instruction.trim() && instruction !== r.instruction) void actions.requestEdit(r.id, { instruction: instruction.trim() }).catch((err: unknown) => failed(err, r.ticketId))
  }
  const read = READ[r.read]
  const noWorktree = !ticket?.worktree
  return (
    <motion.article layout className={`flex flex-col gap-2 rounded-lg border p-3 text-xs ${r.status === 'new' ? 'border-[#4a3b22] bg-[#1a1712]' : 'border-line bg-panel'}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill tone={r.kind === 'bug' ? 'bad' : 'accent'}>{r.kind}</Pill>
        <Pill tone={read.tone}>{read.label}</Pill>
        {r.status === 'sent' && <Pill tone="accent">in the lane</Pill>}
        {r.status === 'addressed' && <Pill tone="ok">addressed in {r.addressed?.sha}</Pill>}
        <span className="ml-auto text-dim">{timeAgo(r.createdAt)} ago</span>
      </div>
      <p className="font-medium text-fg">{r.ask}</p>
      {r.sources.map((s) => (
        <blockquote key={`${s.kind}:${s.ref}`} className="border-l-2 border-line-2 pl-2 text-muted">
          <div className="mb-0.5 flex items-center gap-1.5 text-dim">
            {s.author} · {SOURCE[s.kind]} · {timeAgo(s.at)} ago
            <a href={s.url} target="_blank" rel="noreferrer" className="ml-auto text-accent-fg hover:underline">
              open
            </a>
          </div>
          <p className="line-clamp-4 whitespace-pre-wrap">{s.quote}</p>
        </blockquote>
      ))}
      {r.why && (
        <p className="text-muted">
          <span className="text-dim">mevo:</span> {r.why}
        </p>
      )}

      {r.status === 'new' && (
        <>
          <label className="flex flex-col gap-1">
            <span className="text-dim">What the lane gets</span>
            <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} onBlur={saveInstruction} rows={3} className="rounded-md border border-line bg-bg px-2 py-1.5 text-fg" />
          </label>
          <div className="flex flex-wrap gap-1.5">
            {r.read === 'out_of_scope' ? (
              <Button variant="primary" disabled={busy} onClick={act(() => actions.requestTicket(r.id), 'Made a new Linear issue; the reply is ready below')}>
                New ticket
              </Button>
            ) : null}
            <Button variant={r.read === 'out_of_scope' ? 'default' : 'primary'} disabled={busy || noWorktree} title={noWorktree ? 'start the ticket first' : 'send it to the ticket\'s lane'} onClick={act(async () => { saveInstruction(); await actions.requestSend(r.id, false) }, 'Sent to the lane')}>
              Send to lane
            </Button>
            <Button disabled={busy || noWorktree} title="a fresh, cheap session for a small change" onClick={act(async () => { saveInstruction(); await actions.requestSend(r.id, true) }, 'Sent as a quick fix')}>
              Quick fix
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => setAnswer(answer === 'reply' ? null : 'reply')}>
              Reply
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => { setText(''); setAnswer(answer === 'decline' ? null : 'decline') }}>
              Decline
            </Button>
            <Button variant="ghost" disabled={busy} onClick={act(() => actions.requestClose(r.id))} title="close it without answering">
              Done
            </Button>
          </div>
        </>
      )}

      {answer && (
        <div className="flex flex-col gap-1.5">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder={answer === 'decline' ? 'why not (optional; empty closes it without a reply)' : 'your answer'} className="rounded-md border border-line bg-bg px-2 py-1.5 text-fg" />
          <div className="flex items-center gap-1.5">
            <Button variant="primary" disabled={busy || (answer === 'reply' && !text.trim())} onClick={act(() => (answer === 'reply' ? actions.requestReply(r.id, text) : actions.requestDecline(r.id, text)), answer === 'reply' ? 'Replied' : 'Declined')}>
              {answer === 'reply' ? 'Post reply' : 'Decline'}
            </Button>
            <span className="text-dim">posted as you, in {r.sources.map((s) => SOURCE[s.kind]).join(' and ')}</span>
          </div>
        </div>
      )}

      {r.status === 'sent' && <p className="text-dim">Sent {timeAgo(r.sent?.at)} ago{r.sent?.quick ? ' as a quick fix' : ''}. After the push, the reply waits here.</p>}

      {r.status === 'addressed' && (
        <div className="flex flex-col gap-1.5">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} className="rounded-md border border-line bg-bg px-2 py-1.5 text-fg" />
          <div className="flex items-center gap-1.5">
            <Button variant="primary" disabled={busy || !draft.trim()} onClick={act(() => actions.requestAddressed(r.id, draft), 'Told them it is addressed')}>
              Post reply
            </Button>
            <Button variant="ghost" disabled={busy} onClick={act(() => actions.requestClose(r.id))}>
              Close without a reply
            </Button>
          </div>
        </div>
      )}
    </motion.article>
  )
}
