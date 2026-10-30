import type { LiveLine } from '@ticketflow/shared'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { loadLive } from '../lib/api.js'

export function LiveLog({ id, lines, running, className = '' }: { id: string; lines: readonly LiveLine[]; running: boolean; className?: string }) {
  const [backfill, setBackfill] = useState<readonly LiveLine[]>([])
  const [follow, setFollow] = useState(true)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    loadLive(id).then(setBackfill, () => setBackfill([]))
  }, [id])

  const all = useMemo(() => {
    const seen = new Set(backfill.map((l) => l.at + l.text))
    return [...backfill, ...lines.filter((l) => !seen.has(l.at + l.text))]
  }, [backfill, lines])

  useEffect(() => {
    if (follow && box.current) box.current.scrollTo({ top: box.current.scrollHeight, behavior: 'smooth' })
  }, [all.length, follow])

  return (
    <div className={`flex min-h-0 flex-col gap-2 ${className}`}>
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-xs font-medium text-muted">
          Lane log
          {running && (
            <span className="flex items-center gap-1 text-[11px] text-accent-fg">
              <motion.span className="size-1.5 rounded-full bg-accent-fg" animate={{ opacity: [1, 0.2, 1] }} transition={{ duration: 1, repeat: Infinity }} />
              live
            </span>
          )}
        </h2>
        <label className="flex items-center gap-1.5 text-[11px] text-muted max-md:min-h-9">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="accent-accent" />
          follow
        </label>
      </div>
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24)
        }}
        className="min-h-[240px] flex-1 overflow-y-auto rounded-lg border border-line bg-sunk px-3 py-2.5 font-mono text-[11px] leading-[1.75] text-muted max-md:max-h-[60vh]"
      >
        {all.length === 0 && <div className="text-dim">Nothing yet. The log fills in while a lane runs.</div>}
        <AnimatePresence initial={false}>
          {all.map((l) => (
            <motion.div
              key={l.at + l.text}
              initial={{ opacity: 0, x: -8, backgroundColor: 'rgba(124,134,232,.16)' }}
              animate={{ opacity: 1, x: 0, backgroundColor: 'rgba(124,134,232,0)' }}
              transition={{ duration: 0.35, backgroundColor: { duration: 1.2 } }}
              className={`-mx-1 rounded px-1 ${l.kind === 'text' ? 'my-1 font-sans text-xs whitespace-pre-wrap text-fg-2' : l.kind === 'stage' ? 'mt-2 mb-0.5 font-medium text-accent-fg' : 'break-words'}`}
            >
              <span className="text-dim">{new Date(l.at).toLocaleTimeString([], { hour12: false })}</span> {l.kind === 'tool' ? <ToolLine text={l.text} /> : l.text}
            </motion.div>
          ))}
        </AnimatePresence>
        {running && (
          <motion.span className="mt-1 inline-block h-3 w-1.5 bg-accent-fg align-middle" animate={{ opacity: [1, 0, 1] }} transition={{ duration: 1, repeat: Infinity, ease: 'linear' }} aria-hidden="true" />
        )}
      </div>
    </div>
  )
}

function ToolLine({ text }: { text: string }) {
  const [tool = '', ...rest] = text.split(/\s{2,}/)
  const color = tool.startsWith('pw') ? 'text-accent-fg' : tool === 'Bash' ? 'text-warn' : 'text-fg-2'
  return (
    <>
      <span className={`inline-block min-w-14 pr-2 whitespace-nowrap ${color}`}>{tool}</span>
      {rest.join('  ')}
    </>
  )
}
