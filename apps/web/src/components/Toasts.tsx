import type { Ticket, TicketStatus } from '@ticketflow/shared'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { onNotice } from '../lib/notice.js'
import { href } from '../lib/route.js'
import { STATUS_LABEL, statusTone } from './status.js'

interface Toast {
  readonly key: string
  readonly id?: string
  readonly title: string
  readonly tone: ReturnType<typeof statusTone>
  readonly detail: string
  // failures stay longer and wrap, so the reason can be read
  readonly sticky?: boolean
}

const TONE_BAR: Record<ReturnType<typeof statusTone>, string> = {
  neutral: 'bg-muted',
  accent: 'bg-accent-fg',
  warn: 'bg-warn',
  bad: 'bg-bad',
  ok: 'bg-ok-dot',
}

// Watches the ticket map and pops a toast whenever a ticket moves to a new status.
export function Toasts({ tickets }: { tickets: readonly Ticket[] }) {
  const seen = useRef<Map<string, TicketStatus> | null>(null)
  const [toasts, setToasts] = useState<readonly Toast[]>([])

  useEffect(() => {
    if (tickets.length === 0) return // still connecting
    const prev = seen.current
    seen.current = new Map(tickets.map((t) => [t.id, t.status] as const))
    if (!prev) return // first snapshot after connecting: nothing "happened"
    const fresh: Toast[] = []
    for (const t of tickets) {
      const before = prev.get(t.id)
      if (before === t.status) continue
      fresh.push({
        key: `${t.id}-${t.status}-${Date.now()}`,
        id: t.id,
        title: t.title,
        tone: statusTone(t.status),
        detail: before ? `${STATUS_LABEL[before]} → ${STATUS_LABEL[t.status]}` : 'New ticket assigned',
      })
    }
    if (fresh.length) setToasts((list) => [...fresh, ...list].slice(0, 4))
  }, [tickets])

  useEffect(
    () =>
      onNotice((n) =>
        setToasts((list) => [{ key: `n-${Date.now()}-${Math.random()}`, ...(n.id ? { id: n.id } : {}), title: n.title, detail: n.detail ?? '', tone: n.tone, sticky: n.tone === 'bad' }, ...list].slice(0, 4)),
      ),
    [],
  )

  useEffect(() => {
    if (!toasts.length) return
    const last = toasts.at(-1)
    const timer = setTimeout(() => setToasts((list) => list.slice(0, -1)), last?.sticky ? 12000 : 5000)
    return () => clearTimeout(timer)
  }, [toasts])

  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[340px] flex-col-reverse gap-2 max-md:right-3 max-md:bottom-[calc(env(safe-area-inset-bottom)+68px)] max-md:left-3 max-md:w-auto" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <motion.a
            layout
            key={t.key}
            href={t.id ? href.ticket(t.id) : undefined}
            initial={{ opacity: 0, y: 24, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40, scale: 0.95, transition: { duration: 0.2 } }}
            transition={{ type: 'spring', stiffness: 420, damping: 30 }}
            drag="x"
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={0.6}
            onDragEnd={(_, info) => {
              if (Math.abs(info.offset.x) > 80) setToasts((list) => list.filter((x) => x.key !== t.key))
            }}
            onClick={() => setToasts((list) => list.filter((x) => x.key !== t.key))}
            className="pointer-events-auto relative flex gap-3 overflow-hidden rounded-lg border border-line-2 bg-raised/95 px-3.5 py-3 shadow-[0_12px_32px_-12px_rgba(0,0,0,.7)] backdrop-blur"
          >
            <span className={`w-1 shrink-0 rounded-full ${TONE_BAR[t.tone]}`} aria-hidden="true" />
            <span className="min-w-0 flex-1">
              {t.sticky ? (
                <>
                  <span className="block text-xs font-medium text-bad">{t.title}</span>
                  <span className="mt-0.5 block text-xs leading-snug break-words whitespace-pre-wrap text-fg-2">{t.detail.slice(0, 600)}</span>
                </>
              ) : (
                <>
                  <span className="flex items-center justify-between gap-2 text-xs">
                    <span className="font-medium">{t.id ?? t.title}</span>
                    <span className="text-muted">{t.detail}</span>
                  </span>
                  {t.id && <span className="mt-0.5 block truncate text-xs text-fg-2">{t.title}</span>}
                </>
              )}
            </span>
            <motion.span
              aria-hidden="true"
              className={`absolute bottom-0 left-0 h-[2px] ${TONE_BAR[t.tone]}`}
              initial={{ width: '100%' }}
              animate={{ width: '0%' }}
              transition={{ duration: t.sticky ? 12 : 5, ease: 'linear' }}
            />
          </motion.a>
        ))}
      </AnimatePresence>
    </div>
  )
}
