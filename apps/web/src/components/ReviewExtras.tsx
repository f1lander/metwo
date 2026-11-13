import type { HumanTestRun, PrReview, Ticket } from '@ticketflow/shared'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { reviewActions } from '../lib/api.js'
import { failed } from '../lib/notice.js'
import { href } from '../lib/route.js'
import { Markdown } from './Markdown.js'
import { Button, timeAgo } from './ui.js'

// a review shaped as a ticket, for the hand test card (same steps panel, wallet and runs)
export function reviewTicket(r: PrReview): Ticket {
  return {
    id: r.id,
    uuid: '',
    title: r.title,
    description: r.body,
    url: r.url,
    branch: r.head,
    labels: [],
    priority: 0,
    estimate: null,
    createdBy: r.author,
    linearState: '',
    seenAt: r.requestedAt,
    updatedAt: r.updatedAt,
    status: 'review_ready',
    decision: 'manual',
    suggestedLane: 'lite',
    reason: '',
    small: false,
    events: [],
    ...(r.worktree ? { worktree: r.worktree } : {}),
    ...(r.testPlan ? { testPlan: r.testPlan } : {}),
    ...(r.humanTests ? { humanTests: r.humanTests } : {}),
    pushedSha: r.headSha,
  } as Ticket
}

export const finishedRuns = (r: PrReview): readonly HumanTestRun[] => (r.humanTests ?? []).filter((x) => x.status === 'passed' || x.status === 'failed' || x.status === 'incomplete')

// Talk to the reviewer after the report: ask about it, or have it check more (it can open the app,
// take screenshots and update the findings). It continues the review's own session.
export function ReviewChat({ review: r }: { review: PrReview }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  const turns = r.chat ?? []
  const working = r.status === 'reviewing'
  const full = r.report?.depth === 'full'
  useEffect(() => end.current?.scrollIntoView({ block: 'nearest' }), [turns.length])
  if (!r.report) return null
  const send = async (mode: 'ask' | 'check') => {
    if (!text.trim()) return
    setBusy(true)
    try {
      await reviewActions.chat(r.id, text.trim(), mode)
      setText('')
    } catch (err) {
      failed(err, r.id)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="flex min-h-0 flex-col gap-2 rounded-lg border border-line bg-panel p-3 text-xs">
      <h2 className="font-medium text-muted">Ask the reviewer</h2>
      <div className="flex max-h-72 min-h-0 flex-col gap-2 overflow-y-auto">
        <AnimatePresence initial={false}>
          {turns.map((t, i) => (
            <motion.div key={`${t.at}-${i}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className={`max-w-[92%] rounded-lg px-2.5 py-2 ${t.who === 'you' ? 'self-end bg-[#1d1b33] text-fg' : 'self-start border border-line bg-bg text-fg-2'}`}>
              <div className="mb-0.5 text-[10px] text-dim">
                {t.who === 'you' ? (t.mode === 'check' ? 'you · check more' : 'you') : t.mode === 'check' ? 'reviewer · checked' : 'reviewer'} · {timeAgo(t.at)} ago{t.cost ? ` · $${t.cost.toFixed(2)}` : ''}
              </div>
              {t.who === 'mevo' ? <Markdown source={t.text} /> : <p className="whitespace-pre-wrap">{t.text}</p>}
            </motion.div>
          ))}
        </AnimatePresence>
        {working && turns.at(-1)?.who === 'you' && (
          <motion.p className="self-start text-muted" animate={{ opacity: [0.4, 1, 0.4] }} transition={{ duration: 1.4, repeat: Infinity }}>
            the reviewer is on it… (the lane log shows what it does)
          </motion.p>
        )}
        {turns.length === 0 && <p className="text-dim">Why it flagged something, whether a finding is real, or what it didn't test. “Check more” sends it back to work: it can open the app and take screenshots{full ? '' : ' (a full review only; this one is read-only)'}, then updates the findings.</p>}
        <div ref={end} />
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send('ask')
        }}
        rows={2}
        disabled={busy || working}
        placeholder={working ? 'busy…' : 'Is finding 1 real? Test the reload during commit on mobile…'}
        className="rounded-md border border-line-2 bg-bg px-2.5 py-2 text-fg outline-none focus:border-accent disabled:opacity-60 max-md:text-[16px]"
      />
      <div className="flex items-center gap-2">
        <Button variant="primary" disabled={busy || working || !text.trim()} onClick={() => void send('ask')} title="an answer from the code and the review; nothing runs (⌘↵)">
          Ask
        </Button>
        <Button disabled={busy || working || !text.trim()} onClick={() => void send('check')} title="back to work: it checks this, may run the app and take screenshots, and updates the findings">
          Check more
        </Button>
        <span className="ml-auto text-dim">continues the review's session</span>
      </div>
    </section>
  )
}

// A review on the board: working while the reviewer runs (or answers you), needs you once the
// report waits to be posted.
export function ReviewBoardCard({ review: r, last }: { review: PrReview; last?: string | undefined }) {
  const working = r.status === 'reviewing' || r.status === 'queued'
  const picked = r.report?.findings.length ?? 0
  return (
    <motion.a
      layout
      href={href.review(r.id)}
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      className={`relative flex flex-col gap-1.5 rounded-lg border p-3 text-xs hover:border-line-2 ${working ? 'border-[#3b2f6b] bg-panel' : 'border-[#3d3522] bg-[#1a1812]'}`}
    >
      {working && <motion.span aria-hidden="true" className="pointer-events-none absolute inset-0 rounded-lg border border-accent-fg/40" animate={{ opacity: [0.15, 0.6, 0.15] }} transition={{ duration: 2.2, repeat: Infinity }} />}
      <div className="flex items-center gap-2">
        <span className="text-muted">PR #{r.number}</span>
        <span className="rounded-full border border-line-2 px-1.5 text-[10px] text-dim">review</span>
        <span className={`ml-auto ${working ? 'text-accent-fg' : 'text-warn'}`}>{r.status === 'queued' ? 'queued' : working ? (r.chat?.at(-1)?.who === 'you' ? 'answering you' : `${r.depth ?? 'full'} review`) : `${r.report?.verdict.replace('_', ' ') ?? 'ready'} · ${picked} finding${picked === 1 ? '' : 's'}`}</span>
      </div>
      <p className="line-clamp-2 font-medium text-fg">{r.title}</p>
      <p className="truncate text-dim">by {r.author}</p>
      {working && last && <p className="truncate font-mono text-[11px] text-muted">{last}</p>}
    </motion.a>
  )
}

export const reviewsOnBoard = (rs: readonly PrReview[]) => ({
  working: rs.filter((r) => r.status === 'reviewing' || r.status === 'queued'),
  ready: rs.filter((r) => r.status === 'reviewed' && !r.posted),
})
