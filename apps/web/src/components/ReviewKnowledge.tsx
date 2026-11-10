import type { FixEntry, FixLogView } from '@ticketflow/shared'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import { learnReviews, loadReviewKnowledge } from '../lib/api.js'
import { failed, notice } from '../lib/notice.js'
import { desktop } from '../lib/tauri.js'
import { Avatar, Button, Mono, Pill, rise, timeAgo } from './ui.js'

const VERDICT: Record<FixEntry['verdict'], { label: string; tone: 'ok' | 'neutral' | 'accent' | 'warn' }> = {
  fixed: { label: 'fixed', tone: 'ok' },
  declined: { label: 'declined', tone: 'neutral' },
  answered: { label: 'answered', tone: 'accent' },
  open: { label: 'open', tone: 'warn' },
}

// Every comment teammates and Greptile left on your PRs and how it ended. Lanes get the matching
// ones before they build, and reviews of others' PRs use them as the team's standards.
export function ReviewKnowledge() {
  const [view, setView] = useState<FixLogView | null>(null)
  const [q, setQ] = useState('')
  const [who, setWho] = useState<string | null>(null)
  const [prs, setPrs] = useState('')
  const [busy, setBusy] = useState(false)
  const load = async () => setView(await loadReviewKnowledge().catch(() => null))
  useEffect(() => {
    void load()
  }, [])
  // poll while it is learning
  useEffect(() => {
    if (!view?.learning.running) return
    const t = setInterval(() => void load(), 3000)
    return () => clearInterval(t)
  }, [view?.learning.running])

  const start = async (list?: number[]) => {
    setBusy(true)
    try {
      const r = await learnReviews(list)
      notice({ title: r.queued ? `Reading ${r.queued} PR${r.queued === 1 ? '' : 's'}` : 'Nothing new to read', detail: 'One small model call per PR', tone: 'accent' })
      setPrs('')
      await load()
    } catch (err) {
      failed(err)
    } finally {
      setBusy(false)
    }
  }
  const words = q.trim().toLowerCase()
  const shown = useMemo(
    () => (view?.entries ?? []).filter((e) => (!who || e.reviewer === who) && (!words || `${e.comment} ${e.resolution} ${e.file ?? ''} ${e.tags.join(' ')} #${e.pr} ${e.ticket ?? ''}`.toLowerCase().includes(words))).slice(0, 80),
    [view, who, words],
  )
  const l = view?.learning
  return (
    <motion.section variants={rise} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h2 className="text-sm font-medium">Review knowledge</h2>
          <p className="text-xs text-muted">
            {view ? `${view.entries.length} comments from ${view.prs} PRs` : 'Loading…'} · how each review comment on your PRs ended. New tickets get the matching ones in their brief, your review pass checks for repeats, and reviews of teammates' PRs use them as the team's standards. Each PR read is one small model call; rounds you fix in mevo are added by themselves.
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={busy || l?.running} onClick={() => void start()}>
          {l?.running ? `Reading PRs… ${l.done}/${l.total}${l.current ? ` (#${l.current})` : ''}` : 'Learn from my reviewed PRs'}
        </Button>
        <form
          className="flex items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            const list = prs.split(/[\s,]+/).map((x) => Number(x.replace(/^#/, '').replace(/.*\/pull\//, ''))).filter((n) => Number.isInteger(n) && n > 0)
            if (list.length) void start(list)
          }}
        >
          <input value={prs} onChange={(e) => setPrs(e.target.value)} placeholder="or PR numbers: 1617, 1640" className="w-48 rounded-md border border-line-2 bg-bg px-2.5 py-1.5 text-xs text-fg outline-none focus:border-accent max-md:text-[16px]" />
          <Button type="submit" disabled={busy || !prs.trim()}>
            Read
          </Button>
        </form>
        <span className="text-[11px] text-dim">your PRs from the last 45 days that got comments, up to 15</span>
      </div>
      {l && l.errors.length > 0 && <p className="text-[11px] text-warn">{l.errors.join(' · ')}</p>}

      {view && view.reviewers.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {view.reviewers.map((r) => (
            <button key={r.login} type="button" onClick={() => setWho(who === r.login ? null : r.login)} className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors ${who === r.login ? 'border-accent/60 bg-accent/10' : 'border-line bg-panel hover:border-line-2'}`}>
              <Avatar login={r.login} size={20} />
              <span className="flex flex-col">
                <span className="text-fg-2">
                  {r.login} <span className="text-dim">· {r.count}</span>
                </span>
                <span className="text-[10.5px] text-dim">{r.topics.join(', ') || 'no topics yet'}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {view && view.entries.length > 0 && (
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search comments, fixes, files, topics" className="rounded-md border border-line-2 bg-bg px-3 py-1.5 text-xs text-fg outline-none focus:border-accent max-md:text-[16px]" />
      )}
      {view && view.entries.length === 0 && !l?.running && <div className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-xs text-dim">Nothing yet. Learn from your reviewed PRs to start.</div>}
      <ul className="flex flex-col gap-2">
        <AnimatePresence initial={false}>
          {shown.map((e) => (
            <motion.li key={e.id} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="flex flex-col gap-1.5 rounded-lg border border-line bg-panel px-3.5 py-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
                {e.source === 'greptile' ? <span className="font-medium text-fg-2">Greptile</span> : (
                  <span className="flex items-center gap-1.5 font-medium text-fg-2">
                    <Avatar login={e.reviewer} size={16} />
                    {e.reviewer}
                  </span>
                )}
                <Pill tone={VERDICT[e.verdict].tone}>{VERDICT[e.verdict].label}</Pill>
                {e.file && (
                  <Mono className="truncate text-dim">
                    {e.file}
                    {e.line ? `:${e.line}` : ''}
                  </Mono>
                )}
                <button type="button" className="ml-auto text-accent-fg hover:underline" onClick={() => void desktop.open(e.prUrl)}>
                  #{e.pr}
                </button>
                {e.ticket && <span>{e.ticket}</span>}
                <span className="text-dim">{timeAgo(e.at)} ago</span>
              </div>
              <p className="border-l-2 border-line-2 pl-2 whitespace-pre-wrap text-fg-2">{e.comment.slice(0, 500)}</p>
              <p className="text-fg">
                <span className="text-muted">→ </span>
                {e.resolution}
              </p>
              {e.snippet && <pre className="max-h-32 overflow-auto rounded-md border border-line bg-sunk px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-fg-2">{e.snippet}</pre>}
              {e.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {e.tags.map((t) => (
                    <button key={t} type="button" onClick={() => setQ(t)} className="rounded bg-raised px-1.5 py-px text-[10.5px] text-muted hover:text-fg">
                      {t}
                    </button>
                  ))}
                </div>
              )}
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </motion.section>
  )
}
