import type { Ticket } from '@ticketflow/shared'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { actions, controls } from '../lib/api.js'
import { href, type Route } from '../lib/route.js'
import { desktop, isDesktop } from '../lib/tauri.js'
import { canMarkReady, canMoveInLinear, STATUS_LABEL } from './status.js'

interface Command {
  readonly id: string
  readonly label: string
  readonly hint?: string
  readonly group: string
  readonly keywords?: string
  readonly run: () => unknown
}

// Subsequence match with a bonus for consecutive hits and word starts. Higher is better.
function score(query: string, text: string): number {
  if (!query) return 1
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (t.includes(q)) return 100 - t.indexOf(q) + q.length * 2
  let ti = 0
  let total = 0
  let streak = 0
  for (const ch of q) {
    if (ch === ' ') continue
    const found = t.indexOf(ch, ti)
    if (found === -1) return 0
    streak = found === ti ? streak + 1 : 0
    total += 1 + streak * 2 + (found === 0 || /[\s\-_/·]/.test(t[found - 1] ?? '') ? 3 : 0)
    ti = found + 1
  }
  return total
}

function buildCommands(tickets: readonly Ticket[], route: Route, paused: boolean, maxParallel: number, report: (msg: string) => void): Command[] {
  const go = (to: string) => () => {
    window.location.hash = to
  }
  const act = (fn: () => Promise<unknown>, done: string) => async () => {
    try {
      await fn()
      report(done)
    } catch (err) {
      report(err instanceof Error ? err.message : String(err))
    }
  }
  const current = route.page === 'ticket' ? tickets.find((t) => t.id === route.id) : undefined
  const forTicket = (t: Ticket, group: string): Command[] => {
    const list: Command[] = []
    const k = `${t.id} ${t.title}`
    if (t.status === 'assigned' || t.status === 'failed' || t.status === 'no_change' || t.status === 'skipped') {
      const verb = t.status === 'assigned' ? 'Start' : 'Retry'
      list.push({ id: `${t.id}-lite`, group, label: `${verb} lite · ${t.id}`, keywords: k, run: act(() => actions.start(t, 'lite'), `${t.id} queued (lite)`) })
      list.push({ id: `${t.id}-full`, group, label: `${verb} full · ${t.id}`, keywords: k, run: act(() => actions.start(t, 'full'), `${t.id} queued (full)`) })
      list.push({ id: `${t.id}-max`, group, label: `${verb} max effort · ${t.id}`, keywords: `${k} max deep`, run: act(() => actions.start(t, 'max'), `${t.id} queued (max)`) })
    }
    if (t.status === 'review_ready') list.push({ id: `${t.id}-push`, group, label: `${t.prUrl || t.pr ? 'Push to the PR' : 'Push + draft PR'} · ${t.id}`, keywords: k, run: act(() => actions.push(t), `${t.id} pushed`) })
    if (t.status === 'stopped') list.push({ id: `${t.id}-resume`, group, label: `Resume · ${t.id}`, keywords: `${k} resume continue stopped`, run: act(() => actions.resume(t), `${t.id} resuming`) })
    if (t.behindMain && t.status !== 'running' && t.status !== 'queued') list.push({ id: `${t.id}-main`, group, label: `Update from main · ${t.id}`, keywords: `${k} main merge behind update`, run: act(() => actions.updateMain(t), `${t.id}: merging main`) })
    if (canMoveInLinear(t)) {
      list.push({ id: `${t.id}-qa`, group, label: `Move to QA · ${t.id}`, keywords: k, run: act(() => actions.moveInLinear(t, 'qa'), `${t.id} moved to QA`) })
      list.push({ id: `${t.id}-done`, group, label: `Done in Linear · ${t.id}`, keywords: k, run: act(() => actions.moveInLinear(t, 'done'), `${t.id} done in Linear`) })
    }
    if (canMarkReady(t)) list.push({ id: `${t.id}-ready`, group, label: `Ready for review · ${t.id}`, keywords: `${k} draft review undraft`, run: act(() => actions.ready(t), `${t.id} ready for review`) })
    if (t.pr?.greptile?.findings.length && t.status === 'pr_draft') list.push({ id: `${t.id}-greptile`, group, label: `Fix Greptile findings · ${t.id}`, keywords: `${k} greptile review`, run: act(() => actions.fixGreptile(t), `${t.id}: lane on Greptile's findings`) })
    if (t.worktree && t.status !== 'running' && t.status !== 'queued') list.push({ id: `${t.id}-visual`, group, label: `Run visual check · ${t.id}`, keywords: `${k} visual screenshot verify ui`, run: act(() => actions.visualRun(t), `${t.id}: visual check started`) })
    if (t.worktree) list.push({ id: `${t.id}-claude`, group, label: `Open in Claude · ${t.id}`, keywords: `${k} claude ask terminal warp question`, run: act(() => actions.openClaude(t), `${t.id} opened in Claude`) })
    if (t.worktree) list.push({ id: `${t.id}-editor`, group, label: `Open in editor · ${t.id}`, keywords: `${k} cursor code vscode`, run: act(() => actions.openEditor(t), `opened ${t.id}`) })
    if (t.prUrl) list.push({ id: `${t.id}-pr`, group, label: `Open PR · ${t.id}`, keywords: `${k} github`, run: () => desktop.open(t.prUrl ?? '') })
    list.push({ id: `${t.id}-linear`, group, label: `Open in Linear · ${t.id}`, keywords: k, run: () => desktop.open(t.url) })
    return list
  }

  const live = tickets.filter((t) => t.status !== 'done' && t.status !== 'skipped')
  return [
    ...(current ? forTicket(current, `This ticket · ${current.id}`) : []),
    ...[...live, ...tickets.filter((t) => !live.includes(t))].map((t) => ({
      id: `go-${t.id}`,
      group: 'Tickets',
      label: `${t.id}  ${t.title}`,
      hint: STATUS_LABEL[t.status],
      run: go(href.ticket(t.id)),
    })),
    { id: 'cycle', group: 'Go to', label: 'Take issues from the current cycle', keywords: 'linear cycle assign unassigned find work', run: () => window.dispatchEvent(new Event('metwo:cycle')) },
    { id: 'home', group: 'Go to', label: 'Home', run: go(href.home) },
    { id: 'board', group: 'Go to', label: 'Board', run: go(href.board) },
    { id: 'settings', group: 'Go to', label: 'Settings', keywords: 'autopilot budget engines limits effort lanes', run: go(href.settings()) },
    { id: 'status', group: 'Go to', label: 'Status', keywords: 'health checks daemon', run: go(href.health) },
    { id: 'poll', group: 'metwo', label: 'Poll Linear now', keywords: 'refresh sync', run: act(() => controls.poll(), 'Linear polled') },
    paused
      ? { id: 'resume', group: 'metwo', label: 'Resume lanes', run: act(() => controls.resume(), 'lanes resumed') }
      : { id: 'pause', group: 'metwo', label: 'Pause lanes', keywords: 'stop', run: act(() => controls.pause(), 'lanes paused') },
    ...[1, 2, 3, 4, 6, 8]
      .filter((n) => n !== maxParallel)
      .map((n) => ({ id: `parallel-${n}`, group: 'metwo', label: `Run up to ${n} lane${n === 1 ? '' : 's'} at once`, hint: `now ${maxParallel}`, keywords: 'parallel lanes concurrency queue', run: act(() => controls.parallel(n), `up to ${n} lanes at once`) })),
    ...(['low', 'medium', 'high'] as const).map((e) => ({ id: `effort-${e}`, group: 'metwo', label: `Effort: ${e} for every lane`, keywords: 'effort think model speed', run: act(() => controls.effort(e), `lanes now run at ${e} effort`) })),
    { id: 'bot', group: 'metwo', label: 'Restart Telegram bot', run: act(() => controls.restartBot(), 'bot restarted') },
    ...(isDesktop ? [{ id: 'restart', group: 'metwo', label: 'Restart daemon', run: act(() => desktop.restart(), 'daemon restarted') }] : []),
    ...live.filter((t) => t.id !== current?.id).flatMap((t) => forTicket(t, 'Actions')),
  ]
}

