import type { LearningProposal } from '@ticketflow/shared'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useState } from 'react'
import { learningActions, loadLearnings } from '../lib/api.js'
import { Markdown } from './Markdown.js'
import { Button, Pill, rise, stagger, timeAgo } from './ui.js'

// Rules the curator proposed from PR feedback, waiting for you, and the ones every brief includes.
export function LearningsPage() {
  const [data, setData] = useState<{ lastRunAt: string | null; proposals: LearningProposal[]; rules: string } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const d = await loadLearnings()
      setData({ lastRunAt: d.lastRunAt ?? null, proposals: Array.isArray(d.proposals) ? d.proposals : [], rules: typeof d.rules === 'string' ? d.rules : '' })
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
    }
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])

  const act = (key: string, fn: () => Promise<unknown>, done?: (r: unknown) => string) => async () => {
    setBusy(key)
    setNote(null)
    try {
      const r = await fn()
      if (done) setNote(done(r))
      await refresh()
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const rules = (data?.rules ?? '').split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2))

  return (
    <motion.div variants={stagger} initial="hidden" animate="show" className="mx-auto flex w-full max-w-[880px] flex-col gap-5 overflow-y-auto px-6 py-6 max-md:px-4 max-md:pb-24">
      <motion.div variants={rise} className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-lg font-semibold">Learnings</h1>
          <p className="text-xs text-muted">
            Rules proposed from PR feedback (Greptile, teammates, the supervisor, your instructions). Approved ones go to <span className="font-mono">learnings/rules.md</span> and into every brief.
            {data?.lastRunAt ? ` Last read ${timeAgo(data.lastRunAt)} ago.` : ''}
          </p>
        </div>
        <Button variant="primary" className="ml-auto" disabled={busy !== null} onClick={act('run', () => learningActions.run(), (r) => `${(r as { proposed: number }).proposed} new proposal(s)`)}>
          {busy === 'run' ? 'Reading feedback…' : 'Read recent feedback'}
        </Button>
      </motion.div>
      {note && <p className="text-xs text-fg-2">{note}</p>}

      <motion.section variants={rise} className="flex flex-col gap-2">
        <h2 className="text-xs font-medium text-muted">Waiting for you · {data?.proposals.length ?? 0}</h2>
        {data && data.proposals.length === 0 && <div className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-xs text-dim">Nothing to review.</div>}
        <AnimatePresence initial={false}>
          {data?.proposals.map((p) => (
            <Proposal key={p.id} proposal={p} busy={busy !== null} onDecide={(approve, text) => act(p.id, () => learningActions.decide(p.id, approve, text))()} />
          ))}
        </AnimatePresence>
      </motion.section>

      <motion.section variants={rise} className="flex flex-col gap-2">
        <h2 className="text-xs font-medium text-muted">In every brief · {rules.length}</h2>
        {rules.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-xs text-dim">No approved rules yet.</div>
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-panel">
            {rules.map((r) => (
              <li key={r} className="group flex items-start gap-3 px-4 py-2.5">
                <div className="flex-1">
                  <Markdown source={r} className="text-[13px]" />
                </div>
                <button type="button" className="text-xs text-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-bad max-md:opacity-100" disabled={busy !== null} onClick={act(`rm-${r}`, () => learningActions.remove(r.split(' (')[0] ?? r))}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </motion.section>
    </motion.div>
  )
}

function Proposal({ proposal: p, busy, onDecide }: { proposal: LearningProposal; busy: boolean; onDecide: (approve: boolean, text?: string) => void }) {
  const [text, setText] = useState(p.rule)
  return (
    <motion.div layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, x: 40 }} className="flex flex-col gap-2 rounded-lg border border-line bg-panel px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Pill>{p.area}</Pill>
        <span className="text-muted">{p.why}</span>
        <span className="ml-auto text-dim">{p.engine}</span>
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} aria-label="rule text" className="rounded-md border border-line-2 bg-bg px-3 py-2 text-[13px] leading-relaxed outline-none focus:border-accent" />
      {p.sources.length > 0 && <div className="flex flex-wrap gap-2 text-[11px] text-muted">{p.sources.map((s) => <span key={s} className="font-mono">{s}</span>)}</div>}
      <div className="flex gap-2">
        <Button variant="primary" disabled={busy || !text.trim()} onClick={() => onDecide(true, text !== p.rule ? text : undefined)}>
          Approve
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => onDecide(false)}>
          Reject
        </Button>
      </div>
    </motion.div>
  )
}
