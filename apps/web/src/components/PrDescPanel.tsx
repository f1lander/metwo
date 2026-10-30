import type { Ticket } from '@ticketflow/shared'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { actions } from '../lib/api.js'
import { Button } from './ui.js'

// Post to PR: as a comment, or as an update to the PR description (the checklists the new
// visual check resolved, a dated line in Updates, an optional short comment). You approve each line.
export function PostToPr({ ticket: t, onClose }: { ticket: Ticket; onClose: () => void }) {
  const p = t.descProposal
  const [open, setOpen] = useState<number | null>(null)
  const [mode, setMode] = useState<'description' | 'comment'>('description')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [keep, setKeep] = useState<Set<string>>(new Set())
  const [withComment, setWithComment] = useState(true)
  const [comment, setComment] = useState('')
  const [logLine, setLogLine] = useState('')

  useEffect(() => {
    actions.descOpen(t).then((r) => {
      setOpen(r.open)
      setMode(r.open > 0 || p ? 'description' : 'comment')
    }, () => setOpen(0))
  }, [t.id])
  useEffect(() => {
    if (p?.status !== 'ready') return
    setKeep(new Set(p.changes.map((c) => c.id)))
    setComment(p.comment)
    setLogLine(p.log)
  }, [p?.status, p?.at])

  const run = async (fn: () => Promise<unknown>, done: string | null) => {
    setBusy(true)
    setNote(null)
    try {
      await fn()
      if (done) {
        setNote(done)
        setTimeout(onClose, 1600)
      }
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const toggle = (id: string) => setKeep((s) => {
    const next = new Set(s)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  return (
    <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-3 rounded-lg border border-line-2 bg-sunk px-3 py-3 text-xs">
      {!p && (
        <>
          <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="how to post">
            <Choice on={mode === 'description'} onClick={() => setMode('description')} title={`Update the PR description${open ? ` · ${open} open check${open === 1 ? '' : 's'}` : ''}`} hint="Ticks the checklist items this check proved, updates known gaps and swaps the retaken screenshots. Adds a dated line to Updates and, if you want, a short comment. You approve each change first." />
            <Choice on={mode === 'comment'} onClick={() => setMode('comment')} title="Post as a comment" hint="The verdict, the checks and the new screenshots in one comment; the description keeps its checklists as they are." />
          </div>
          <div className="flex items-center gap-2">
            {mode === 'description' ? (
              <Button variant="primary" disabled={busy} onClick={() => void run(() => actions.descPropose(t, 'visual'), null)}>
                Prepare the changes
              </Button>
            ) : (
              <Button variant="primary" disabled={busy} onClick={() => void run(() => actions.visualPost(t), 'Posted to the PR.')}>
                Post comment
              </Button>
            )}
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </>
      )}

      {p?.status === 'preparing' && <p className="text-muted">Reading the PR description, the visual check and the commits… you also get it in Telegram.</p>}
      {p?.status === 'failed' && (
        <div className="flex items-center gap-2">
          <span className="text-bad">Could not prepare the changes: {p.error}</span>
          <Button variant="ghost" onClick={() => void run(() => actions.descDiscard(t), null)}>
            Dismiss
          </Button>
        </div>
      )}

      {p?.status === 'ready' && (
        <>
          <p className="text-muted">{p.changes.length ? `${p.changes.length} change${p.changes.length === 1 ? '' : 's'} to the description. Untick any you do not want.` : 'Nothing in the description needs to change.'}</p>
          <ul className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {p.changes.map((c) => (
                <motion.li key={c.id} layout className={`flex gap-2.5 rounded-md border border-line bg-panel px-2.5 py-2 ${keep.has(c.id) ? '' : 'opacity-50'}`}>
                  <input type="checkbox" className="mt-0.5 accent-[var(--color-accent)]" checked={keep.has(c.id)} onChange={() => toggle(c.id)} aria-label={`keep change ${c.id}`} />
                  <div className="flex min-w-0 flex-col gap-0.5 font-mono text-[11.5px]">
                    <span className="break-words text-bad/90 line-through decoration-bad/40">{c.from.trim()}</span>
                    <span className="break-words text-ok">{c.to.trim()}</span>
                    {c.why && <span className="font-sans text-[11px] text-dim">{c.why}</span>}
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
          <label className="flex flex-col gap-1">
            <span className="text-muted">Line in the description's Updates log (date and commit are added)</span>
            <input value={logLine} onChange={(e) => setLogLine(e.target.value)} className="rounded-md border border-line-2 bg-panel px-2 py-1.5 text-fg outline-none focus:border-accent" />
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={withComment} onChange={(e) => setWithComment(e.target.checked)} className="accent-[var(--color-accent)]" />
            <span>Also post a short comment so reviewers get notified</span>
          </label>
          {withComment && <textarea value={comment} onChange={(e) => setComment(e.target.value)} rows={2} className="rounded-md border border-line-2 bg-panel px-2 py-1.5 text-fg outline-none focus:border-accent" />}
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={busy || (keep.size === 0 && !logLine.trim())} onClick={() => void run(async () => {
              const r = await actions.descApply(t, { accept: [...keep], comment: withComment ? comment : null, log: logLine })
              setNote(`Description updated · ${r.applied} line(s)${r.skipped ? `, ${r.skipped} skipped because someone edited them meanwhile` : ''}.`)
            }, null)}>
              Update the PR
            </Button>
            <Button disabled={busy} onClick={() => void run(async () => {
              await actions.visualPost(t)
              await actions.descDiscard(t)
            }, 'Posted as a comment instead.')}>
              Comment instead
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => void run(() => actions.descDiscard(t), null).then(onClose)}>
              Discard
            </Button>
          </div>
        </>
      )}
      {note && <p className="text-fg-2">{note}</p>}
    </motion.div>
  )
}

function Choice({ on, onClick, title, hint }: { on: boolean; onClick: () => void; title: string; hint: string }) {
  return (
    <button type="button" role="radio" aria-checked={on} onClick={onClick} className={`flex gap-2.5 rounded-md border px-2.5 py-2 text-left transition-colors ${on ? 'border-accent/60 bg-panel' : 'border-line hover:border-line-2'}`}>
      <span className={`mt-0.5 size-3.5 shrink-0 rounded-full border-2 ${on ? 'border-accent bg-accent/30' : 'border-line-2'}`} />
      <span className="flex flex-col gap-0.5">
        <span className="font-medium text-fg">{title}</span>
        <span className="text-[11px] leading-snug text-muted">{hint}</span>
      </span>
    </button>
  )
}
