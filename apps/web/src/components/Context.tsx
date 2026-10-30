import type { LinearIssueView, PrView, Ticket } from '@ticketflow/shared'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useState } from 'react'
import { loadIssue, loadPrView } from '../lib/api.js'
import { desktop } from '../lib/tauri.js'
import { Markdown } from './Markdown.js'
import { prState } from './status.js'
import { Pill, timeAgo } from './ui.js'

export type Tab = 'work' | 'visual' | 'issue' | 'pr'

export function Tabs({ tab, onChange, hasPr }: { tab: Tab; onChange: (t: Tab) => void; hasPr: boolean }) {
  const items: readonly [Tab, string][] = [
    ['work', 'Work'],
    ['visual', 'Visual check'],
    ['issue', 'Linear issue'],
    ['pr', hasPr ? 'Pull request' : 'PR draft'],
  ]
  return (
    <div className="flex shrink-0 gap-1 border-b border-line text-xs" role="tablist">
      {items.map(([key, label]) => (
        <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => onChange(key)} className={`relative px-2.5 pt-1 pb-2 max-md:min-h-10 ${tab === key ? 'text-fg' : 'text-muted hover:text-fg'}`}>
          {label}
          {tab === key && <motion.span layoutId="ticket-tab" className="absolute inset-x-1 -bottom-px h-[2px] rounded-full bg-accent-fg" transition={{ type: 'spring', stiffness: 500, damping: 36 }} />}
        </button>
      ))}
    </div>
  )
}

function useRemote<T>(load: () => Promise<T>, deps: readonly unknown[]) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: callers pass the inputs that matter
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setData(await load())
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, deps)
  useEffect(() => {
    void refresh()
  }, [refresh])
  return { data, error, loading, refresh }
}

function Bar({ children, loading, refresh, open, openLabel }: { children?: React.ReactNode; loading: boolean; refresh: () => void; open?: string | null; openLabel: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
      {children}
      <span className="ml-auto flex items-center gap-3">
        <button type="button" className="hover:text-fg disabled:opacity-50" disabled={loading} onClick={refresh}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        {open && (
          <button type="button" className="text-accent-fg hover:underline" onClick={() => void desktop.open(open)}>
            {openLabel}
          </button>
        )}
      </span>
    </div>
  )
}

const fade = { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.2 } }

export function IssueTab({ ticket: t }: { ticket: Ticket }) {
  const { data, error, loading, refresh } = useRemote<LinearIssueView>(() => loadIssue(t.id), [t.id])
  const [showBots, setShowBots] = useState(false)
  const comments = data?.comments.filter((c) => showBots || !c.bot) ?? []
  const hidden = (data?.comments.length ?? 0) - comments.length
  return (
    <motion.div {...fade} className="flex flex-col gap-4">
      <Bar loading={loading} refresh={() => void refresh()} open={data?.url ?? t.url} openLabel="Open in Linear">
        {data && (
          <>
            <Pill>{data.state}</Pill>
            {data.priority && data.priority !== 'No priority' && <Pill>{data.priority}</Pill>}
            <span>
              by {data.creator} · updated {timeAgo(data.updatedAt)} ago
            </span>
          </>
        )}
      </Bar>
      {error && <div className="rounded-lg border border-line bg-panel px-3 py-2.5 text-xs text-muted">{error}</div>}
      {!data && !error && <Skeleton />}
      {data && (
        <>
          <div className="rounded-lg border border-line bg-panel px-4 py-3.5">
            {data.description.trim() ? <Markdown source={data.description} ticketId={t.id} /> : <span className="text-xs text-muted">No description in Linear.</span>}
          </div>
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-medium text-muted">Comments · {comments.length}</h2>
            {(hidden > 0 || showBots) && (
              <button type="button" className="text-xs text-muted hover:text-fg" onClick={() => setShowBots((v) => !v)}>
                {showBots ? 'Hide bot and agent comments' : `Show ${hidden} bot and agent comment${hidden === 1 ? '' : 's'}`}
              </button>
            )}
          </div>
          <AnimatePresence initial={false}>
            {comments.map((c) => (
              <motion.div key={`${c.createdAt}-${c.author}`} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="rounded-lg border border-line bg-bg px-4 py-3">
                <div className="mb-1.5 text-[11px] text-muted">
                  <strong className="font-medium text-fg-2">{c.author}</strong> · {timeAgo(c.createdAt)} ago
                </div>
                <Markdown source={c.body} ticketId={t.id} />
              </motion.div>
            ))}
          </AnimatePresence>
          {comments.length === 0 && <div className="text-xs text-dim">No comments.</div>}
        </>
      )}
    </motion.div>
  )
}

export function PrTab({ ticket: t }: { ticket: Ticket }) {
  const { data, error, loading, refresh } = useRemote<PrView>(() => loadPrView(t.id), [t.id, t.prUrl, t.status])
  return (
    <motion.div {...fade} className="flex flex-col gap-4">
      <Bar loading={loading} refresh={() => void refresh()} open={data?.url ?? t.prUrl ?? null} openLabel="Open on GitHub">
        {data?.source === 'draft' && <span>Not pushed yet: this is what the draft PR will say.</span>}
        {data?.source === 'github' && t.pr && (
          <>
            <Pill>{prState(t)}</Pill>
            <span>#{t.pr.number}</span>
          </>
        )}
      </Bar>
      {error && <div className="rounded-lg border border-line bg-panel px-3 py-2.5 text-xs text-muted">{error}</div>}
      {!data && !error && <Skeleton />}
      {data && (
        <div className="rounded-lg border border-line bg-panel px-4 py-3.5">
          {data.body.trim() ? <Markdown source={data.body} ticketId={t.id} /> : <span className="text-xs text-muted">The PR has no description.</span>}
        </div>
      )}
      {data?.source === 'draft' && data.media.length > 0 && (
        <div className="text-xs text-muted">
          {data.media.length} file{data.media.length === 1 ? '' : 's'} will be attached when you push: {data.media.map((m) => m.name).join(', ')}
        </div>
      )}
    </motion.div>
  )
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-panel px-4 py-4">
      {[92, 80, 86, 40].map((w, i) => (
        <motion.div key={w} className="h-2.5 rounded bg-raised" style={{ width: `${w}%` }} animate={{ opacity: [0.4, 0.8, 0.4] }} transition={{ duration: 1.4, repeat: Infinity, delay: i * 0.1 }} />
      ))}
    </div>
  )
}
