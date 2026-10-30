import type { Health, Ticket } from '@ticketflow/shared'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { useEffect, useMemo, useState } from 'react'
import { Activity } from './components/Activity.js'
import { Board } from './components/Board.js'
import { CommandPalette, openPalette } from './components/CommandPalette.js'
import { CycleSheet, openCycle } from './components/Cycle.js'
import { SettingsPage } from './components/Settings.js'
import { TodayPage } from './components/Today.js'
import { StatusBar } from './components/StatusBar.js'
import { Home } from './components/Home.js'
import { LearningsPage } from './components/LearningsPage.js'
import { Logo } from './components/Logo.js'
import { ReviewsPage, ReviewView, reviewsWaiting } from './components/Reviews.js'
import { needsMe } from './components/status.js'
import { TicketView } from './components/TicketView.js'
import { Toasts } from './components/Toasts.js'
import { Button, Count, Dot } from './components/ui.js'
import { controls, useDaemon, useHealth } from './lib/api.js'
import { setTickets } from './lib/estimates.js'
import { href, type Route, useRoute } from './lib/route.js'
import { desktop, isDesktop } from './lib/tauri.js'

const PAGE = {
  initial: { opacity: 0, y: 10, filter: 'blur(4px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
  exit: { opacity: 0, y: -6, filter: 'blur(2px)' },
  transition: { duration: 0.24, ease: [0.22, 1, 0.36, 1] },
} as const

export function App() {
  const { state, live, connected, unauthorized, reload } = useDaemon()
  // bumping it remounts the board, which drops cards stuck mid-animation after the window was hidden
  const [epoch, setEpoch] = useState(0)
  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && setEpoch((e) => e + 1)
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])
  const { health, refresh } = useHealth()
  const route = useRoute()
  const tickets: readonly Ticket[] = useMemo(() => (state ? Object.values(state.tickets) : []), [state])
  useEffect(() => setTickets(tickets), [tickets])
  const reviews = state ? Object.values(state.reviews ?? {}).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)) : []
  const toReview = reviewsWaiting(reviews)

  const waiting = tickets.filter(needsMe).length
  const working = tickets.filter((t) => t.status === 'running').length
  // the menu bar count and notifications are driven from Rust, so they work with the window closed

  const pageKey = route.page === 'ticket' ? `t-${route.id}` : route.page === 'review' ? `r-${route.id}` : route.page

  return (
    <MotionConfig reducedMotion="user">
      <main className="flex h-full flex-col overflow-hidden">
        <Header health={health} connected={connected} route={route} refresh={refresh} working={working} waiting={waiting} toReview={toReview} />
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={state ? pageKey : 'offline'} {...PAGE} className="flex min-h-0 flex-1 flex-col">
            {route.page === 'settings' ? (
              <SettingsPage health={health} refresh={refresh} tab={route.tab} />
            ) : route.page === 'learnings' ? (
              <LearningsPage />
            ) : !state ? (
              <Offline connected={connected} unauthorized={unauthorized} />
            ) : route.page === 'today' ? (
              <TodayPage tickets={tickets} reviews={reviews} />
            ) : route.page === 'home' ? (
              <Home tickets={tickets} health={health} reviews={reviews} />
            ) : route.page === 'reviews' ? (
              <ReviewsPage reviews={reviews} />
            ) : route.page === 'review' ? (
              state.reviews?.[route.id] ? (
                <ReviewView review={state.reviews[route.id] as NonNullable<typeof state.reviews>[string]} live={live[route.id] ?? []} />
              ) : (
                <div className="p-6 text-muted">
                  {route.id} is not on your review list.{' '}
                  <a href={href.reviews} className="text-accent-fg">
                    Back to reviews
                  </a>
                </div>
              )
            ) : route.page === 'ticket' ? (
              state.tickets[route.id] ? (
                <TicketView ticket={state.tickets[route.id] as Ticket} live={live[route.id] ?? []} {...(health?.lanes.models ? { models: health.lanes.models } : {})} engines={health?.lanes.engines ?? []} budget={health?.lanes.budget} />
              ) : (
                <div className="p-6 text-muted">
                  {route.id} is not tracked.{' '}
                  <a href={href.board} className="text-accent-fg">
                    Back to the board
                  </a>
                </div>
              )
            ) : (
              <>
                <Board
                  key={epoch}
                  tickets={tickets}
                  live={live}
                  onRefresh={async () => {
                    await controls.refresh().catch(() => undefined)
                    await reload()
                    setEpoch((e) => e + 1)
                  }}
                />
                <Activity tickets={tickets} />
              </>
            )}
          </motion.div>
        </AnimatePresence>
        <StatusBar health={health} connected={connected} />
        <BottomNav route={route} waiting={waiting} toReview={toReview} />
        <Toasts tickets={tickets} />
        <CycleSheet />
        <CommandPalette tickets={tickets} route={route} paused={health?.lanes.paused ?? false} maxParallel={health?.lanes.max ?? 2} />
      </main>
    </MotionConfig>
  )
}