export function CommandPalette({ tickets, route, paused, maxParallel }: { tickets: readonly Ticket[]; route: Route; paused: boolean; maxParallel: number }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [flash, setFlash] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    const onOpen = () => setOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('metwo:palette', onOpen)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('metwo:palette', onOpen)
    }
  }, [])

  useEffect(() => {
    if (open) {
      setQuery('')
      setIndex(0)
    }
  }, [open])

  useEffect(() => {
    if (!flash) return
    const id = setTimeout(() => setFlash(null), 2600)
    return () => clearTimeout(id)
  }, [flash])

  const results = useMemo(() => {
    const all = buildCommands(tickets, route, paused, maxParallel, setFlash)
    if (!query.trim()) return all.filter((c) => c.group !== 'Actions' && !c.id.startsWith('parallel-') && !c.id.startsWith('effort-')).slice(0, 40)
    return all
      .map((c) => ({ c, s: Math.max(score(query, c.label), c.keywords ? score(query, c.keywords) * 0.8 : 0) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, 40)
      .map((r) => r.c)
  }, [tickets, route, paused, maxParallel, query])

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const runAt = (i: number) => {
    const cmd = results[i]
    if (!cmd) return
    setOpen(false)
    void cmd.run()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      runAt(index)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  let lastGroup = ''
  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[14vh] backdrop-blur-[2px] max-md:pt-[calc(env(safe-area-inset-top)+12px)]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }} onMouseDown={() => setOpen(false)}>
            <motion.div
              role="dialog"
              aria-label="Command palette"
              className="flex max-h-[60vh] w-full max-w-[560px] flex-col overflow-hidden rounded-xl border border-line-2 bg-panel shadow-[0_24px_80px_rgba(0,0,0,.55)]"
              initial={{ opacity: 0, scale: 0.96, y: -8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97, y: -4 }}
              transition={{ type: 'spring', stiffness: 520, damping: 34 }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <input
                autoFocus
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setIndex(0)
                }}
                onKeyDown={onKeyDown}
                placeholder="Type a ticket or a command…"
                aria-label="Search tickets and commands"
                className="border-b border-line bg-transparent px-4 py-3.5 text-[14px] outline-none placeholder:text-dim max-md:text-[16px]"
              />
              <div ref={listRef} className="overflow-y-auto py-1.5" role="listbox">
                {results.length === 0 && <div className="px-4 py-6 text-center text-xs text-muted">Nothing matches.</div>}
                {results.map((c, i) => {
                  const header = c.group !== lastGroup ? c.group : null
                  lastGroup = c.group
                  return (
                    <div key={c.id}>
                      {header && <div className="px-4 pt-2.5 pb-1 text-[11px] font-medium text-dim">{header}</div>}
                      <button
                        type="button"
                        role="option"
                        aria-selected={i === index}
                        data-index={i}
                        onMouseMove={() => setIndex(i)}
                        onClick={() => runAt(i)}
                        className="relative flex w-full items-center gap-3 px-4 py-2 text-left text-[13px]"
                      >
                        {i === index && <motion.span layoutId="palette-active" className="absolute inset-x-1.5 inset-y-0 rounded-md bg-raised" transition={{ type: 'spring', stiffness: 700, damping: 40 }} />}
                        <span className="relative min-w-0 flex-1 truncate">{c.label}</span>
                        {c.hint && <span className="relative shrink-0 text-xs text-muted">{c.hint}</span>}
                      </button>
                    </div>
                  )
                })}
              </div>
              <div className="flex gap-4 border-t border-line px-4 py-2 text-[11px] text-dim max-md:hidden">
                <span>↑↓ move</span>
                <span>↵ run</span>
                <span>esc close</span>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {flash && (
          <motion.div
            className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-lg border border-line-2 bg-raised px-4 py-2 text-xs shadow-lg max-md:bottom-20"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
          >
            {flash}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}

export const openPalette = () => window.dispatchEvent(new Event('metwo:palette'))
