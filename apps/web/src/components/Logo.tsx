import { motion, useReducedMotion } from 'motion/react'
import { useEffect, useState } from 'react'
import { LOGO_LETTERS, LOGO_PUPIL, LOGO_VIEWBOX } from './logo-paths.js'

// The wordmark in currentColor, with the o as an eye. `animate` plays the letter-by-letter
// entrance once and then a wink; the eye winks again now and then and on hover. `busy` makes the
// letters breathe and the eye look around while lanes are running.
// `away`: Mo (the o) is out floating in the app, so the o here is only a faint outline.
export function Logo({ className = '', animate = true, busy = false, away = false, ringRef }: { className?: string; animate?: boolean; busy?: boolean; away?: boolean; ringRef?: (el: SVGPathElement | null) => void }) {
  const reduce = useReducedMotion()
  const [winks, setWinks] = useState(0)
  const wink = () => !reduce && setWinks((n) => n + 1)

  useEffect(() => {
    if (reduce) return
    let timer: ReturnType<typeof setTimeout>
    const next = (ms: number) => {
      timer = setTimeout(() => {
        setWinks((n) => n + 1)
        next(7000 + Math.random() * 6000)
      }, ms)
    }
    next(animate ? 1400 : 4000)
    return () => clearTimeout(timer)
  }, [reduce, animate])

  return (
    <svg viewBox={LOGO_VIEWBOX} className={className} role="img" aria-label="mevo" fill="currentColor" onMouseEnter={wink}>
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
          {/* static markup generated from the wordmark, no user input */}
          <g
            ref={l.letter === 'o' && ringRef ? (g) => ringRef(g?.querySelector('path') ?? null) : undefined}
            style={l.letter === 'o' ? { opacity: away ? 0.2 : 1, transition: 'opacity .3s' } : undefined}
            dangerouslySetInnerHTML={{ __html: l.svg }}
          />
          {l.letter === 'o' && (
            <motion.g
              style={{ opacity: away ? 0 : 1, transition: 'opacity .3s' }} animate={busy && !reduce ? { x: [0, -18, 0, 18, 0] } : { x: 0 }} transition={busy && !reduce ? { duration: 3.2, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.3 }}>
              <motion.circle
                key={winks}
                cx={LOGO_PUPIL.cx}
                cy={LOGO_PUPIL.cy}
                r={LOGO_PUPIL.r}
                fill="#fff"
                style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
                initial={false}
                animate={winks ? { scaleY: [1, 0.08, 0.08, 1], scaleX: [1, 1.25, 1.25, 1] } : { scaleY: 1 }}
                transition={{ duration: 0.42, times: [0, 0.35, 0.6, 1], ease: 'easeInOut' }}
              />
            </motion.g>
          )}
        </motion.g>
      ))}
    </svg>
  )
}
