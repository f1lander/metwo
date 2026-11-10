import type { LinearSyncRow } from '@ticketflow/shared'
import { useState } from 'react'
import { linearSync } from '../lib/api.js'
import { failed, notice } from '../lib/notice.js'
import { href } from '../lib/route.js'
import { desktop } from '../lib/tauri.js'
import { Button } from './ui.js'

const PR = { merged: 'merged', open: 'open', draft: 'draft' } as const

// Linear vs GitHub, by hand: compares each ticket's Linear state with its PR and moves what's behind.
export function LinearSyncCard() {
  const [rows, setRows] = useState<LinearSyncRow[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const run = async (key: string, fn: () => Promise<{ rows: LinearSyncRow[] }>, done?: (r: LinearSyncRow[]) => void) => {
    setBusy(key)
    try {
      const { rows } = await fn()
      setRows(rows)
      done?.(rows)
    } catch (err) {
      failed(err)
    } finally {
      setBusy(null)
    }
  }
  const behind = rows?.filter((r) => r.want || !r.linked || r.error) ?? []
  const todo = (r: LinearSyncRow) => Boolean(r.want || !r.linked)
  const fixed = (before: number) => (r: LinearSyncRow[]) => {
    const errs = r.filter((x) => x.error).length
    const left = r.filter(todo).length
    notice({ title: errs ? `${errs} could not be synced in Linear` : `Synced ${before - left} in Linear`, tone: errs ? 'bad' : 'ok' })
  }
  return (
    <section className="flex flex-col gap-1.5 rounded-xl border border-line bg-panel px-3 py-3 text-xs">
      <div className="flex flex-wrap items-center gap-2 px-1">
        <span className="font-medium text-muted">Linear vs GitHub</span>
        <span className="text-dim">
          {rows === null ? 'checks each ticket’s Linear state and PR link against GitHub' : behind.length ? `${behind.length} out of sync` : `all ${rows.length} in sync`}
        </span>
        <span className="ml-auto flex items-center gap-2">
          {behind.some(todo) && (
            <Button variant="primary" disabled={busy !== null} onClick={() => void run('all', () => linearSync.fix(), fixed(behind.length))}>
              {busy === 'all' ? 'Syncing…' : `Sync ${behind.filter(todo).length}`}
            </Button>
          )}
          <Button disabled={busy !== null} onClick={() => void run('check', () => linearSync.check())}>
            {busy === 'check' ? 'Checking…' : rows ? 'Check again' : 'Check'}
          </Button>
        </span>
      </div>
      {behind.map((r) => (
        <div key={r.id} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md px-1 py-1 hover:bg-raised">
          <a href={href.ticket(r.id)} className="shrink-0 text-fg hover:underline">
            {r.id}
          </a>
          <span className="min-w-24 flex-1 truncate text-fg-2">{r.title}</span>
          <button type="button" className="shrink-0 text-accent-fg hover:underline" onClick={() => void desktop.open(r.url)}>
            #{r.number} {PR[r.pr]}
          </button>
          {r.want && (
            <span className="shrink-0 text-muted">
              {r.linear} → <span className="text-warn">{r.want}</span>
            </span>
          )}
          {!r.linked && <span className="shrink-0 text-warn">PR not on the ticket</span>}
          {r.error ? (
            <span className="w-full truncate text-bad">{r.error}</span>
          ) : (
            <button type="button" disabled={busy !== null} className="shrink-0 text-accent-fg hover:underline disabled:opacity-50" onClick={() => void run(r.id, () => linearSync.fix([r.id]), fixed(1))}>
              {busy === r.id ? 'Syncing…' : r.want ? 'Move' : 'Link'}
            </button>
          )}
        </div>
      ))}
    </section>
  )
}
