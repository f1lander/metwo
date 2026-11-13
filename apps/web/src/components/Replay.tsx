import type { PassMetrics, ReplayView, Ticket } from '@ticketflow/shared'
import { useEffect, useMemo, useState } from 'react'
import { actions, loadReplays } from '../lib/api.js'
import { failed, notice } from '../lib/notice.js'
import { href } from '../lib/route.js'
import { Button, ConfirmButton, Mono } from './ui.js'

// On a replay: what it is and where to compare it. On a ticket: run it again with today's
// settings and compare the first passes side by side.
export function ReplayCard({ ticket: t, replays }: { ticket: Ticket; replays: readonly Ticket[] }) {
  if (t.replay) return <ReplayBanner ticket={t} />
  return <ReplayCompare ticket={t} replays={replays} />
}

function ReplayBanner({ ticket: t }: { ticket: Ticket }) {
  const r = t.replay as NonNullable<Ticket['replay']>
  const [busy, setBusy] = useState(false)
  const remove = async () => {
    setBusy(true)
    try {
      await actions.deleteReplay(t.id)
      window.location.hash = href.ticket(r.of)
    } catch (err) {
      failed(err)
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-dashed border-accent-fg/40 bg-panel px-3.5 py-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-fg">Replay of {r.of}</span>
        <span className="text-muted">from {r.base.slice(0, 7)} · nothing is pushed, posted or moved in Linear</span>
        <span className="flex-1" />
        <a href={href.ticket(r.of)} className="text-accent-fg hover:underline">
          Compare on {r.of}
        </a>
        <ConfirmButton label="Delete replay" confirm="Delete it?" disabled={busy} onConfirm={() => void remove()} />
      </div>
      <p className="text-[11px] leading-relaxed text-dim">
        Runs with: {r.settings}
        {r.note ? ` · ${r.note}` : ''}
      </p>
    </div>
  )
}

type Row = { label: string; get: (m: PassMetrics, o: PassMetrics) => string; hint?: string }

const money = (n: number | null) => (n === null ? '—' : `$${n.toFixed(2)}`)
const mins = (n: number | null) => (n === null ? '—' : n < 1 ? '<1 min' : `${Math.round(n)} min`)
const num = (n: number | null) => (n === null ? '—' : String(n))
const delta = (a: number | null, b: number | null) => (a === null || b === null || b === 0 || a === b ? '' : ` (${a > b ? '+' : ''}${Math.round(((a - b) / b) * 100)}%)`)

const ROWS: readonly Row[] = [
  { label: 'Cost', get: (m, o) => `${money(m.cost)}${m.id === o.id ? '' : delta(m.cost, o.cost)}`, hint: 'What the CLIs reported for the first pass, review and supervisor included' },
  { label: 'New tokens', hint: 'Input and output, without cache reads (most of the cost is cache reads of the session)', get: (m, o) => `${m.tokens === null ? '—' : `${Math.round(m.tokens / 1000)}k`}${m.id === o.id ? '' : delta(m.tokens, o.tokens)}` },
  { label: 'Time', get: (m, o) => `${mins(m.minutes)}${m.id === o.id ? '' : delta(m.minutes, o.minutes)}`, hint: 'From the start to ready, waits included' },
  { label: 'Lane time', get: (m) => mins(m.laneMinutes) },
  { label: 'Turns', get: (m) => String(m.turns), hint: 'Model turns: lane, verdict, quick fixes' },
  { label: 'Supervisor rounds', get: (m) => String(m.rounds) },
  { label: 'Lines', get: (m) => (m.linesAdded === null ? '—' : `+${m.linesAdded} −${m.linesRemoved ?? 0}`) },
  { label: 'Files', get: (m) => num(m.files) },
  {
    label: 'Same files as the original',
    get: (m, o) => {
      if (m.id === o.id) return o.filesTouched ? `${o.filesTouched.length}` : '—'
      if (!m.filesTouched || !o.filesTouched) return '—'
      const same = m.filesTouched.filter((f) => o.filesTouched?.includes(f)).length
      return `${same} of ${o.filesTouched.length}${m.filesTouched.length > same ? `, ${m.filesTouched.length - same} other` : ''}`
    },
  },
  { label: 'Supervisor', get: (m) => m.supervisor ?? '—' },
  { label: 'Local checks', get: (m) => m.localChecks ?? '—' },
  { label: 'Visual', get: (m) => m.visual?.replace('_', ' ') ?? '—' },
  { label: 'Screenshots', get: (m) => num(m.shots) },
  { label: 'Videos', get: (m) => num(m.videos) },
]

function ReplayCompare({ ticket: t, replays }: { ticket: Ticket; replays: readonly Ticket[] }) {
  const [view, setView] = useState<ReplayView | null>(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)
  // reload when a replay moves on
  const key = useMemo(() => replays.map((r) => `${r.id}:${r.status}:${r.journal?.length ?? 0}`).join('|'), [replays])
  useEffect(() => {
    if (!open && !replays.length) return
    loadReplays(t.id).then(setView, () => setView(null))
  }, [t.id, key, open, replays.length])
  const start = async () => {
    setBusy(true)
    try {
      const { ticket } = await actions.replay(t.id)
      notice({ title: `${ticket.id} started`, detail: 'It runs like a lane and stops at review ready. Nothing is pushed.', tone: 'ok' })
      setView(await loadReplays(t.id))
    } catch (err) {
      failed(err)
    } finally {
      setBusy(false)
    }
  }
  const remove = async (id: string) => {
    try {
      await actions.deleteReplay(id)
      setView(await loadReplays(t.id))
    } catch (err) {
      failed(err)
    }
  }
  if (!open && !replays.length) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel px-3.5 py-2.5 text-xs">
        <span className="font-medium text-fg">Replay</span>
        <span className="min-w-0 flex-1 text-muted">Run this ticket again from where it started, with today's settings, and compare. Nothing is pushed or posted.</span>
        <Button onClick={() => setOpen(true)}>Set up</Button>
      </div>
    )
  }
  const cols = view ? [view.original, ...view.replays] : []
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-line bg-panel px-3.5 py-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-fg">Replays</span>
        <span className="min-w-0 flex-1 text-muted">The first pass of each run: from the start to ready, before any review comments.</span>
        <Button variant="primary" disabled={busy} onClick={() => void start()}>
          {busy ? 'Starting…' : 'Replay now'}
        </Button>
      </div>
      {view && (
        <p className="text-[11px] leading-relaxed text-dim">
          A new replay runs with today's settings: {view.settingsNow}. Change them in Settings → Pipeline before you start it.
        </p>
      )}
      {cols.length > 1 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] border-collapse text-[11px]">
            <thead>
              <tr className="text-left text-muted">
                <th className="py-1.5 pr-3 font-normal" />
                {cols.map((m, i) => (
                  <th key={m.id} className="py-1.5 pr-3 align-bottom font-medium text-fg">
                    {i === 0 ? (
                      <span>
                        Original <Mono className="text-dim">{m.id}</Mono>
                      </span>
                    ) : (
                      <span className="flex items-center gap-1.5">
                        <a href={href.ticket(m.id)} className="text-accent-fg hover:underline">
                          {m.id}
                        </a>
                        <button type="button" onClick={() => void remove(m.id)} title="delete this replay" className="text-dim hover:text-bad">
                          ✕
                        </button>
                      </span>
                    )}
                    <div className="font-normal text-dim">{m.complete ? m.status.replace('_', ' ') : i === 0 ? 'no first pass on record' : `${m.status.replace('_', ' ')}…`}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => (
                <tr key={row.label} className="border-t border-line">
                  <td className="py-1.5 pr-3 text-muted" title={row.hint}>
                    {row.label}
                  </td>
                  {cols.map((m) => (
                    <td key={m.id} className="py-1.5 pr-3 tabular-nums text-fg-2">
                      {row.get(m, view?.original as PassMetrics)}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="border-t border-line align-top">
                <td className="py-1.5 pr-3 text-muted">Settings</td>
                {cols.map((m, i) => (
                  <td key={m.id} className="max-w-56 py-1.5 pr-3 text-dim">
                    {i === 0 ? 'as they were then' : m.settings}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] leading-relaxed text-dim">Runs differ even with the same settings: compare two or three tickets before you decide.</p>
    </div>
  )
}
