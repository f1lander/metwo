import type { PrMeta } from '@ticketflow/shared'
import { motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { loadPrMeta } from '../lib/api.js'
import { Avatar, Mono, Person, Pill, timeAgo } from './ui.js'

const REVIEW = {
  APPROVED: { ring: 'ring-ok', label: 'approved' },
  CHANGES_REQUESTED: { ring: 'ring-bad', label: 'requested changes' },
  COMMENTED: { ring: 'ring-line-2', label: 'commented' },
  DISMISSED: { ring: 'ring-line', label: 'dismissed' },
  PENDING: { ring: 'ring-warn/60', label: 'review requested' },
} as const

// The top of a PR as GitHub shows it: who, where, how big, checks and reviewers.
export function PrMetaCard({ kind, id, version }: { kind: 'ticket' | 'review'; id: string; version?: string | undefined }) {
  const [meta, setMeta] = useState<PrMeta | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    loadPrMeta(kind, id).then(
      (m) => live && setMeta(m),
      (e: unknown) => live && setError(e instanceof Error ? e.message : String(e)),
    )
    return () => {
      live = false
    }
  }, [kind, id, version])
  if (error) return <p className="text-[11px] text-dim">Could not read the PR from GitHub: {error}</p>
  if (!meta) return <div className="h-[92px] animate-pulse rounded-lg border border-line bg-panel" />
  const c = meta.checks
  const total = c.passed + c.failed + c.pending
  const state = meta.state === 'MERGED' ? { label: 'Merged', tone: 'accent' as const } : meta.state === 'CLOSED' ? { label: 'Closed', tone: 'bad' as const } : meta.isDraft ? { label: 'Draft', tone: 'neutral' as const } : { label: 'Open', tone: 'ok' as const }
  return (
    <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col gap-3 rounded-lg border border-line bg-panel px-4 py-3 text-xs">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Pill tone={state.tone}>{state.label}</Pill>
        <Person login={meta.author} size={18} className="font-medium text-fg" />
        <span className="text-muted">
          wants to merge {meta.commits} commit{meta.commits === 1 ? '' : 's'} into <Mono className="text-fg-2">{meta.base}</Mono> from <Mono className="text-fg-2">{meta.head}</Mono>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-muted">
        <span>
          <span className="text-ok">+{meta.additions}</span> <span className="text-bad">−{meta.deletions}</span> · {meta.files} file{meta.files === 1 ? '' : 's'}
        </span>
        <span>opened {timeAgo(meta.createdAt)} ago</span>
        <span>{meta.mergedAt ? `merged ${timeAgo(meta.mergedAt)} ago` : `updated ${timeAgo(meta.updatedAt)} ago`}</span>
        {meta.mergeable === 'CONFLICTING' && <Pill tone="bad">conflicts with {meta.base}</Pill>}
        {total > 0 && (
          <span className="flex items-center gap-1.5" title={`${c.passed} passed, ${c.failed} failed, ${c.pending} running`}>
            <span className="flex h-1.5 w-20 overflow-hidden rounded-full bg-line">
              <span className="bg-ok" style={{ width: `${(c.passed / total) * 100}%` }} />
              <span className="bg-bad" style={{ width: `${(c.failed / total) * 100}%` }} />
              <span className="bg-warn" style={{ width: `${(c.pending / total) * 100}%` }} />
            </span>
            <span className={c.failed ? 'text-bad' : c.pending ? 'text-warn' : 'text-ok'}>{c.failed ? `${c.failed} failing` : c.pending ? `${c.pending} running` : 'checks passing'}</span>
          </span>
        )}
        {meta.milestone && <span>milestone {meta.milestone}</span>}
      </div>
      {(meta.reviewers.length > 0 || meta.assignees.length > 0 || meta.labels.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-line pt-2.5">
          {meta.reviewers.length > 0 && (
            <span className="flex items-center gap-2">
              <span className="text-dim">Reviewers</span>
              <span className="flex flex-wrap items-center gap-2">
                {meta.reviewers.map((r) => (
                  <span key={r.login} className="flex items-center gap-1" title={`${r.login} ${REVIEW[r.state].label}`}>
                    <Avatar login={r.login} size={16} className={`ring-[1.5px] ${REVIEW[r.state].ring}`} />
                    <span className={r.state === 'APPROVED' ? 'text-ok' : r.state === 'CHANGES_REQUESTED' ? 'text-bad' : 'text-fg-2'}>{r.login}</span>
                  </span>
                ))}
              </span>
            </span>
          )}
          {meta.assignees.length > 0 && (
            <span className="flex items-center gap-2">
              <span className="text-dim">Assignees</span>
              {meta.assignees.map((a) => (
                <Person key={a} login={a} className="text-fg-2" />
              ))}
            </span>
          )}
          {meta.labels.length > 0 && (
            <span className="flex flex-wrap items-center gap-1">
              {meta.labels.map((l) => (
                <Pill key={l}>{l}</Pill>
              ))}
            </span>
          )}
        </div>
      )}
    </motion.div>
  )
}
