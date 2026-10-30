import type { Triage } from '@ticketflow/shared'
import { AnimatePresence, type HTMLMotionProps, motion } from 'motion/react'
import { type ReactNode, useEffect, useState } from 'react'
import { useLabelColor } from '../lib/labels.js'

type Variant = 'primary' | 'default' | 'ghost' | 'danger'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent border-accent text-white hover:brightness-110 shadow-[0_0_0_0_rgba(124,92,255,0)] hover:shadow-[0_0_24px_-6px_rgba(124,92,255,.7)]',
  default: 'bg-raised border-line-2 text-fg hover:border-muted',
  ghost: 'bg-transparent border-transparent text-muted hover:text-fg',
  danger: 'bg-transparent border-[#4a2a2f] text-bad hover:bg-[#2a1a1d]',
}

export function Button({ variant = 'default', className = '', children, ...props }: HTMLMotionProps<'button'> & { variant?: Variant }) {
  return (
    <motion.button
      type="button"
      {...(props.disabled ? {} : { whileTap: { scale: 0.96 }, whileHover: { y: -1 } })}
      transition={{ type: 'spring', stiffness: 600, damping: 30 }}
      {...props}
      className={`inline-flex items-center justify-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-[background,border-color,color,box-shadow] disabled:cursor-default disabled:opacity-50 max-md:min-h-10 max-md:px-3.5 max-md:text-[13px] ${VARIANTS[variant]} ${className}`}
    >
      {children}
    </motion.button>
  )
}

// Two steps for anything that kills work: the first click arms it, the second does it.
export function ConfirmButton({
  label,
  confirm,
  onConfirm,
  disabled = false,
  className = '',
  variant = 'ghost',
}: {
  label: ReactNode
  confirm: string
  onConfirm: () => void
  disabled?: boolean
  className?: string
  variant?: Variant
}) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 6000)
    return () => clearTimeout(t)
  }, [armed])
  if (!armed) {
    return (
      <Button variant={variant} className={className} disabled={disabled} onClick={(e) => (e.preventDefault(), e.stopPropagation(), setArmed(true))}>
        {label}
      </Button>
    )
  }
  return (
    <span className={`inline-flex gap-1.5 ${className}`}>
      <Button
        variant="danger"
        disabled={disabled}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setArmed(false)
          onConfirm()
        }}
      >
        {confirm}
      </Button>
      <Button variant="ghost" onClick={(e) => (e.preventDefault(), e.stopPropagation(), setArmed(false))}>
        Cancel
      </Button>
    </span>
  )
}

type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'accent'

const TONES: Record<Tone, string> = {
  neutral: 'bg-raised border-line-2 text-muted',
  ok: 'bg-[#16281f] border-[#27463a] text-ok',
  warn: 'bg-[#2b2612] border-[#4a4020] text-warn',
  bad: 'bg-[#2a1a1d] border-[#4a2a2f] text-bad',
  accent: 'bg-[#1f1836] border-[#3b2f6b] text-accent-fg',
}

// Crossfades when its text changes, so a status flip reads as an event.
export function Pill({ tone = 'neutral', children, className = '' }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <motion.span layout="position" className={`inline-flex items-center overflow-hidden rounded-full border px-2 py-px text-[11px] whitespace-nowrap transition-colors duration-300 ${TONES[tone]} ${className}`}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span key={String(children)} initial={{ y: 8, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -8, opacity: 0 }} transition={{ duration: 0.22 }}>
          {children}
        </motion.span>
      </AnimatePresence>
    </motion.span>
  )
}

export function Dot({ ok, pulse = false }: { ok: boolean | null | undefined; pulse?: boolean }) {
  const color = ok === true ? 'bg-ok-dot' : ok === false ? 'bg-bad' : 'bg-dim'
  return (
    <span className="relative inline-flex size-[7px] shrink-0" aria-hidden="true">
      {pulse && ok !== null && ok !== undefined && (
        <motion.span
          className={`absolute inset-0 rounded-full ${color}`}
          animate={{ scale: [1, 2.6], opacity: [ok ? 0.45 : 0.7, 0] }}
          transition={{ duration: ok ? 2.4 : 1.2, repeat: Infinity, ease: 'easeOut' }}
        />
      )}
      <span className={`relative inline-block size-[7px] rounded-full transition-colors duration-500 ${color}`} />
    </span>
  )
}

