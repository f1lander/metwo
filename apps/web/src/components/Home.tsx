import type { Effort, Health, PrReview, Ticket } from '@ticketflow/shared'
import { motion } from 'motion/react'
import { type ReactNode, useMemo, useState } from 'react'
import { controls } from '../lib/api.js'
import { type Advice, advise, type Bucket, buckets, current, facts, type Grain, type Mix, mix, money } from '../lib/metrics.js'
import { href } from '../lib/route.js'
import { needsMe, STATUS_LABEL, statusTone } from './status.js'
import { Button, Pill, rise, stagger } from './ui.js'

// Fixed per engine, never by rank (dataviz palette, dark slots).
const ENGINE_COLOR: Record<string, string> = { claude: '#3987e5', codex: '#199e70', cursor: '#d95926', hermes: '#c98500' }
const GRAINS: readonly Grain[] = ['day', 'week', 'month']
const PERIOD_NAME: Record<Grain, [string, string]> = { day: ['Today', 'yesterday'], week: ['This week', 'last week'], month: ['This month', 'last month'] }

const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(Math.round(n)))
const hours = (h: number | null) => (h === null ? '—' : h < 1 ? `${Math.round(h * 60)}m` : h < 48 ? `${h.toFixed(1)}h` : `${Math.round(h / 24)}d`)
const minutes = (m: number) => (m < 60 ? `${Math.round(m)}m` : `${(m / 60).toFixed(1)}h`)

function readGrain(): Grain {
  try {
    const g = localStorage.getItem('metwo.home.grain')
    return g === 'day' || g === 'month' ? g : 'week'
  } catch {
    return 'week'
  }
}

