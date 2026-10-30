import type { Ticket } from '@ticketflow/shared'
import { AnimatePresence, motion } from 'motion/react'
import { href } from '../lib/route.js'

// The one console-style strip on the board: the latest events across all tickets.
export function Activity({ tickets }: { tickets: readonly Ticket[] }) {
  const rows = tickets
    .flatMap((t) => t.events.map((e) => ({ ...e, id: t.id })))
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 4)
  if (rows.length === 0) return null
  return (
    <footer className="overflow-hidden border-t border-line bg-sunk px-4 py-2.5 font-mono text-[11px] leading-[1.7] text-muted max-md:hidden">
      <AnimatePresence initial={false} mode="popLayout">
        {rows.map((r, i) => (
          <motion.div
            layout
            key={`${r.id}${r.at}${r.kind}`}
            initial={{ opacity: 0, y: -12, backgroundColor: 'rgba(124,134,232,.14)' }}
            animate={{ opacity: 1 - i * 0.16, y: 0, backgroundColor: 'rgba(124,134,232,0)' }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ type: 'spring', stiffness: 420, damping: 34, backgroundColor: { duration: 1.4 } }}
            className="-mx-1.5 flex gap-3 truncate rounded px-1.5"
          >
            <span className="text-dim">{new Date(r.at).toLocaleTimeString([], { hour12: false })}</span>
            <a href={href.ticket(r.id)} className="w-20 shrink-0 hover:text-fg">
              {r.id}
            </a>
            <span className="w-20 shrink-0">{r.kind}</span>
            <span className="truncate">{r.message}</span>
          </motion.div>
        ))}
      </AnimatePresence>
    </footer>
  )
}
