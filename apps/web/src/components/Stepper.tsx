import { fmtMinutes, runStartedAt, type Ticket } from '@ticketflow/shared'
import { motion, useReducedMotion } from 'motion/react'
import { useNow } from '../lib/estimates.js'
import { currentStep, prState, STEPS } from './status.js'

interface StepNote {
  readonly text: string
  readonly tone?: 'ok' | 'bad' | 'warn' | 'muted'
}

// What each step came out with, so a finished step says more than "done".
function noteFor(t: Ticket, i: number, at: number, now: number): StepNote | null {
  const since = runStartedAt(t)
  const reviewed = (t.journal ?? []).some((j) => j.title.startsWith('Review pass') && (!since || j.at >= since))
  const sup = t.supervision
  if (i === at) {
    if (t.status === 'assigned') return { text: `suggested ${t.suggestedLane}`, tone: 'muted' }
    if (t.status === 'queued') return { text: 'waiting for a slot', tone: 'muted' }
    if (t.status === 'needs_input') return { text: 'asking you', tone: 'warn' }
    if (t.status === 'failed') return { text: t.failure?.title ?? 'failed', tone: 'bad' }
    if (t.status === 'stopped') return { text: t.stopped?.reason.startsWith('paused') ? 'paused by you' : 'stopped', tone: 'warn' }
    if (t.status === 'running' && t.stage) return { text: t.stage.name }
    if (t.status === 'review_ready') return { text: 'waiting on you', tone: 'warn' }
    if (t.status === 'no_change') return { text: 'no change needed', tone: 'warn' }
    if (t.status === 'pr_draft' && t.pr) return { text: `#${t.pr.number} ${prState(t)}` }
    return null
  }
  if (i > at) return null
  if (i === 1) {
    const first = t.events.find((e) => e.kind === 'start')
    const ready = [...t.events].reverse().find((e) => e.kind === 'ready' || e.kind === 'no-change')
    if (first && ready && ready.at > first.at) return { text: fmtMinutes((new Date(ready.at).getTime() - new Date(first.at).getTime()) / 60000), tone: 'muted' }
    return null
  }
  if (i === 2) return reviewed ? { text: '✓ done', tone: 'ok' } : null
  if (i === 3) {
    if (!sup) return null
    const ok = sup.gates.filter((g) => g.ok).length
    const gates = sup.gates.length ? `${ok}/${sup.gates.length} gates` : ''
    return { text: [gates, sup.verdict].filter(Boolean).join(' · '), tone: sup.verdict === 'pass' && ok === sup.gates.length ? 'ok' : sup.verdict === 'fail' ? 'bad' : 'warn' }
  }
  if (i === 4) return t.lastPushAt ? { text: 'pushed', tone: 'ok' } : null
  if (i === 5 && t.pr) return { text: `#${t.pr.number}`, tone: 'muted' }
  return null
}

const NOTE_TONE = { ok: 'text-ok', bad: 'text-bad', warn: 'text-warn', muted: 'text-dim' } as const

// The stages of a ticket, each with what it came out with. The current one pulses while
// a lane runs and turns amber when the ticket is waiting on you. On a phone: one line.
export function Stepper({ ticket: t }: { ticket: Ticket }) {
  const reduce = useReducedMotion()
  const now = useNow(running(t) ? 15_000 : 600_000)
  const at = currentStep(t)
  const stuck = t.status === 'failed' || t.status === 'needs_input' || t.status === 'stopped'
  const live = t.status === 'running'
  const n = STEPS.length
  const inset = 100 / n / 2
  const fill = at / (n - 1)
  const here = noteFor(t, at, at, now)

  return (
    <div aria-label={`step ${at + 1} of ${n}: ${STEPS[at]}`}>
      <div className="flex flex-col gap-1.5 sm:hidden">
        <div className="flex items-baseline justify-between text-xs">
          <span className={stuck ? 'font-medium text-warn' : 'font-medium text-fg'}>{STEPS[at]}</span>
          <span className="text-dim">
            step {at + 1} of {n}
          </span>
        </div>
        <div className="h-1 rounded-full bg-line">
          <motion.div className={`h-1 rounded-full ${stuck ? 'bg-warn' : 'bg-accent'}`} initial={{ width: 0 }} animate={{ width: `${((at + 1) / n) * 100}%` }} />
        </div>
        {here && <span className={`truncate text-[11px] ${here.tone ? NOTE_TONE[here.tone] : 'text-muted'}`}>{here.text}</span>}
      </div>

      <div className="relative pt-1 max-sm:hidden">
        <div className="absolute top-[9px] h-[2px] rounded bg-line" style={{ left: `${inset}%`, right: `${inset}%` }} />
        <motion.div
          className={`absolute top-[9px] h-[2px] rounded ${stuck ? 'bg-warn' : 'bg-accent'}`}
          style={{ left: `${inset}%` }}
          initial={{ width: 0 }}
          animate={{ width: `${fill * (100 - 2 * inset)}%` }}
          transition={{ type: 'spring', stiffness: 70, damping: 18 }}
        />
        <ol className="relative grid text-[11px]" style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
          {STEPS.map((label, i) => {
            const done = i < at
            const current = i === at
            const note = noteFor(t, i, at, now)
            const tone = current ? (stuck ? 'bg-warn border-warn' : 'bg-accent-fg border-accent-fg') : done ? 'bg-accent border-accent' : 'bg-bg border-line-2'
            return (
              <li key={label} className="flex min-w-0 flex-col items-center gap-1 px-0.5">
                <span className="relative flex size-3 items-center justify-center">
                  {current && (live || stuck) && !reduce && (
                    <motion.span
                      className={`absolute inset-0 rounded-full ${stuck ? 'bg-warn' : 'bg-accent-fg'}`}
                      animate={{ scale: [1, 2.6], opacity: [0.55, 0] }}
                      transition={{ duration: stuck ? 1.1 : 1.6, repeat: Infinity, ease: 'easeOut' }}
                    />
                  )}
                  <motion.span
                    className={`relative size-3 rounded-full border-2 transition-colors duration-500 ${tone}`}
                    initial={false}
                    animate={{ scale: current ? 1.15 : 1 }}
                    transition={{ type: 'spring', stiffness: 400, damping: 18, delay: done ? i * 0.05 : 0 }}
                  />
                </span>
                <span className={`max-w-full truncate text-center transition-colors duration-500 ${current ? (stuck ? 'font-medium text-warn' : 'font-medium text-fg') : done ? 'text-muted' : 'text-dim'}`}>{label}</span>
                {note && (
                  <span title={note.text} className={`max-w-full truncate text-center text-[10.5px] ${note.tone ? NOTE_TONE[note.tone] : current ? 'text-accent-fg' : 'text-muted'}`}>
                    {note.text}
                  </span>
                )}
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}

const running = (t: Ticket) => t.status === 'running' || t.status === 'queued'
