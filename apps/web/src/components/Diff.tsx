import type { DiffFile, Ticket, TicketDiff } from '@ticketflow/shared'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useState } from 'react'
import { loadDiff } from '../lib/api.js'
import { Section } from './ui.js'

const STATUS_MARK: Record<DiffFile['status'], string> = { added: 'A', deleted: 'D', renamed: 'R', modified: 'M' }
const STATUS_COLOR: Record<DiffFile['status'], string> = { added: 'text-ok', deleted: 'text-bad', renamed: 'text-accent-fg', modified: 'text-warn' }

// The lane's work against the base, uncommitted included. Reloads when the commits change.
export function DiffPanel({ ticket: t }: { ticket: Ticket }) {
  const [diff, setDiff] = useState<TicketDiff | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const d = await loadDiff(t.id)
      setDiff(d)
      setError(null)
      // small diffs open fully; big ones start collapsed
      setOpen((prev) => (prev.size > 0 ? prev : new Set(d.files.length <= 3 ? d.files.map((f) => f.path) : [])))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [t.id])

  useEffect(() => {
    void refresh()
  }, [refresh, t.commits, t.status])

  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })

  const right = (
    <div className="flex items-center gap-3 text-xs">
      {diff && diff.files.length > 1 && (
        <button type="button" className="text-muted hover:text-fg" onClick={() => setOpen(open.size === diff.files.length ? new Set() : new Set(diff.files.map((f) => f.path)))}>
          {open.size === diff.files.length ? 'Collapse all' : 'Expand all'}
        </button>
      )}
      <button type="button" className="text-muted hover:text-fg disabled:opacity-50" disabled={loading} onClick={() => void refresh()}>
        {loading ? 'Loading…' : 'Refresh'}
      </button>
    </div>
  )

  return (
    <Section title={diff ? `Changes · ${diff.files.length} file${diff.files.length === 1 ? '' : 's'}` : 'Changes'} right={right}>
      {error && <div className="rounded-lg border border-line bg-panel px-3 py-2.5 text-xs text-muted">{error}</div>}
      {diff && diff.files.length === 0 && <div className="rounded-lg border border-line bg-panel px-3 py-2.5 text-xs text-muted">No changes against the base yet.</div>}
      {diff && diff.files.length > 0 && (
        <div className="overflow-hidden rounded-lg border border-line bg-sunk">
          <div className="flex items-center gap-3 border-b border-line px-3 py-2 text-xs text-muted">
            <span className="text-ok">+{diff.added}</span>
            <span className="text-bad">−{diff.removed}</span>
            <span className="font-mono text-[11px]">vs {diff.base}</span>
            {diff.uncommitted && <span className="ml-auto text-warn">includes uncommitted changes</span>}
          </div>
          {diff.files.map((f) => (
            <FileDiff key={f.path} file={f} open={open.has(f.path)} onToggle={() => toggle(f.path)} />
          ))}
        </div>
      )}
    </Section>
  )
}

function FileDiff({ file: f, open, onToggle }: { file: DiffFile; open: boolean; onToggle: () => void }) {
  const total = f.added + f.removed
  const bar = total === 0 ? 0 : Math.max(1, Math.round((f.added / total) * 5))
  return (
    <div className="border-b border-line last:border-b-0">
      <button type="button" onClick={onToggle} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-xs hover:bg-panel" aria-expanded={open}>
        <motion.span animate={{ rotate: open ? 90 : 0 }} className="text-dim">
          ›
        </motion.span>
        <span className={`w-3 font-mono text-[11px] font-semibold ${STATUS_COLOR[f.status]}`}>{STATUS_MARK[f.status]}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-2" title={f.path}>
          {f.oldPath ? <span className="text-muted">{f.oldPath} → </span> : null}
          {f.path}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-ok">+{f.added}</span>
        <span className="shrink-0 font-mono text-[11px] text-bad">−{f.removed}</span>
        <span className="flex shrink-0 gap-px max-md:hidden" aria-hidden="true">
          {Array.from({ length: 5 }, (_, i) => (
            <span key={i} className={`size-1.5 rounded-[1px] ${total === 0 ? 'bg-line-2' : i < bar ? 'bg-ok-dot' : 'bg-bad'}`} />
          ))}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden">
            {f.binary ? (
              <div className="px-3 pb-2.5 text-xs text-muted">Binary file</div>
            ) : (
              <pre className="max-h-[480px] overflow-auto border-t border-line font-mono text-[11px] leading-[1.6]">
                {f.patch.split('\n').map((line, i) => (
                  <Line key={i} line={line} />
                ))}
                {f.truncated && <div className="px-3 py-1.5 text-muted">… truncated, open the worktree for the rest</div>}
              </pre>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function Line({ line }: { line: string }) {
  const tone = line.startsWith('@@')
    ? 'bg-[#1a1c2a] text-accent-fg'
    : line.startsWith('+')
      ? 'bg-[#13221a] text-[#a6e3c0]'
      : line.startsWith('-')
        ? 'bg-[#26161a] text-[#f2b8b8]'
        : line.startsWith('\\')
          ? 'text-dim'
          : 'text-muted'
  return <div className={`min-w-max px-3 whitespace-pre ${tone}`}>{line || ' '}</div>
}
