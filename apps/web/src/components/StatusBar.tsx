import type { Health } from '@ticketflow/shared'
import { href } from '../lib/route.js'
import { Count, Dot } from './ui.js'

const money = (n: number) => `$${n < 100 ? n.toFixed(2) : Math.round(n)}`

// The connection checks, lanes, autopilot and spend, along the bottom of the window (desktop widths).
export function StatusBar({ health, connected }: { health: Health | null; connected: boolean }) {
  const checks: readonly [string, boolean | null | undefined, string][] = [
    ['daemon', connected, connected ? 'live' : 'offline'],
    ['bot', health?.telegram.ok, health?.telegram.bot ?? 'telegram'],
    ['linear', health?.linear.ok, health?.linear.lastPollAt ? `linear ${new Date(health.linear.lastPollAt).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' })}` : 'linear'],
    ['gh', health?.github.ok, 'gh'],
    ['claude', health?.claude.ok, 'claude'],
    ['e2e', health?.e2e.ok, 'e2e'],
    ...(health?.tunnel.ok !== null && health?.tunnel ? [['tunnel', health.tunnel.ok, 'tunnel'] as [string, boolean | null, string]] : []),
  ]
  const lanes = health?.lanes
  const b = lanes?.budget
  const limited = b && (b.day.limit || b.month.limit)
  const tone = b?.level === 'over' ? 'text-bad' : b?.level === 'tight' || b?.level === 'saver' ? 'text-warn' : 'text-muted'
  const item = 'flex h-full items-center gap-1.5 px-2 hover:bg-raised hover:text-fg'
  return (
    <footer className="relative z-10 flex h-7 shrink-0 items-stretch border-t border-line bg-bg text-[11px] text-muted max-md:hidden" aria-label="status">
      <a href={href.settings('status')} className={`${item} pl-3`} title="checks">
        {checks.map(([key, ok, label]) => (
          <span key={key} className="flex items-center gap-1.5 pr-2">
            <Dot ok={ok} pulse={key === 'daemon' || ok === false} />
            {label}
          </span>
        ))}
      </a>
      <span className="ml-auto" />
      {lanes && (
        <a href={href.settings('general')} className={item} title="lanes">
          <Dot ok={!lanes.paused} pulse={lanes.active.length > 0} />
          <span className="inline-flex items-baseline">
            <Count value={lanes.active.length} />/{lanes.max}
          </span>
          lanes · {lanes.effort ?? 'medium'}
          {lanes.paused ? ' · paused' : ''}
        </a>
      )}
      {lanes?.autopilot?.enabled && (
        <a href={href.settings('general')} className={item} title="autopilot">
          <span className="text-accent-fg">autopilot</span>
          {lanes.autopilot.today}/{lanes.autopilot.maxPerDay} today
        </a>
      )}
      {b && (
        <a href={href.settings('budget')} className={`${item} pr-3`} title="budget">
          <span className={tone}>{money(b.day.limit || !b.month.limit ? b.day.spent : b.month.spent)}</span>
          {limited ? <span>/ {money((b.day.limit ?? b.month.limit) as number)}{b.day.limit ? ' today' : ' this month'}</span> : <span>today</span>}
          {b.level !== 'normal' && b.regulate && <span className={tone}>· {b.level === 'over' ? `on ${b.fallback ?? 'Claude'}` : 'saving'}</span>}
        </a>
      )}
    </footer>
  )
}
