import { openComments, type PrComment, type Ticket } from '@ticketflow/shared'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { actions } from '../lib/api.js'
import { Button, Mono } from './ui.js'

// "lgtm", "thanks", a quick question: worth reading, not worth a lane.
const CHATTER = /^(lgtm|looks good|thanks|thank you|thx|nice|great|👍|🚀|ship it|approved)\b/i
const wantsChange = (c: PrComment) => c.body.trim().length > 25 && !CHATTER.test(c.body.trim())

// Teammates' comments, one by one: send the ones you pick to the lane (with a note), answer
// one yourself, or set it aside. What you handled folds away.
export function CommentPicker({ ticket: t, canAddress }: { ticket: Ticket; canAddress: boolean }) {
  const open = openComments(t)
  const handled = (t.pr?.comments ?? []).filter((c) => !c.bot && !open.includes(c))
  const [picked, setPicked] = useState<Set<string>>(() => new Set(open.filter(wantsChange).map((c) => c.id)))
  const [notes, setNotes] = useState<Record<string, string>>({})
  const [replying, setReplying] = useState<string | null>(null)
  const [showHandled, setShowHandled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true)
    setMsg(null)
    try {
      await fn()
      if (done) setMsg(done)
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const toggle = (id: string) =>
    setPicked((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const chosen = open.filter((c) => picked.has(c.id))

  if (open.length === 0 && handled.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex max-h-[420px] flex-col gap-1.5 overflow-y-auto">
        <AnimatePresence initial={false}>
          {open.map((c) => (
            <motion.li key={c.id} layout exit={{ opacity: 0, height: 0 }} className={`rounded-md border bg-bg px-3 py-2 ${picked.has(c.id) ? 'border-accent/40' : 'border-line'}`}>
              <div className="flex items-start gap-2.5">
                <input type="checkbox" className="mt-0.5 accent-[var(--color-accent)]" checked={picked.has(c.id)} onChange={() => toggle(c.id)} aria-label={`address ${c.author}'s comment`} disabled={!canAddress} />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex items-center gap-2 text-[11px] text-muted">
                    <strong className="shrink-0 font-medium text-fg-2">{c.author}</strong>
                    <span className="shrink-0 whitespace-nowrap">{c.kind === 'inline' ? 'on the code' : c.kind}</span>
                    {c.path && <Mono className="truncate">{c.path}{c.line ? `:${c.line}` : ''}</Mono>}
                    <span className="ml-auto flex shrink-0 gap-2">
                      <button type="button" className="hover:text-fg" onClick={() => setReplying(replying === c.id ? null : c.id)}>
                        Reply
                      </button>
                      <button type="button" className="hover:text-fg" disabled={busy} onClick={() => void run(() => actions.ignoreComments(t, [c.id]))}>
                        Ignore
                      </button>
                    </span>
                  </div>
                  <div className="text-xs whitespace-pre-wrap text-fg-2">{c.body}</div>
                  {picked.has(c.id) && canAddress && (
                    <input
                      value={notes[c.id] ?? ''}
                      onChange={(e) => setNotes({ ...notes, [c.id]: e.target.value })}
                      placeholder="Note for the lane (optional): how you want it handled"
                      className="rounded border border-line-2 bg-panel px-2 py-1 text-xs text-fg outline-none placeholder:text-dim focus:border-accent"
                    />
                  )}
                  {replying === c.id && <ReplyBox ticket={t} comment={c} onDone={() => setReplying(null)} />}
                </div>
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        {open.length > 0 && canAddress && (
          <Button variant="primary" disabled={busy || chosen.length === 0} onClick={() => void run(() => actions.fixComments(t, chosen.map((c) => ({ id: c.id, ...(notes[c.id]?.trim() ? { note: notes[c.id] } : {}) }))), 'The lane is on it; the rest stay open.')}>
            Address {chosen.length === open.length && open.length > 1 ? `all ${open.length}` : chosen.length} comment{chosen.length === 1 ? '' : 's'}
          </Button>
        )}
        {handled.length > 0 && (
          <button type="button" className="text-xs text-muted hover:text-fg" onClick={() => setShowHandled(!showHandled)}>
            {showHandled ? 'Hide' : 'Show'} {handled.length} handled
          </button>
        )}
        {msg && <span className="text-xs text-fg-2">{msg}</span>}
      </div>
      {showHandled && (
        <ul className="flex flex-col gap-1">
          {handled.map((c) => (
            <li key={c.id} className="flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-[11px] text-dim">
              <span className="shrink-0 rounded bg-raised px-1.5 text-muted">{t.commentsHandled?.[c.id]?.how ?? 'addressed'}</span>
              <span className="shrink-0 text-muted">{c.author}</span>
              <span className="truncate">{c.body.replace(/\s+/g, ' ')}</span>
              {t.commentsHandled?.[c.id] && (
                <button type="button" className="ml-auto shrink-0 hover:text-fg" onClick={() => void run(() => actions.ignoreComments(t, [c.id], true))}>
                  Reopen
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ReplyBox({ ticket: t, comment: c, onDone }: { ticket: Ticket; comment: PrComment; onDone: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState<'draft' | 'post' | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const go = async (kind: 'draft' | 'post') => {
    setBusy(kind)
    setErr(null)
    try {
      if (kind === 'draft') setText((await actions.draftReply(t, c.id, text)).text)
      else {
        await actions.replyComment(t, c.id, text)
        onDone()
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="flex flex-col gap-1.5">
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} placeholder="Your reply, or a hint and Draft it" className="rounded border border-line-2 bg-panel px-2 py-1.5 text-xs text-fg outline-none placeholder:text-dim focus:border-accent" />
      <div className="flex items-center gap-2">
        <Button disabled={busy !== null} onClick={() => void go('draft')}>
          {busy === 'draft' ? 'Drafting…' : 'Draft it'}
        </Button>
        <Button variant="primary" disabled={busy !== null || !text.trim()} onClick={() => void go('post')}>
          {c.kind === 'inline' ? 'Reply in thread' : 'Post reply'}
        </Button>
        {err && <span className="text-xs text-bad">{err}</span>}
      </div>
    </div>
  )
}
