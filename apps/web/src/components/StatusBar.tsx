import type { Health } from '@ticketflow/shared'
import { useState } from 'react'
import { href } from '../lib/route.js'
import { PhoneMirror } from './PhoneMirror.js'
import { Count, Dot } from './ui.js'

const money = (n: number) => `$${n < 100 ? n.toFixed(2) : Math.round(n)}`

// The connection checks, lanes, autopilot and spend, along the bottom of the window (desktop widths).
export function StatusBar({ health, connected, night = false }: { health: Health | null; connected: boolean; night?: boolean }) {
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
  const [mirror, setMirror] = useState<string | null>(null)
  const phones = health?.android?.devices ?? []
  const ready = phones.filter((d) => d.state === 'device')
  const waiting = phones.find((d) => d.state === 'unauthorized')
  const shown = ready.find((d) => d.serial === mirror)
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
      {ready.map((d) => (
        <button key={d.serial} type="button" className={item} title={`${d.model}${d.android ? ` · Android ${d.android}` : ''}${d.chrome ? ` · Chrome ${d.chrome}` : ''} · click to see its screen`} aria-pressed={mirror === d.serial} onClick={() => setMirror((m) => (m === d.serial ? null : d.serial))}>
          <Dot ok />
          📱 {d.model} · {d.transport}
        </button>
      ))}
      {!ready.length && waiting && (
        <span className={`${item} text-warn`} title="unlock the phone and accept the USB debugging prompt">
          <Dot ok={false} />
          📱 {waiting.model}: allow USB debugging
        </span>
      )}
      {shown && (
        <div className="fixed right-3 bottom-9 z-40 flex flex-col gap-2 rounded-xl border border-line bg-panel p-3 shadow-2xl" style={{ width: `min(280px, calc((100vh - 150px) * ${shown.width && shown.height ? (shown.width / shown.height).toFixed(3) : 0.46}))` }}>
          <div className="flex items-center gap-2 text-xs">
            <span className="text-fg">{shown.model}</span>
            <span className="text-dim">{shown.transport}</span>
            <button type="button" className="ml-auto text-muted hover:text-fg" aria-label="close the phone screen" onClick={() => setMirror(null)}>
              ✕
            </button>
          </div>
          <PhoneMirror serial={shown.serial} model={shown.model} width={shown.width} height={shown.height} />
        </div>
      )}
      {night && (
        <a href={href.today} className={`${item} text-accent-fg`} title="Night Shift is on: mevo reads Slack for you and drafts replies">
          🌙 night shift
        </a>
      )}
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
