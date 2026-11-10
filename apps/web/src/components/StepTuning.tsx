import { CONTEXT_INFO, type ContextBlock, type Effort, type PromptPreview, STEP_CONTEXT, type SettingsView, type StepId, type Ticket } from '@ticketflow/shared'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { loadPrompt } from '../lib/api.js'
import { failed } from '../lib/notice.js'
import type { Reset, Save } from './settings-ui.js'
import { Button, Mono } from './ui.js'

const NAME: Record<StepId, string> = { implement: 'implement', review: 'review pass', supervisor: 'supervisor', visual: 'visual check', quick: 'quick fix' }

// Effort, context and extra instructions for one AI step, and what its prompt looks like for a ticket.
export function StepTuning({ step, view, save, reset, tickets }: { step: StepId; view: SettingsView; save: Save; reset: Reset; tickets: readonly Ticket[] }) {
  const v = view.effective.steps[step]
  const o = view.overrides.steps?.[step]
  const [open, setOpen] = useState(false)
  const blocks = STEP_CONTEXT[step]
  const offs = blocks.filter((b) => v.context[b] === false).length
  const changed = Boolean(o && Object.keys(o).length)
  const summary = [v.effort && !(step === 'quick' && v.effort === 'low') ? `${v.effort} effort` : null, offs ? `${offs} of ${blocks.length} context off` : blocks.length ? 'all context' : null, v.instructions.trim() ? 'instructions' : null].filter(Boolean).join(' · ')
  const setStep = (p: { effort?: Effort | null; instructions?: string; context?: { [K in ContextBlock]?: boolean } }) => save({ steps: { [step]: p } })

  return (
    <div className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setOpen((x) => !x)} aria-expanded={open} className="flex items-center gap-1.5 text-xs font-medium text-fg hover:text-accent-fg">
          <motion.span animate={{ rotate: open ? 90 : 0 }} className="text-dim" aria-hidden="true">
            ›
          </motion.span>
          Effort, context and instructions · {NAME[step]}
        </button>
        <span className="text-[11px] text-dim">{summary || 'as configured'}</span>
        {changed && (
          <button type="button" onClick={() => reset(`steps.${step}`)} className="rounded bg-raised px-1.5 py-px text-[10px] text-muted hover:text-fg" title="back to the config file">
            changed · reset
          </button>
        )}
        <span className="flex-1" />
        <PreviewButton step={step} tickets={tickets} />
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div className="flex flex-col gap-3 pt-3">
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <span className="w-20 text-muted">Effort</span>
                {(['default', 'low', 'medium', 'high'] as const).map((e) => {
                  const cur = (v.effort ?? 'default') === e
                  return (
                    <button key={e} type="button" onClick={() => setStep({ effort: e === 'default' ? null : e })} aria-pressed={cur} className={`rounded-md border px-2 py-0.5 ${cur ? 'border-accent bg-raised text-fg' : 'border-line-2 text-muted hover:text-fg'}`}>
                      {e === 'default' ? `global (${view.effective.pipeline.effort})` : e}
                    </button>
                  )
                })}
                {step === 'implement' && <span className="text-dim">Max stays a per-ticket choice; the budget can lower it.</span>}
              </div>
              {blocks.length > 0 && (
                <div className="flex flex-wrap items-start gap-2 text-[11px]">
                  <span className="w-20 pt-0.5 text-muted">Context</span>
                  <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                    {blocks.map((b) => {
                      const on = v.context[b] !== false
                      return (
                        <button key={b} type="button" title={CONTEXT_INFO[b].what} onClick={() => setStep({ context: { [b]: !on } })} aria-pressed={on} className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 ${on ? 'border-line-2 text-fg-2' : 'border-dashed border-line-2 text-dim line-through'}`}>
                          <span aria-hidden="true" className={`size-1.5 rounded-full ${on ? 'bg-ok' : 'bg-line-2'}`} />
                          {CONTEXT_INFO[b].label}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
              <div className="flex flex-wrap items-start gap-2 text-[11px]">
                <span className="w-20 pt-1 text-muted">Instructions</span>
                <Instructions value={v.instructions} onSave={(t) => setStep({ instructions: t })} placeholder={`Added to the ${NAME[step]} prompt, e.g. "Check every new string has an i18n key."`} />
              </div>
              <p className="text-[11px] leading-relaxed text-dim">
                The task, its output files and the safety rules can't be turned off. Use Preview to see the prompt with these settings for a real ticket.
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function Instructions({ value, onSave, placeholder }: { value: string; onSave: (v: string) => void; placeholder: string }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <textarea
      aria-label="instructions"
      value={text}
      placeholder={placeholder}
      rows={Math.min(8, Math.max(2, text.split('\n').length))}
      maxLength={4000}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text.trim() !== value.trim() && onSave(text.trim())}
      className="min-w-0 flex-1 basis-64 rounded-md border border-line-2 bg-bg px-2 py-1.5 text-[11px] leading-relaxed text-fg outline-none focus:border-accent"
    />
  )
}

function PreviewButton({ step, tickets }: { step: StepId; tickets: readonly Ticket[] }) {
  const options = useMemo(() => [...tickets].filter((t) => t.status !== 'done' && !t.archived).sort((a, b) => Number(Boolean(b.worktree)) - Number(Boolean(a.worktree)) || b.updatedAt.localeCompare(a.updatedAt)), [tickets])
  const [id, setId] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<PromptPreview | null>(null)
  const pick = id || options[0]?.id || ''
  const show = async () => {
    if (!pick) return
    setBusy(true)
    try {
      setPreview(await loadPrompt(pick, step))
    } catch (err) {
      failed(err)
    } finally {
      setBusy(false)
    }
  }
  if (!options.length) return <span className="text-[11px] text-dim">Preview needs a ticket on the board</span>
  return (
    <span className="flex items-center gap-1.5">
      <select aria-label="ticket to preview" value={pick} onChange={(e) => setId(e.target.value)} className="max-w-40 rounded-md border border-line-2 bg-bg px-1.5 py-1 text-[11px] text-fg outline-none focus:border-accent">
        {options.map((t) => (
          <option key={t.id} value={t.id}>
            {t.id} · {t.title.slice(0, 40)}
          </option>
        ))}
      </select>
      <Button disabled={busy} onClick={() => void show()}>
        {busy ? 'Building…' : 'Preview'}
      </Button>
      {createPortal(<AnimatePresence>{preview && <PromptSheet preview={preview} onClose={() => setPreview(null)} />}</AnimatePresence>, document.body)}
    </span>
  )
}

const tokens = (chars: number) => (chars < 400 ? `${chars} chars` : `~${Math.round(chars / 4 / 100) / 10}k tokens`)

function PromptSheet({ preview: p, onClose }: { preview: PromptPreview; onClose: () => void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  const total = p.text.length
  // Slack and Figma are fetched when the lane starts; the notes say when the ticket links any
  const later = (b?: string) => (b === 'slack' || b === 'figma') && p.notes.some((n) => n.includes(b === 'slack' ? 'Slack' : 'Figma'))
  const max = Math.max(1, ...p.blocks.map((b) => b.chars))
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/50 p-4 max-sm:p-0" onClick={onClose}>
      <motion.div
        role="dialog"
        aria-label={`${NAME[p.step]} prompt for ${p.ticket}`}
        initial={{ y: 16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: 16, opacity: 0 }}
        onClick={(e) => e.stopPropagation()}
        className="flex w-full max-w-5xl flex-col overflow-hidden rounded-lg border border-line bg-panel max-sm:rounded-none"
      >
        <div className="flex items-start gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium">
              {NAME[p.step][0]?.toUpperCase()}
              {NAME[p.step].slice(1)} prompt · {p.ticket}
            </h2>
            <p className="text-[11px] text-muted">
              <Mono>{p.engine}</Mono> · {p.effort} effort · {tokens(total)} · built now, nothing ran
            </p>
          </div>
          <Button onClick={onClose}>Close</Button>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,15rem)_minmax(0,1fr)] max-md:grid-cols-1 max-md:grid-rows-[auto_minmax(0,1fr)]">
          <div className="flex flex-col gap-3 overflow-y-auto border-r border-line px-4 py-3 max-md:max-h-56 max-md:border-r-0 max-md:border-b">
            <ul className="flex flex-col gap-1.5">
              {p.blocks.map((b) => (
                <li key={b.id} className="flex flex-col gap-0.5 text-[11px]">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className={b.context && !b.on ? 'text-dim line-through' : b.chars ? 'text-fg-2' : 'text-dim'}>{b.title}</span>
                    <span className="shrink-0 tabular-nums text-dim">{b.context && !b.on ? 'off' : b.chars ? tokens(b.chars) : later(b.context) ? 'at start' : 'none'}</span>
                  </span>
                  <span className="h-1 rounded-full bg-sunk">
                    <span className={`block h-full rounded-full ${b.context ? 'bg-accent-fg' : 'bg-line-2'}`} style={{ width: `${b.on ? (b.chars / max) * 100 : 0}%` }} />
                  </span>
                </li>
              ))}
            </ul>
            {p.notes.length > 0 && (
              <ul className="flex flex-col gap-1 text-[11px] leading-relaxed text-muted">
                {p.notes.map((n) => (
                  <li key={n}>· {n}</li>
                ))}
              </ul>
            )}
          </div>
          <pre className="min-h-0 overflow-auto px-4 py-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-fg-2">{p.text}</pre>
        </div>
      </motion.div>
    </motion.div>
  )
}
