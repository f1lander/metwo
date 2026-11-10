import type { Ticket } from '@ticketflow/shared'
import { useState } from 'react'
import { actions } from '../lib/api.js'
import { failed, notice } from '../lib/notice.js'
import { Button, ConfirmButton, Mono, Section } from './ui.js'

// The PR conflicts with main: let the lane resolve it (like comments), or merge main yourself in
// the editor and finish here. The file list comes from a local dry-run merge; GitHub's own
// "conflicting" flag shows the section even before mevo has checked.
export function ConflictsCard({ ticket: t }: { ticket: Ticket }) {
  const [busy, setBusy] = useState(false)
  const m = t.manualMerge
  const gh = t.pr?.state === 'OPEN' && t.pr.mergeable === 'CONFLICTING'
  if (!m && !t.behindMain?.conflicts && !gh) return null
  const laneBusy = t.status === 'running' || t.status === 'queued'
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true)
    try {
      await fn()
      if (ok) notice({ id: t.id, title: ok, tone: 'ok' })
    } catch (err) {
      failed(err, t.id)
    } finally {
      setBusy(false)
    }
  }
  const files = m ? m.files : (t.behindMain?.files ?? [])
  const left = new Set(m?.left ?? files)
  return (
    <Section title="Conflicts with main">
      <div className="flex flex-col gap-3 rounded-lg border border-[#4a3d22] bg-[#1b1812] px-4 py-3 text-xs">
        <p className="text-fg-2">
          {m
            ? `You are merging main by hand. ${m.left.length ? `${m.left.length} of ${m.files.length} file(s) still have conflict markers.` : 'Every file is resolved: finish to commit the merge and push.'}`
            : `${t.behindMain?.commits ? `${t.behindMain.commits} commit(s) on main ` : 'Main '}conflict${t.behindMain?.commits === 1 ? 's' : ''} with this branch${files.length ? ` in ${files.length} file(s)` : ''}. GitHub can't merge it until they are resolved.`}
        </p>
        {files.length > 0 && (
          <ul className="flex flex-col gap-1">
            {files.map((f) => (
              <li key={f} className="flex min-w-0 items-center gap-2">
                <span className={left.has(f) ? 'text-warn' : 'text-ok'} aria-label={left.has(f) ? 'conflicted' : 'resolved'}>
                  {left.has(f) ? '●' : '✓'}
                </span>
                <Mono className="truncate text-fg-2">{f}</Mono>
              </li>
            ))}
          </ul>
        )}
        {!files.length && !m && <p className="text-dim">Checking which files conflict…</p>}
        <div className="flex flex-wrap items-center gap-2">
          {m ? (
            <>
              <Button variant={m.left.length ? 'default' : 'primary'} disabled={busy || m.left.length > 0} title={m.left.length ? 'resolve every file first' : 'commits the merge and pushes it to the PR'} onClick={() => void run(() => actions.mergeFinish(t), 'Merge committed and pushed')}>
                Finish merge & push
              </Button>
              <Button disabled={busy} title="looks for conflict markers again" onClick={() => void run(() => actions.mergeCheck(t))}>
                Check again
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => void run(() => actions.openEditor(t))}>
                Open editor
              </Button>
              <ConfirmButton label="Abort merge" confirm="Undo the merge" disabled={busy} onConfirm={() => void run(() => actions.mergeAbort(t), 'Merge aborted')} />
            </>
          ) : (
            <>
              <Button variant="primary" disabled={busy || laneBusy} title="merges main; the lane resolves the conflicts, re-runs the gates and comes back for your review" onClick={() => void run(() => actions.updateMain(t), 'The lane is resolving the conflicts')}>
                Let the lane resolve them
              </Button>
              <Button disabled={busy || laneBusy} title="merges main into the worktree with the conflict markers and opens your editor" onClick={() => void run(async () => {
                const r = await actions.mergeStart(t)
                notice({ id: t.id, title: `${r.files.length} file(s) to resolve`, detail: r.editor ? `Opened in ${r.editor}` : 'Open the worktree in your editor', tone: 'accent' })
              })}>
                Resolve in my editor
              </Button>
            </>
          )}
        </div>
      </div>
    </Section>
  )
}
