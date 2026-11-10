import { openComments, type PrComment, type Ticket } from '@ticketflow/shared'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { actions, learnReviews } from '../lib/api.js'
import { Button, Mono, Person, Pill } from './ui.js'

// Each verdict says what you do with the comment: fix ones stay picked for the lane, reply ones get a suggested answer.
const TRIAGE = {
  valid: { label: 'fix', tone: 'ok', fix: true, hint: 'The reviewer is right. It stays checked and goes to the lane with the note below.' },
  partly: { label: 'fix part', tone: 'warn', fix: true, hint: 'Only part holds. The lane does what the note says; reply about the rest if you want.' },
  disagree: { label: 'reply: code is fine', tone: 'neutral', fix: false, hint: 'Nothing to change. Unchecked; post a reply that explains why.' },
  question: { label: 'answer', tone: 'accent', fix: false, hint: 'They asked something. Unchecked; answer it, no code change.' },
} as const

// "lgtm", "thanks", a quick question: worth reading, not worth a lane.
const CHATTER = /^(lgtm|looks good|thanks|thank you|thx|nice|great|👍|🚀|ship it|approved)\b/i
const wantsChange = (c: PrComment) => c.body.trim().length > 25 && !CHATTER.test(c.body.trim())

// Teammates' comments, one by one: send the ones you pick to the lane (with a note), answer
// one yourself, or set it aside. What you handled folds away.
export function CommentPicker({ ticket: t, canAddress }: { ticket: Ticket; canAddress: boolean }) {
  const open = openComments(t)
  const handled = (t.pr?.comments ?? []).filter((c) => !c.bot && !open.includes(c))
  const replyOnly = (id: string) => { const v = t.commentTriage?.[id]?.verdict; return v === 'disagree' || v === 'question' }
  const [picked, setPicked] = useState<Set<string>>(() => new Set(open.filter((c) => wantsChange(c) && !replyOnly(c.id)).map((c) => c.id)))
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
      if (done) {
        setMsg(done)
        setTimeout(() => setMsg(null), 5000)
      }
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
  const triage = t.commentTriage ?? {}
  // a run older than 10 minutes was cut off by a daemon restart
  const analyzing = t.triaging && !t.triaging.error && Date.now() - Date.parse(t.triaging.at) < 10 * 60_000 ? t.triaging : null
  const analyzed = open.filter((c) => triage[c.id])
  const toFix = analyzed.filter((c) => TRIAGE[triage[c.id]!.verdict].fix).length
  // Analyze first: valid ones keep their pick with the plan as the note; the rest get a reply to send
  // applied from the ticket, so it also lands when you left the page while it ran
  const stamp = Object.entries(triage).map(([id, v]) => `${id}@${v.at}`).join(',')
  useEffect(() => {
    setNotes((n) => ({ ...n, ...Object.fromEntries(Object.entries(triage).filter(([id, v]) => v.plan && !n[id]?.trim()).map(([id, v]) => [id, v.plan as string])) }))
    setPicked((p) => new Set([...p].filter((id) => !replyOnly(id))))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stamp])
  const analyze = () => run(() => actions.triageComments(t, chosen.map((c) => c.id)))

  if (open.length === 0 && handled.length === 0) return null
  return (
    <div className="flex flex-col gap-2">
      <AnimatePresence initial={false}>
        {analyzing && <Analyzing key="run" step={analyzing.step} at={analyzing.at} />}
        {!analyzing && t.triaging?.error && (
          <motion.div key="err" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="rounded-md border border-bad/40 bg-bad/5 px-3 py-2 text-xs text-fg-2">
            <span className="font-medium text-bad">Analysis failed: </span>
            {t.triaging.error}
          </motion.div>
        )}
        {!analyzing && analyzed.length > 0 && (
          <motion.div key="sum" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-line bg-panel px-3 py-2 text-[11px] text-muted">
            <span className="font-medium text-fg-2">Analysis</span>
            <span>
              <span className="text-ok">{toFix} to fix</span> (checked, they go to the lane)
            </span>
            <span>
              <span className="text-fg-2">{analyzed.length - toFix} to reply</span> (unchecked, use the suggested reply)
            </span>
          </motion.div>
        )}
      </AnimatePresence>
      <ul className="flex max-h-[420px] flex-col gap-1.5 overflow-y-auto">
        <AnimatePresence initial={false}>
          {open.map((c) => (
            <motion.li key={c.id} layout exit={{ opacity: 0, height: 0 }} className={`rounded-md border bg-bg px-3 py-2 ${picked.has(c.id) ? 'border-accent/40' : 'border-line'}`}>
              <div className="flex items-start gap-2.5">
                <input type="checkbox" className="mt-0.5 accent-[var(--color-accent)]" checked={picked.has(c.id)} onChange={() => toggle(c.id)} aria-label={`address ${c.author}'s comment`} disabled={!canAddress} />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex items-center gap-2 text-[11px] text-muted">
                    <Person login={c.author} className="shrink-0 font-medium text-fg-2" />
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
                  {analyzing?.ids.includes(c.id) ? (
                    <motion.div className="rounded border border-dashed border-line-2 px-2 py-1.5 text-[11px] text-muted" animate={{ opacity: [0.45, 1, 0.45] }} transition={{ duration: 1.6, repeat: Infinity }}>
                      Analyzing against the code…
                    </motion.div>
                  ) : triage[c.id] && (
                    <div className="flex flex-col gap-1 rounded border border-line bg-panel px-2 py-1.5 text-[11px]">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Pill tone={TRIAGE[triage[c.id]!.verdict].tone}>{TRIAGE[triage[c.id]!.verdict].label}</Pill>
                        <span className="text-dim">{TRIAGE[triage[c.id]!.verdict].hint}</span>
                      </span>
                      <span className="text-fg-2">{triage[c.id]!.why}</span>
                      {triage[c.id]!.reply && replying !== c.id && (
                        <button type="button" className="self-start text-accent-fg hover:underline" onClick={() => setReplying(c.id)}>
                          Use the suggested reply
                        </button>
                      )}
                    </div>
                  )}
                  {picked.has(c.id) && canAddress && (
                    <input
                      value={notes[c.id] ?? ''}
                      onChange={(e) => setNotes({ ...notes, [c.id]: e.target.value })}
                      placeholder="Note for the lane (optional): how you want it handled"
                      className="rounded border border-line-2 bg-panel px-2 py-1 text-xs text-fg outline-none placeholder:text-dim focus:border-accent"
                    />
                  )}
                  {replying === c.id && <ReplyBox ticket={t} comment={c} initial={triage[c.id]?.reply ?? ''} onDone={() => setReplying(null)} />}
                </div>
              </div>
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
      <div className="flex flex-wrap items-center gap-2">
 {open.length > 0 && chosen.length > 0 && (
          <Button disabled={busy || !!analyzing} title="a read-only pass judges each picked comment against the code: fix it, or reply because the code is fine" onClick={() => void analyze()}>
            {analyzing ? 'Analyzing…' : analyzed.length ? 'Analyze again' : 'Analyze first'}
          </Button>
        )}
        {open.length > 0 && canAddress && (
          <Button variant="primary" disabled={busy || !!analyzing || chosen.length === 0} onClick={() => void run(() => actions.fixComments(t, chosen.map((c) => ({ id: c.id, ...(notes[c.id]?.trim() ? { note: notes[c.id] } : {}) }))), 'The lane is on it; the rest stay open.')}>
            Address {chosen.length === open.length && open.length > 1 ? `all ${open.length}` : chosen.length} comment{chosen.length === 1 ? '' : 's'}
          </Button>
        )}
        {open.length > 0 && canAddress && (
          <Button
            disabled={busy || !!analyzing || chosen.length === 0}
            title="for small changes (a token, a copy, a prop): a fresh session on a cheaper model, no screenshots or e2e. It leaves you what to check by hand."
            onClick={() => void run(() => actions.fixComments(t, chosen.map((c) => ({ id: c.id, ...(notes[c.id]?.trim() ? { note: notes[c.id] } : {}) })), true), 'Quick fix on it; you check it by hand.')}
          >
            Quick fix
          </Button>
        )}
        {handled.length > 0 && (
          <button type="button" className="text-xs text-muted hover:text-fg" onClick={() => setShowHandled(!showHandled)}>
            {showHandled ? 'Hide' : 'Show'} {handled.length} handled
          </button>
        )}
        {t.pr && (
          <button type="button" className="ml-auto text-xs text-muted hover:text-fg" title="files how each review comment on this PR ended into the review knowledge (Learnings)" onClick={() => void run(() => learnReviews([t.pr?.number as number]), 'Reading this PR into the review knowledge.')}>
            Learn from these comments
          </button>
        )}
        {msg && <span className="w-full text-xs text-fg-2">{msg}</span>}
      </div>
      {showHandled && (
        <ul className="flex flex-col gap-1">
          {handled.map((c) => (
            <li key={c.id} className="flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-[11px] text-dim">
              <span className="shrink-0 rounded bg-raised px-1.5 text-muted">{t.commentsHandled?.[c.id]?.how ?? 'addressed'}</span>
              <Person login={c.author} size={14} className="shrink-0 text-muted" />
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

function ReplyBox({ ticket: t, comment: c, initial = '', onDone }: { ticket: Ticket; comment: PrComment; initial?: string; onDone: () => void }) {
  const [text, setText] = useState(initial)
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

// Where "Analyze first" is: the step the daemon reports, and how long it has run.
function Analyzing({ step, at }: { step: string; at: string }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const i = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(i)
  }, [])
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 1000))
  return (
    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="flex flex-col gap-1.5 overflow-hidden rounded-md border border-accent/40 bg-accent/5 px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <motion.span className="size-2 rounded-full bg-accent" animate={{ scale: [1, 1.5, 1], opacity: [1, 0.5, 1] }} transition={{ duration: 1.2, repeat: Infinity }} />
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={step} initial={{ y: 6, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -6, opacity: 0 }} className="text-fg">
            {step}
          </motion.span>
        </AnimatePresence>
        <span className="ml-auto tabular-nums text-muted">{secs}s</span>
      </div>
      <div className="h-0.5 overflow-hidden rounded bg-line">
        <motion.div className="h-full w-1/3 rounded bg-accent" animate={{ x: ['-100%', '300%'] }} transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }} />
      </div>
      <span className="text-[11px] text-dim">Read-only, nothing changes or posts. Usually takes under a minute; you can leave this page.</span>
    </motion.div>
  )
}