export function Home({ tickets, health, reviews }: { tickets: readonly Ticket[]; health: Health | null; reviews: readonly PrReview[] }) {
  const [grain, setGrainState] = useState<Grain>(readGrain)
  const setGrain = (g: Grain) => {
    setGrainState(g)
    try {
      localStorage.setItem('metwo.home.grain', g)
    } catch {}
  }

  const all = useMemo(() => tickets.map(facts), [tickets])
  const { now, prev } = useMemo(() => current(all, grain), [all, grain])
  const series = useMemo(() => buckets(all, grain), [all, grain])
  const from = series[0]?.start.getTime() ?? 0
  const engines = useMemo(() => mix(all, (f) => f.engine, from), [all, from])
  const lanes = useMemo(() => mix(all, (f) => (f.lane ? `${f.lane}${f.effort && f.lane !== 'max' ? ` · ${f.effort}` : ''}` : null), from), [all, from])
  const effort = health?.lanes.effort
  const advice = useMemo(() => advise(all, effort, Date.now() - 30 * 86_400_000), [all, effort])
  const waiting = tickets.filter(needsMe)
  const toReview = reviews.filter((r) => r.status === 'new' || r.status === 'reviewed' || (r.status === 'posted' && r.stale))
  const inFlight = tickets.filter((t) => t.status === 'running' || t.status === 'queued')
  const [name, vs] = PERIOD_NAME[grain]
  const sample = all.filter((f) => f.prAt !== null && f.prAt >= Date.now() - 30 * 86_400_000).length

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <motion.div variants={stagger} initial="hidden" animate="show" className="mx-auto flex w-full max-w-[1180px] flex-col gap-4 px-6 py-6 max-md:px-4 max-md:pb-24">
        <motion.div variants={rise} className="flex flex-wrap items-end gap-3">
          <div>
            <h1 className="text-lg font-semibold">{name}</h1>
            <p className="text-xs text-muted">So far, compared with the same point {vs}.</p>
          </div>
          <Segmented value={grain} onChange={setGrain} />
        </motion.div>

        <div className="grid grid-cols-4 gap-3 max-xl:grid-cols-2 max-sm:grid-cols-1">
          <Tile className="col-span-2 row-span-2 max-sm:col-span-1">
            <Label>Shipped</Label>
            <div className="flex items-baseline gap-3">
              <span className="text-5xl font-semibold tracking-tight tabular-nums">{now.shipped}</span>
              <Delta now={now.shipped} prev={prev.shipped} />
            </div>
            <p className="text-xs text-muted">tickets merged or moved on in Linear · {now.prs} PRs opened</p>
            <Bars data={series} value={(b) => b.shipped} format={(v) => `${v} shipped`} className="mt-auto" />
          </Tile>

          <Kpi label="PRs opened" value={String(now.prs)} delta={<Delta now={now.prs} prev={prev.prs} />} spark={series.map((b) => b.prs)} />
          <Kpi label="Spend" value={money(now.cost)} delta={<Delta now={now.cost} prev={prev.cost} money />} hint={now.shipped ? `${money(now.cost / now.shipped)} per shipped ticket` : 'API-priced, as the CLIs report it'} spark={series.map((b) => b.cost)} />
          <Kpi label="Time to PR" value={hours(now.medianHoursToPr)} hint="median, assigned → draft PR" />
          <Kpi
            label="Clean first time"
            value={now.firstPass.of ? `${Math.round((now.firstPass.clean / now.firstPass.of) * 100)}%` : '—'}
            hint={now.firstPass.of ? `${now.firstPass.clean} of ${now.firstPass.of} PRs: Greptile 4+, no supervisor fail, at most one follow-up` : 'no reviewed PRs yet'}
          />

          <Tile className="col-span-2 max-sm:col-span-1">
            <Label>Spend by {grain}</Label>
            <Bars data={series} value={(b) => b.cost} format={money} height={96} />
          </Tile>
          <Kpi label="Agent time" value={minutes(now.minutes)} hint={`${now.turns} lane turns${now.tokens ? ` · ${compact(now.tokens)} tokens` : ''}`} />
          <Kpi
            label="Follow-ups"
            value={now.followUps === null ? '—' : now.followUps.toFixed(1)}
            hint={`rounds per PR (your notes, comments, Greptile fixes)${now.visual.of ? ` · visual verified ${now.visual.verified}/${now.visual.of}` : ''}`}
          />

          <Tile>
            <Label>Engines</Label>
            <MixList rows={engines} color={(k) => ENGINE_COLOR[k] ?? '#8a8f98'} />
          </Tile>
          <Tile>
            <Label>Lanes and effort</Label>
            <MixList rows={lanes} />
          </Tile>

          <Tile className="col-span-2 max-sm:col-span-1">
            <Label>Waiting for you · {waiting.length + toReview.length}</Label>
            {toReview.length > 0 && (
              <ul className="flex flex-col">
                {toReview.slice(0, 3).map((r) => (
                  <li key={r.id}>
                    <a href={href.review(r.id)} className="-mx-2 flex items-center gap-3 rounded-md px-2 py-1.5 text-xs hover:bg-raised">
                      <span className="font-mono text-muted">#{r.number}</span>
                      <span className="min-w-0 flex-1 truncate">{r.title}</span>
                      <Pill tone="warn">{r.status === 'reviewed' ? 'Findings ready' : r.stale ? 'New commits' : 'Review requested'}</Pill>
                    </a>
                  </li>
                ))}
              </ul>
            )}
            {waiting.length === 0 && toReview.length === 0 ? (
              <p className="text-xs text-dim">{inFlight.length ? `Nothing. ${inFlight.length} in flight.` : 'Nothing.'}</p>
            ) : waiting.length === 0 ? null : (
              <ul className="flex flex-col">
                {waiting.slice(0, 5).map((t) => (
                  <li key={t.id}>
                    <a href={href.ticket(t.id)} className="-mx-2 flex items-center gap-3 rounded-md px-2 py-1.5 text-xs hover:bg-raised">
                      <span className="font-mono text-muted">{t.id}</span>
                      <span className="min-w-0 flex-1 truncate">{t.title}</span>
                      <Pill tone={statusTone(t.status)}>{STATUS_LABEL[t.status]}</Pill>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </Tile>

          <Tile className="col-span-4 max-xl:col-span-2 max-sm:col-span-1">
            <Label>Ways to spend less</Label>
            <Advices advice={advice} sample={sample} />
          </Tile>
        </div>

        <p className="text-[11px] text-dim">
          Your metwo only. Spend is what each CLI reports (Claude prices its turns at API rates even on a plan; Codex and Cursor report none, so they show up in time and tokens).
        </p>
      </motion.div>
    </div>
  )
}

function Tile({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <motion.section variants={rise} className={`flex min-h-[132px] flex-col gap-2 rounded-xl border border-line bg-panel p-4 ${className}`}>
      {children}
    </motion.section>
  )
}

const Label = ({ children }: { children: ReactNode }) => <h2 className="text-xs font-medium text-muted">{children}</h2>

function Kpi({ label, value, delta, hint, spark }: { label: string; value: string; delta?: ReactNode; hint?: string; spark?: readonly number[] }) {
  return (
    <Tile>
      <Label>{label}</Label>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-semibold tracking-tight tabular-nums">{value}</span>
        {delta}
      </div>
      {hint && <p className="text-[11px] leading-snug text-dim">{hint}</p>}
      {spark && <Spark values={spark} />}
    </Tile>
  )
}

// Neutral on purpose: more spend or more PRs is not good or bad by itself.
function Delta({ now, prev, money: isMoney = false }: { now: number; prev: number; money?: boolean }) {
  if (now === prev) return <span className="text-xs text-dim">same</span>
  const diff = now - prev
  const text = isMoney ? money(Math.abs(diff)) : String(Math.abs(Math.round(diff)))
  return (
    <span className="text-xs text-muted tabular-nums">
      {diff > 0 ? '↑' : '↓'} {text}
    </span>
  )
}

function Segmented({ value, onChange }: { value: Grain; onChange: (g: Grain) => void }) {
  return (
    <div className="ml-auto flex overflow-hidden rounded-md border border-line-2 text-xs" role="radiogroup" aria-label="period">
      {GRAINS.map((g) => (
        <button key={g} type="button" role="radio" aria-checked={value === g} onClick={() => onChange(g)} className={`relative px-3 py-1 capitalize max-md:min-h-9 ${value === g ? 'text-fg' : 'text-muted hover:text-fg'}`}>
          {value === g && <motion.span layoutId="grain-pill" className="absolute inset-0 bg-raised" transition={{ type: 'spring', stiffness: 500, damping: 36 }} />}
          <span className="relative">{g}</span>
        </button>
      ))}
    </div>
  )
}

// One series of bars with a hover tooltip; the current period is the last bar.
function Bars({ data, value, format, height = 150, className = '' }: { data: readonly Bucket[]; value: (b: Bucket) => number; format: (v: number) => string; height?: number; className?: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const values = data.map(value)
  const max = Math.max(...values, 0)
  const scale = max > 0 ? max : 1
  const n = data.length
  const active = hover === null ? null : data[hover]
  return (
    <div className={`relative w-full pt-4 ${className}`}>
      <div className="relative" style={{ height }} onMouseLeave={() => setHover(null)}>
        <div className="pointer-events-none absolute inset-x-0 top-0 border-t border-dashed border-line" />
        <span className="pointer-events-none absolute -top-4 right-0 text-[10px] text-dim tabular-nums">{format(max)}</span>
        <div className="absolute inset-0 flex items-end gap-[2px] border-b border-line-2">
          {data.map((b, i) => {
            const v = values[i] ?? 0
            return (
              <div key={b.start.toISOString()} className="relative flex h-full flex-1 items-end" onMouseEnter={() => setHover(i)}>
                <motion.div
                  initial={{ height: 0 }}
                  animate={{ height: v > 0 ? `max(3px, ${(v / scale) * 100}%)` : 0 }}
                  transition={{ duration: 0.5, delay: i * 0.02, ease: [0.22, 1, 0.36, 1] }}
                  className={`mx-auto w-full max-w-7 rounded-t-[4px] bg-accent-fg transition-opacity ${hover !== null && hover !== i ? 'opacity-45' : ''}`}
                />
              </div>
            )
          })}
        </div>
        {active && hover !== null && (
          <div
            className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-md border border-line-2 bg-raised px-2 py-1 text-[11px] whitespace-nowrap shadow-lg"
            style={{ left: `${((hover + 0.5) / n) * 100}%`, bottom: `calc(${((values[hover] ?? 0) / scale) * 100}% + 6px)` }}
          >
            <div className="text-muted">{active.label}</div>
            <div className="text-fg tabular-nums">{format(values[hover] ?? 0)}</div>
          </div>
        )}
      </div>
      <div className="mt-1.5 flex gap-[2px] text-[10px] text-dim">
        {data.map((b, i) => (
          <span key={b.start.toISOString()} className={`flex-1 text-center whitespace-nowrap tabular-nums ${(n - 1 - i) % Math.ceil(n / 7) === 0 ? '' : 'invisible'}`}>
            {b.label}
          </span>
        ))}
      </div>
    </div>
  )
}

function Spark({ values }: { values: readonly number[] }) {
  const max = Math.max(...values, 0)
  if (max === 0) return null
  const w = 100
  const h = 24
  const pts = values.map((v, i) => `${(i / Math.max(values.length - 1, 1)) * w},${h - 2 - (v / max) * (h - 4)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="mt-auto h-6 w-full" aria-hidden="true">
      <polyline points={pts} fill="none" stroke="var(--color-accent-fg)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

function MixList({ rows, color }: { rows: readonly Mix[]; color?: (key: string) => string }) {
  if (!rows.length) return <p className="text-xs text-dim">No lane turns in this range.</p>
  const max = Math.max(...rows.map((r) => r.tickets))
  return (
    <ul className="flex flex-col gap-2">
      {rows.slice(0, 5).map((r) => (
        <li key={r.key} className="flex flex-col gap-1 text-xs">
          <div className="flex items-baseline gap-2">
            <span className="capitalize">{r.key}</span>
            <span className="ml-auto text-muted tabular-nums">
              {r.tickets} · {r.cost ? money(r.cost) : minutes(r.minutes)}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-sunk">
            <motion.div initial={{ width: 0 }} animate={{ width: `${(r.tickets / max) * 100}%` }} transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }} className="h-full rounded-full" style={{ background: color?.(r.key) ?? 'var(--color-accent-fg)' }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

function Advices({ advice, sample }: { advice: readonly Advice[]; sample: number }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  if (sample < 5)
    return <p className="text-xs text-dim">Not enough to go on yet: {sample} PR{sample === 1 ? '' : 's'} in the last 30 days. Suggestions show up after 5, each with the tickets behind it.</p>
  if (!advice.length) return <p className="text-xs text-dim">Nothing to change. Lanes and effort fit the work over the last 30 days.</p>
  const setEffort = (a: Advice, e: Effort) => async () => {
    setBusy(a.id)
    try {
      await controls.effort(e)
      setDone(a.id)
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="grid grid-cols-2 gap-3 max-md:grid-cols-1">
      {advice.map((a) => (
        <div key={a.id} className="flex flex-col gap-1.5 rounded-lg border border-line bg-sunk p-3">
          <div className="flex items-center gap-2">
            <Pill tone={a.tone === 'save' ? 'ok' : a.tone === 'quality' ? 'warn' : 'neutral'}>{a.tone === 'save' ? 'save' : a.tone === 'quality' ? 'quality' : 'note'}</Pill>
            <span className="text-xs font-medium">{a.title}</span>
          </div>
          <p className="text-xs leading-relaxed text-fg-2">{a.detail}</p>
          {(a.tickets.length > 0 || a.effort) && (
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              {a.tickets.slice(0, 6).map((id) => (
                <a key={id} href={href.ticket(id)} className="font-mono text-muted hover:text-fg">
                  {id}
                </a>
              ))}
              {a.tickets.length > 6 && <span className="text-dim">+{a.tickets.length - 6}</span>}
              {a.effort && (
                <Button className="ml-auto" disabled={busy !== null || done === a.id} onClick={() => void setEffort(a, a.effort as Effort)()}>
                  {done === a.id ? `Effort set to ${a.effort}` : `Set effort to ${a.effort}`}
                </Button>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