function Header({
  health,
  connected,
  route,
  refresh,
  working,
  waiting,
  toReview,
}: {
  health: Health | null
  connected: boolean
  route: Route
  refresh: () => Promise<void>
  working: number
  waiting: number
  toReview: number
}) {
  const [busy, setBusy] = useState(false)
  const toggle = async () => {
    if (!health) return
    setBusy(true)
    try {
      await (health.lanes.paused ? controls.resume() : controls.pause())
      await refresh()
    } finally {
      setBusy(false)
    }
  }
  return (
    <header
      className={`flex h-12 shrink-0 items-center gap-4 border-b border-line px-4 max-md:h-auto max-md:gap-2 max-md:pt-[calc(env(safe-area-inset-top)+10px)] max-md:pb-2.5 ${isDesktop ? 'pl-20' : ''}`}
      data-tauri-drag-region
    >
      <a href={href.home} className="flex items-center text-fg" aria-label="metwo, home">
        <Logo className="h-[17px] w-auto" busy={working > 0} />
      </a>
      <nav className="flex gap-1 text-xs max-md:hidden">
        {(['home', 'today', 'board', 'reviews', 'learnings', 'settings'] as const).map((page) => {
          const active = page === 'board' ? route.page === 'board' || route.page === 'ticket' : page === 'reviews' ? route.page === 'reviews' || route.page === 'review' : route.page === page
          return (
            <a key={page} href={page === 'settings' ? href.settings() : href[page]} className={`relative rounded px-2 py-1 ${active ? 'text-fg' : 'text-muted hover:text-fg'}`}>
              {active && <motion.span layoutId="nav-pill" className="absolute inset-0 rounded bg-raised" transition={{ type: 'spring', stiffness: 500, damping: 36 }} />}
              <span className="relative capitalize">{page}</span>
              {page === 'reviews' && toReview > 0 && <span className="relative ml-1 rounded-full bg-raised px-1.5 text-[10px] text-warn">{toReview}</span>}
            </a>
          )
        })}
      </nav>
      {/* on phones; wider screens have the status bar */}
      <a href={href.health} className="ml-auto flex items-center gap-2 text-xs text-muted md:hidden" aria-label="status">
        <Dot ok={connected && (health ? [health.telegram.ok, health.linear.ok, health.github.ok].every((v) => v !== false) : null)} pulse />
        {waiting > 0 && (
          <span className="rounded-full bg-[#2b2612] px-2 py-0.5 whitespace-nowrap text-warn">
            <Count value={waiting} /> need you
          </span>
        )}
      </a>
      <button
        type="button"
        onClick={openCycle}
        className="md:ml-auto rounded-md border border-line px-2 py-1 text-xs text-muted transition-colors hover:border-line-2 hover:text-fg"
        title="unassigned issues in the current Linear cycle"
      >
        Cycle
      </button>
      <button
        type="button"
        onClick={openPalette}
        className="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs text-muted transition-colors hover:border-line-2 hover:text-fg"
        aria-label="Command palette"
      >
        <span>Search</span>
        <kbd className="font-sans text-[11px] text-dim max-md:hidden">{/Mac/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      {health && (
        <Button disabled={busy} onClick={() => void toggle()}>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span key={health.lanes.paused ? 'resume' : 'pause'} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
              {health.lanes.paused ? 'Resume' : 'Pause'}
            </motion.span>
          </AnimatePresence>
        </Button>
      )}
    </header>
  )
}

function BottomNav({ route, waiting, toReview }: { route: Route; waiting: number; toReview: number }) {
  const items = [
    { key: 'home', label: 'Home', to: href.home, active: route.page === 'home' },
    { key: 'today', label: 'Today', to: href.today, active: route.page === 'today' },
    { key: 'board', label: 'Board', to: href.board, active: route.page === 'board' || route.page === 'ticket' },
    { key: 'reviews', label: 'Reviews', to: href.reviews, active: route.page === 'reviews' || route.page === 'review' },
    { key: 'learnings', label: 'Learnings', to: href.learnings, active: route.page === 'learnings' },
    { key: 'settings', label: 'Settings', to: href.settings(), active: route.page === 'settings' },
  ]
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-line bg-bg/90 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden" aria-label="sections">
      {items.map((item) => (
        <a key={item.key} href={item.to} className={`relative flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-xs ${item.active ? 'text-fg' : 'text-muted'}`}>
          {item.active && <motion.span layoutId="bottom-pill" className="absolute top-0 h-[2px] w-10 rounded-full bg-accent-fg" transition={{ type: 'spring', stiffness: 500, damping: 36 }} />}
          <span className="relative">
            {item.label}
            {item.key === 'reviews' && toReview > 0 && (
              <span className="absolute -top-1.5 -right-4 flex size-4 items-center justify-center rounded-full bg-warn text-[10px] font-semibold text-bg">{toReview}</span>
            )}
            {item.key === 'board' && waiting > 0 && (
              <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} className="absolute -top-1.5 -right-4 flex size-4 items-center justify-center rounded-full bg-warn text-[10px] font-semibold text-bg">
                {waiting}
              </motion.span>
            )}
          </span>
        </a>
      ))}
    </nav>
  )
}

function Offline({ connected, unauthorized }: { connected: boolean; unauthorized: boolean }) {
  const remote = !isDesktop && !['localhost', '127.0.0.1'].includes(location.hostname)
  const title = unauthorized ? 'This link is not signed in' : connected ? 'Loading…' : remote ? 'Can’t reach the Mac' : 'The daemon is not running'
  const hint = unauthorized
    ? 'Open the dashboard link from Telegram (send /tunnel to the bot). It carries the token and signs this browser in.'
    : remote
      ? 'The tunnel URL changes every time the daemon restarts. Send /tunnel to the bot for the current link. If Telegram answers, the Mac is up.'
      : isDesktop
        ? 'Start it here or from the Health page.'
        : 'Start it on the Mac with pnpm daemon, or open the metwo app.'
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 px-6 text-center">
      <Logo className="h-12 w-auto text-fg max-md:h-9" busy />
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }} className="flex flex-col items-center gap-3">
        <div className="text-sm font-medium">{title}</div>
        {!connected && (
          <>
            <p className="max-w-sm text-xs leading-relaxed text-muted">{hint}</p>
            {isDesktop && !unauthorized && (
              <Button variant="primary" onClick={() => void desktop.start()}>
                Start daemon
              </Button>
            )}
          </>
        )}
      </motion.div>
    </div>
  )
}
