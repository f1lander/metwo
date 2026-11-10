import { motion } from 'motion/react'
import { type ReactNode, useEffect, useState } from 'react'
import type { controls } from '../lib/api.js'
import { rise } from './ui.js'

// Building blocks of the Settings tabs.
export type Patch = Parameters<typeof controls.saveSettings>[0]
export type Run = (key: string, fn: () => Promise<unknown>) => () => Promise<void>
export type Save = (p: Patch) => void
export type Reset = (k: string) => void

export function Panel({ title, hint, children, className = '', id }: { title: ReactNode; hint?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <motion.section id={id} variants={rise} className={`flex scroll-mt-4 flex-col rounded-lg border border-line bg-panel ${className}`}>
      <div className="flex flex-col gap-0.5 border-b border-line px-4 py-3">
        <h2 className="text-sm font-medium">{title}</h2>
        {hint && <p className="text-xs leading-relaxed text-muted">{hint}</p>}
      </div>
      <div className="flex flex-col divide-y divide-line">{children}</div>
    </motion.section>
  )
}

export function Row({ label, hint, changed, onReset, children }: { label: string; hint?: ReactNode; changed?: boolean; onReset?: () => void; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-0 flex-1 basis-64">
        <div className="flex items-center gap-2 text-xs font-medium text-fg">
          {label}
          {changed && onReset && (
            <button type="button" onClick={onReset} className="rounded bg-raised px-1.5 py-px text-[10px] font-normal text-muted hover:text-fg" title="back to the value in ticketflow.config.json">
              changed · reset
            </button>
          )}
        </div>
        {hint && <p className="mt-0.5 text-[11px] leading-relaxed text-dim">{hint}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)} className={`relative h-5 w-9 rounded-full transition-colors ${on ? 'bg-accent' : 'bg-line-2'}`}>
      <motion.span layout transition={{ type: 'spring', stiffness: 600, damping: 34 }} className={`absolute top-0.5 size-4 rounded-full bg-white shadow ${on ? 'right-0.5' : 'left-0.5'}`} />
    </button>
  )
}

// Saves on Enter or when it loses focus; empty = no value.
export function NumberField({ value, onSave, prefix, placeholder, min = 0, label }: { value: number | null; onSave: (v: number | null) => void; prefix?: string; placeholder?: string; min?: number; label: string }) {
  const [text, setText] = useState(value === null ? '' : String(value))
  useEffect(() => setText(value === null ? '' : String(value)), [value])
  const commit = () => {
    const n = text.trim() === '' ? null : Number(text)
    if (n !== null && (!Number.isFinite(n) || n < min)) return setText(value === null ? '' : String(value))
    if (n !== value) onSave(n)
  }
  return (
    <label className="flex items-center gap-1 rounded-md border border-line-2 bg-bg px-2 py-1 text-xs focus-within:border-accent">
      {prefix && <span className="text-dim">{prefix}</span>}
      <input aria-label={label} inputMode="decimal" value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} className="w-20 bg-transparent text-fg outline-none tabular-nums" />
    </label>
  )
}

export function TextField({ value, onSave, placeholder, label, width = 'w-56' }: { value: string; onSave: (v: string) => void; placeholder?: string; label: string; width?: string }) {
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <input
      aria-label={label}
      value={text}
      placeholder={placeholder}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text.trim() !== value && onSave(text.trim())}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      className={`${width} rounded-md border border-line-2 bg-bg px-2 py-1 font-mono text-[11px] text-fg outline-none focus:border-accent`}
    />
  )
}

export function Select({ value, options, onChange, label }: { value: string; options: readonly { value: string; label: string }[]; onChange: (v: string) => void; label: string }) {
  const known = options.some((o) => o.value === value)
  return (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="rounded-md border border-line-2 bg-bg px-2 py-1 text-xs text-fg outline-none focus:border-accent">
      {!known && <option value={value}>{value}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: readonly T[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="flex overflow-hidden rounded-md border border-line-2 text-xs" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o} type="button" role="radio" aria-checked={value === o} onClick={() => onChange(o)} className={`relative px-3 py-1 capitalize ${value === o ? 'text-fg' : 'text-muted hover:text-fg'}`}>
          {value === o && <motion.span layoutId={`seg-${label}`} className="absolute inset-0 bg-raised" transition={{ type: 'spring', stiffness: 500, damping: 36 }} />}
          <span className="relative">{o}</span>
        </button>
      ))}
    </div>
  )
}

export const has = (obj: object | undefined, key: string) => Boolean(obj && key in obj)
