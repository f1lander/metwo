import { motion, useReducedMotion } from 'motion/react'
import { LOGO_LETTERS, LOGO_VIEWBOX } from './logo-paths.js'

// The wordmark in currentColor. `animate` plays the letter-by-letter entrance once;
// `busy` makes the letters breathe while lanes are running.
export function Logo({ className = '', animate = true, busy = false }: { className?: string; animate?: boolean; busy?: boolean }) {
  const reduce = useReducedMotion()
  return (
    <svg viewBox={LOGO_VIEWBOX} className={className} role="img" aria-label="metwo" fill="currentColor">
      {LOGO_LETTERS.map((l, i) => (
        <motion.g
          key={l.letter}
          initial={animate && !reduce ? { opacity: 0, y: 120 } : false}
          animate={busy && !reduce ? { opacity: [1, 0.55, 1], y: [0, -14, 0] } : { opacity: 1, y: 0 }}
          transition={
            busy && !reduce
              ? { duration: 1.6, repeat: Infinity, delay: i * 0.12, ease: 'easeInOut' }
              : { type: 'spring', stiffness: 260, damping: 22, delay: 0.08 + i * 0.07 }
          }
        >
          <path d={l.d} transform={`translate(${l.x},${l.y})`} />
        </motion.g>
      ))}
    </svg>
  )
}

