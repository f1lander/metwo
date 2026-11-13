import { type CheckGuide, prChecks, type Ticket } from '@ticketflow/shared'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { actions } from '../lib/api.js'
import { failed, notice } from '../lib/notice.js'
import { PostToPr } from './PrDescPanel.js'
import { Button, rise, Section } from './ui.js'

const label = (line: string) => line.replace(/^\s*[-*] \[[ xX]\]\s*/, '')

// The unticked checks in the PR description. An agent can work them without touching the code:
// it verifies what it can and writes steps for the rest. What you did yourself, you tick here.
export function ChecksCard({ ticket: t }: { ticket: Ticket }) {
  const [pick, setPick] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [showDone, setShowDone] = useState(false)
  if (!t.pr?.body || t.pr.state !== 'OPEN') return null
  const all = prChecks(t.pr.body)
  if (!all.length) return null
  const open = all.filter((c) => !c.done)
  const done = all.filter((c) => c.done)
  const p = t.descProposal?.trigger === 'checks' ? t.descProposal : null
  const guide = new Map<string, CheckGuide>((p?.guide ?? []).map((g) => [g.line, g]))
  const verified = new Map((p?.status === 'ready' ? p.changes : []).map((c) => [c.from, c]))
  const working = p?.status === 'preparing' || (t.status === 'running' && p !== null)
  const groups = [...new Set(open.map((c) => c.section))]

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      failed(err, t.id)
    } finally {
      setBusy(false)
    }
  }
  const toggle = (line: string) =>
    setPick((s) => {
      const next = new Set(s)
      if (next.has(line)) next.delete(line)
      else next.add(line)
      return next
    })

  return (
    <Section title={`PR checks · ${open.length ? `${open.length} of ${all.length} open` : 'all ticked'}`}>
      <motion.div variants={rise} className="flex flex-col gap-3 rounded-lg border border-line bg-panel px-4 py-3.5 text-xs">
        {open.length > 0 && (
          <p className="leading-relaxed text-muted">
            {working
              ? 'An agent is working the checks: running the commands, the app and the preview. Nothing changes in the code or on GitHub. Its log is on the right.'
              : p?.status === 'ready'
                ? `${verified.size} verified by the agent (review and apply below), ${guide.size} need you. Tick the ones you did and they are ticked on GitHub.`
                : 'Let an agent verify what it can without touching the code; it writes the steps for the ones that need you. Or tick the ones you already did.'}
          </p>
        )}
        {p?.status === 'failed' && <p className="text-bad">The last run failed: {p.error}</p>}

        {groups.map((section) => (
          <div key={section} className="flex flex-col gap-1.5">
            <div className="text-[11px] font-medium tracking-wide text-dim uppercase">{section || 'Description'}</div>
            <ul className="flex flex-col gap-1.5">
              {open
                .filter((c) => c.section === section)
                .map((c) => {
                  const g = guide.get(c.line)
                  const v = verified.get(c.line)
                  return (
                    <li key={c.line} className={`flex gap-2.5 rounded-md border px-2.5 py-2 ${v ? 'border-ok/30' : g ? 'border-warn/30' : 'border-line'}`}>
                      <input type="checkbox" className="mt-0.5 accent-[var(--color-accent)]" checked={pick.has(c.line)} onChange={() => toggle(c.line)} aria-label={`I did: ${c.text}`} disabled={busy || working} />
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <span className="text-fg-2">
                          {label(c.line)}
                          {c.human && <span className="ml-1.5 rounded bg-raised px-1 text-[10px] text-dim">yours</span>}
                        </span>
                        {v && <span className="text-ok">Verified by the agent: {v.why || label(v.to)}</span>}
                        {g && (
                          <div className="flex flex-col gap-1 text-fg-2">
                            <span className="text-warn">{g.why}</span>
                            {g.steps.length > 0 && (
                              <ol className="ml-4 list-decimal space-y-0.5 text-muted marker:text-dim">
                                {g.steps.map((s) => (
                                  <li key={s}>{s}</li>
                                ))}
                              </ol>
                            )}
                          </div>
                        )}
                      </div>
                    </li>
                  )
                })}
            </ul>
          </div>
        ))}

        {open.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            {pick.size > 0 ? (
              <Button
                variant="primary"
                disabled={busy || working}
                onClick={() =>
                  void run(async () => {
                    const r = await actions.tickChecks(t, [...pick])
                    setPick(new Set())
                    notice({ title: `Ticked ${r.ticked} on GitHub`, tone: 'ok' })
                  })
                }
              >
                I did these · tick {pick.size} on GitHub
              </Button>
            ) : (
              <Button variant={p ? 'default' : 'primary'} disabled={busy || working || t.status === 'running' || t.status === 'queued'} onClick={() => void run(() => actions.workChecks(t))}>
                {working ? 'Working the checks…' : p ? 'Work them again' : 'Work the checks'}
              </Button>
            )}
          </div>
        )}

        {done.length > 0 && (
          <button type="button" className="self-start text-[11px] text-dim hover:text-fg" onClick={() => setShowDone((x) => !x)}>
            {showDone ? 'Hide' : 'Show'} {done.length} ticked
          </button>
        )}
        <AnimatePresence initial={false}>
          {showDone && (
            <motion.ul initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="flex flex-col gap-1 overflow-hidden text-muted">
              {done.map((c) => (
                <li key={c.line}>✓ {label(c.line)}</li>
              ))}
            </motion.ul>
          )}
        </AnimatePresence>
      </motion.div>
      {p?.status === 'ready' && p.changes.length > 0 && t.prUrl && (
        <div className="mt-2">
          <PostToPr ticket={t} onClose={() => undefined} />
        </div>
      )}
    </Section>
  )
}
