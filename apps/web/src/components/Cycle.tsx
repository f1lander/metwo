import type { CycleIssue, CycleView } from '@ticketflow/shared'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useState } from 'react'
import { loadCycle, runAssist, triageNow } from '../lib/api.js'
import { useTriage, useTriageMap } from '../lib/triage.js'
import { desktop } from '../lib/tauri.js'
import { Button, Label, Pill, TriageChip } from './ui.js'

export const openCycle = () => window.dispatchEvent(new Event('metwo:cycle'))

const PRIORITY_TONE: Record<number, 'bad' | 'warn' | 'neutral'> = { 1: 'bad', 2: 'warn' }

// The current cycle's unassigned issues: take one, or tick several and take them together.
export function CycleSheet() {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<CycleView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      setView(await loadCycle())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  useEffect(() => {
    const show = () => setOpen(true)
    window.addEventListener('metwo:cycle', show)
    return () => window.removeEventListener('metwo:cycle', show)
  }, [])

  useEffect(() => {
    if (!open) return
    setPicked(new Set())
    setNote(null)
    void refresh()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, refresh])

  const take = async (ids: readonly string[]) => {
    setBusy(true)
    try {
      // through the assistant's take: assigns, and easy ones start on autopilot when it is on
      const { results } = await runAssist([{ type: 'take', ids: [...ids] }])
      const r = results[0]
      setNote(r ? (r.ok ? `${r.text}. They are on the board now.` : r.text) : '')
      const taken = r?.ok ? ids.filter((id) => r.text.includes(id)) : []
      setView((v) => (v ? { ...v, issues: v.issues.filter((i) => !taken.includes(i.id)) } : v))
      setPicked(new Set())
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const toggle = (id: string) =>
    setPicked((p) => {
      const next = new Set(p)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const triage = useTriageMap()
  const order = (i: CycleIssue) => (triage[i.id]?.easy ? 0 : triage[i.id] ? 1 : 2)
  const issues = [...(view?.issues ?? [])].sort((a, b) => order(a) - order(b))
  const easy = issues.filter((i) => triage[i.id]?.easy)
  const untriaged = issues.filter((i) => !triage[i.id]).length
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[10vh] backdrop-blur-[2px] max-md:items-end max-md:p-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={() => setOpen(false)}>
          <motion.div
            role="dialog"
            aria-label="Take issues from the current cycle"
            onMouseDown={(e) => e.stopPropagation()}
            className="flex max-h-[76vh] w-full max-w-[680px] flex-col overflow-hidden rounded-xl border border-line-2 bg-panel shadow-[0_24px_80px_rgba(0,0,0,.55)] max-md:max-h-[88vh] max-md:rounded-b-none"
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ type: 'spring', stiffness: 460, damping: 36 }}
          >
            <div className="flex items-center gap-3 border-b border-line px-4 py-3">
              <div>
                <div className="text-sm font-medium">{view?.cycle ? view.cycle.name : 'Current cycle'}</div>
                <div className="text-xs text-muted">{view?.cycle ? `${issues.length} unassigned · ends ${new Date(view.cycle.endsAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : view ? 'No active cycle for the team' : error ? 'Could not load the cycle' : 'Loading…'}</div>
              </div>
              {easy.length > 0 && (
                <button type="button" className="ml-auto rounded-full border border-[#27463a] bg-[#16281f] px-2.5 py-0.5 text-xs text-ok hover:brightness-125" onClick={() => setPicked(new Set(easy.map((i) => i.id)))}>
                  Pick the {easy.length} easy one{easy.length === 1 ? '' : 's'}
                </button>
              )}
              <button type="button" className={`${easy.length ? '' : 'ml-auto '}text-xs text-muted hover:text-fg`} onClick={() => void triageNow(untriaged === 0).then(() => setNote('Triaging with AI… sizes appear as they come in.'))}>
                {untriaged ? `Triage ${untriaged}` : 'Re-triage'}
              </button>
              <button type="button" className="text-xs text-muted hover:text-fg" onClick={() => void refresh()}>
                Refresh
              </button>
              <button type="button" aria-label="close" className="text-muted hover:text-fg" onClick={() => setOpen(false)}>
                ✕
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto py-1">
              {error && <div className="px-4 py-3 text-xs break-words text-bad">{(error.split(': {')[0] ?? error).slice(0, 300)}</div>}
              {view?.cycle && issues.length === 0 && <div className="px-4 py-8 text-center text-xs text-muted">Nothing unassigned left in this cycle.</div>}
              <AnimatePresence initial={false}>
                {issues.map((i) => (
                  <Row key={i.id} issue={i} picked={picked.has(i.id)} busy={busy} onToggle={() => toggle(i.id)} onTake={() => void take([i.id])} />
                ))}
              </AnimatePresence>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3 max-md:pb-[calc(env(safe-area-inset-bottom)+12px)]">
              {issues.length > 0 && (
                <button type="button" className="text-xs text-muted hover:text-fg" onClick={() => setPicked(picked.size === issues.length ? new Set() : new Set(issues.map((i) => i.id)))}>
                  {picked.size === issues.length ? 'Clear' : 'Select all'}
                </button>
              )}
              <AnimatePresence>
                {note && (
                  <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="min-w-0 flex-1 truncate text-xs text-fg-2" title={note}>
                    {note}
                  </motion.span>
                )}
              </AnimatePresence>
              <Button variant="primary" className="ml-auto" disabled={busy || picked.size === 0} onClick={() => void take([...picked])}>
                {busy ? 'Assigning…' : picked.size ? `Assign ${picked.size} to me` : 'Assign to me'}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function Row({ issue: i, picked, busy, onToggle, onTake }: { issue: CycleIssue; picked: boolean; busy: boolean; onToggle: () => void; onTake: () => void }) {
  const triage = useTriage(i.id)
  return (
    <motion.div layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, x: 40, height: 0, transition: { duration: 0.25 } }} className={`group flex items-start gap-3 px-4 py-2.5 ${picked ? 'bg-raised' : 'hover:bg-raised/60'}`}>
      <input type="checkbox" checked={picked} onChange={onToggle} aria-label={`select ${i.id}`} className="mt-1 size-3.5 shrink-0 accent-[var(--color-accent)]" />
      <button type="button" onClick={onToggle} className="min-w-0 flex-1 text-left">
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <span>{i.id}</span>
          {i.priority > 0 && <Pill tone={PRIORITY_TONE[i.priority] ?? 'neutral'}>{i.priorityLabel}</Pill>}
          <span>{i.state}</span>
          {i.estimate !== null && <span>· {i.estimate} pt</span>}
          {i.labels.slice(0, 3).map((l) => (
            <Label key={l} name={l} />
          ))}
          <TriageChip triage={triage} />
        </div>
        <div className="mt-0.5 text-[13px] leading-snug">{i.title}</div>
        {triage?.why && <div className="mt-0.5 text-[11px] leading-snug text-dim">{triage.why}</div>}
      </button>
      <div className="flex shrink-0 items-center gap-2 opacity-70 group-hover:opacity-100 max-md:opacity-100">
        <button type="button" className="text-xs text-muted hover:text-fg" onClick={() => void desktop.open(i.url)}>
          Open
        </button>
        <Button disabled={busy} onClick={onTake}>
          Take
        </Button>
      </div>
    </motion.div>
  )
}
