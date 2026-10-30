import type { Ticket } from '@ticketflow/shared'
import { motion, useReducedMotion } from 'motion/react'
import { currentStep, STEPS } from './status.js'

// A track that fills to the current stage, with a node per stage. The active node pulses
// while a lane runs and turns amber when the ticket is waiting on you.
export function Stepper({ ticket: t }: { ticket: Ticket }) {
  const reduce = useReducedMotion()
  const at = currentStep(t)
  const stuck = t.status === 'failed' || t.status === 'needs_input'
  const running = t.status === 'running'
  const fill = at / (STEPS.length - 1)

  return (
    <div className="relative pt-1" aria-label={`stage: ${STEPS[at]}`}>
      <div className="absolute top-[9px] right-[8.3%] left-[8.3%] h-[2px] rounded bg-line" />
      <motion.div
        className={`absolute top-[9px] left-[8.3%] h-[2px] rounded ${stuck ? 'bg-warn' : 'bg-accent'}`}
        initial={{ width: 0 }}
        animate={{ width: `${fill * 83.4}%` }}
        transition={{ type: 'spring', stiffness: 70, damping: 18 }}
      />
      <ol className="relative grid grid-cols-6 text-[11px]">
        {STEPS.map((label, i) => {
          const done = i < at
          const current = i === at
          const tone = current ? (stuck ? 'bg-warn border-warn' : 'bg-accent-fg border-accent-fg') : done ? 'bg-accent border-accent' : 'bg-bg border-line-2'
          return (
            <li key={label} className="flex flex-col items-center gap-1.5">
              <span className="relative flex size-3 items-center justify-center">
                {current && (running || stuck) && !reduce && (
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
              <span className={`truncate text-center transition-colors duration-500 ${current ? '' : 'max-sm:invisible'} ${current ? (stuck ? 'font-medium text-warn' : 'font-medium text-fg') : done ? 'text-muted' : 'text-dim'}`}>{label}</span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