// A number that slides when it changes (column counts, lane counts).
export function Count({ value, className = '' }: { value: number; className?: string }) {
  return (
    <span className={`relative inline-flex overflow-hidden tabular-nums ${className}`}>
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span key={value} initial={{ y: -10, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 10, opacity: 0 }} transition={{ type: 'spring', stiffness: 500, damping: 28 }}>
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}

// Determinate fill (stage-based) with a moving sheen while work is happening.
export function Progress({ value, active, warn = false }: { value: number; active: boolean; warn?: boolean }) {
  return (
    <div className="relative h-[3px] overflow-hidden rounded bg-line" role="progressbar" aria-valuenow={Math.round(value * 100)} aria-valuemin={0} aria-valuemax={100}>
      <motion.div className={`absolute inset-y-0 left-0 rounded ${warn ? 'bg-warn' : 'bg-accent-fg'}`} initial={{ width: 0 }} animate={{ width: `${Math.max(4, value * 100)}%` }} transition={{ type: 'spring', stiffness: 80, damping: 20 }} />
      {active && (
        <motion.div
          className="absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-white/45 to-transparent"
          initial={{ left: '-35%' }}
          animate={{ left: '110%' }}
          transition={{ duration: 1.5, repeat: Infinity, ease: 'easeInOut', repeatDelay: 0.3 }}
        />
      )}
    </div>
  )
}

export function Section({ title, right, children, className = '' }: { title: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <motion.section variants={rise} className={`flex shrink-0 flex-col gap-2 ${className}`}>
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-medium text-muted">{title}</h2>
        {right}
      </div>
      {children}
    </motion.section>
  )
}

export function Mono({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-[11px] ${className}`}>{children}</span>
}

// Shared variants: parents stagger, children rise.
export const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.045, delayChildren: 0.04 } } }
export const rise = { hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 380, damping: 30 } } } as const

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—'
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

// A Linear label in Linear's own color.
export function Label({ name }: { name: string }) {
  const color = useLabelColor(name)
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-line-2 bg-raised px-2 py-px text-[11px] whitespace-nowrap text-fg-2"
      style={color ? { borderColor: `color-mix(in srgb, ${color} 45%, transparent)`, background: `color-mix(in srgb, ${color} 14%, transparent)` } : undefined}
    >
      <span className="size-1.5 shrink-0 rounded-full" style={{ background: color ?? 'var(--color-dim)' }} />
      {name}
    </span>
  )
}

export function LabelDot({ name }: { name: string }) {
  const color = useLabelColor(name)
  return <span className="size-1.5 shrink-0 rounded-full" style={{ background: color ?? 'var(--color-dim)' }} />
}

const KIND_LABEL = { ui: 'UI', logic: 'logic', copy: 'copy', bug: 'bug', infra: 'infra', other: 'other' } as const

// The AI's read of an issue: size and kind, green when autopilot can take it alone.
export function TriageChip({ triage: t }: { triage: Triage | undefined }) {
  if (!t) return null
  return (
    <span
      title={`${t.why}${t.risk !== 'low' ? ` · ${t.risk} risk` : ''}`}
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-px text-[11px] whitespace-nowrap ${t.easy ? 'border-[#27463a] bg-[#16281f] text-ok' : t.size === 'L' || t.risk === 'high' ? 'border-[#4a2a2f] bg-[#2a1a1d] text-bad' : 'border-line-2 bg-raised text-muted'}`}
    >
      <span className="font-semibold">{t.size}</span>
      {KIND_LABEL[t.kind]}
      {t.easy && <span aria-label="easy">· easy</span>}
    </span>
  )
}
