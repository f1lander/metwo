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
import { MevoMascot } from './components/Mascot.js'
import { UpdateBar } from './components/UpdateBar.js'
import { mascot, useMascotHidden } from './lib/mascot.js'
import { ReviewsPage, ReviewView, reviewsWaiting } from './components/Reviews.js'
import { needsMe } from './components/status.js'
import { TicketView } from './components/TicketView.js'
import { Toasts } from './components/Toasts.js'
import { Button, Count, Dot } from './components/ui.js'
import { controls, useDaemon, useHealth } from './lib/api.js'
import { failed } from './lib/notice.js'
import { setTickets } from './lib/estimates.js'
import { goBack, goForward, useHistoryNav } from './lib/history.js'
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
  // replays live on their original's page, not on the board
  const tickets: readonly Ticket[] = useMemo(() => (state ? Object.values(state.tickets).filter((t) => !t.replay) : []), [state])
  const replaysOf = useMemo(() => (route.page === 'ticket' && state ? Object.values(state.tickets).filter((t) => t.replay?.of === route.id) : []), [state, route])
  useEffect(() => setTickets(tickets), [tickets])
  const reviews = state ? Object.values(state.reviews ?? {}).sort((a, b) => b.requestedAt.localeCompare(a.requestedAt)) : []
  const toReview = reviewsWaiting(reviews)

  const waiting = tickets.filter(needsMe).length
  const working = tickets.filter((t) => t.status === 'running').length
  // the menu bar count and notifications are driven from Rust, so they work with the window closed

  // asks the daemon to poll Linear and GitHub now, then reloads; on the board it also remounts it
  const refreshAll = async () => {
    await controls.refresh().catch(() => undefined)
    await reload()
    await refresh()
    setEpoch((e) => e + 1)
  }

  const pageKey = route.page === 'ticket' ? `t-${route.id}` : route.page === 'review' ? `r-${route.id}` : route.page

  return (
    <MotionConfig reducedMotion="user">
      <main className="flex h-full flex-col overflow-hidden">
        <Header mo={state?.mascot?.enabled ?? true} health={health} connected={connected} route={route} refresh={refresh} refreshAll={refreshAll} working={working} waiting={waiting} toReview={toReview} />
        <UpdateBar health={health} />
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={state ? pageKey : 'offline'} {...PAGE} className="flex min-h-0 flex-1 flex-col">
            {route.page === 'settings' ? (
              <SettingsPage health={health} refresh={refresh} tab={route.tab} tickets={tickets} />
            ) : route.page === 'learnings' ? (
              <LearningsPage />
            ) : !state ? (
              <Offline connected={connected} unauthorized={unauthorized} />
            ) : route.page === 'today' ? (
              <TodayPage tickets={tickets} reviews={reviews} mentions={state.slackMentions ?? []} {...(state.nightShift ? { night: state.nightShift } : {})} slack={health?.slack?.ok === true} />
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
                <TicketView ticket={state.tickets[route.id] as Ticket} live={live[route.id] ?? []} {...(health?.lanes.models ? { models: health.lanes.models } : {})} engines={health?.lanes.engines ?? []} budget={health?.lanes.budget} principles={health?.lanes.principles} phones={health?.android?.devices ?? []} mo={state.mascot?.enabled ?? true} replays={replaysOf} />
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
                  me={health?.github.login ?? null}
                />
                <Activity tickets={tickets} />
              </>
            )}
          </motion.div>
        </AnimatePresence>
        <StatusBar health={health} connected={connected} night={state?.nightShift?.active ?? false} />
        <BottomNav route={route} waiting={waiting} toReview={toReview} />
        <Toasts tickets={tickets} />
        {state && <MevoMascot state={state} route={route} />}
        <CycleSheet />
        <CommandPalette tickets={tickets} route={route} paused={health?.lanes.paused ?? false} maxParallel={health?.lanes.max ?? 2} />
      </main>
    </MotionConfig>
  )
}

function Header({
  mo,
  health,
  connected,
  route,
  refresh,
  refreshAll,
  working,
  waiting,
  toReview,
}: {
  mo: boolean
  health: Health | null
  connected: boolean
  route: Route
  refresh: () => Promise<void>
  refreshAll: () => Promise<void>
  working: number
  waiting: number
  toReview: number
}) {
  const nav = useHistoryNav()
  const moHidden = useMascotHidden()
  const [busy, setBusy] = useState(false)
  const [spinning, setSpinning] = useState(false)
  const reloadAll = async () => {
    setSpinning(true)
    try {
      await refreshAll()
    } catch (err) {
      failed(err)
    } finally {
      setSpinning(false)
    }
  }
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
      <a
        href={href.home}
        className="flex items-center text-fg"
        aria-label={mo && moHidden ? 'Bring Mo back' : 'mevo, home'}
        title={mo && moHidden ? 'Bring Mo back' : undefined}
        onClick={(e) => {
          // Mo docked, or not on screen for any reason: the logo brings him out instead of going home
          if (!mo || (!moHidden && mascot.present())) return
          e.preventDefault()
          mascot.summon()
        }}
      >
        <Logo className="h-[17px] w-auto" busy={working > 0} ringRef={mascot.setRing} />
      </a>
      <span className="flex items-center gap-0.5 text-muted max-md:hidden">
        {(
          [
            ['back', nav.canBack, goBack, 'M10 3 5 8l5 5', /Mac/.test(navigator.platform) ? '⌘[' : 'Alt ←'],
            ['forward', nav.canForward, goForward, 'm6 3 5 5-5 5', /Mac/.test(navigator.platform) ? '⌘]' : 'Alt →'],
          ] as const
        ).map(([name, on, go, d, key]) => (
          <button key={name} type="button" disabled={!on} onClick={go} aria-label={name} title={`${name === 'back' ? 'Back' : 'Forward'} (${key} or the mouse side button)`} className="rounded p-1 transition-colors hover:bg-raised hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent">
            <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d={d} />
            </svg>
          </button>
        ))}
      </span>
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
      <a href={href.health} className="ml-auto flex min-w-0 items-center gap-2 text-xs text-muted md:hidden" aria-label="status">
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
        className="shrink-0 rounded-md border border-line px-2 py-1 text-xs text-muted transition-colors hover:border-line-2 hover:text-fg max-md:flex max-md:size-10 max-md:items-center max-md:justify-center max-md:p-0 md:ml-auto"
        title="find tickets: the current cycle, the backlog, any project, a search, or a Linear link"
        aria-label="Find tickets"
      >
        <span className="max-md:hidden">Find tickets</span>
        <Icon d="M10 4v12M4 10h12" className="md:hidden" />
      </button>
      <button
        type="button"
        onClick={openPalette}
        className="flex shrink-0 items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs text-muted transition-colors hover:border-line-2 hover:text-fg max-md:size-10 max-md:justify-center max-md:p-0"
        aria-label="Command palette"
      >
        <span className="max-md:hidden">Search</span>
        <Icon d="M9 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12Zm4.5-1.5L17 17" className="md:hidden" />
        <kbd className="font-sans text-[11px] text-dim max-md:hidden">{/Mac/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      <Button disabled={spinning} title="check Linear and GitHub now and reload" aria-label="Refresh" className="shrink-0 max-md:size-10 max-md:px-0" onClick={() => void reloadAll()}>
        <span className="flex items-center gap-1.5">
          <motion.span aria-hidden="true" animate={spinning ? { rotate: 360 } : { rotate: 0 }} transition={spinning ? { duration: 0.8, repeat: Infinity, ease: 'linear' } : { duration: 0 }}>
            ↻
          </motion.span>
          <span className="max-md:hidden">Refresh</span>
        </span>
      </Button>
      {health && (
        <Button disabled={busy} aria-label={health.lanes.paused ? 'Resume the lanes' : 'Pause the lanes'} className="shrink-0 max-md:size-10 max-md:px-0" onClick={() => void toggle()}>
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span key={health.lanes.paused ? 'resume' : 'pause'} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}>
              <span className="max-md:hidden">{health.lanes.paused ? 'Resume' : 'Pause'}</span>
              <Icon d={health.lanes.paused ? 'M7 4.5v11l9-5.5-9-5.5Z' : 'M7 4.5v11M13 4.5v11'} className="md:hidden" />
            </motion.span>
          </AnimatePresence>
        </Button>
      )}
    </header>
  )
}

// stroke icons for the phone header and tab bar, drawn on a 20px grid
const TAB_ICONS: Record<string, string> = {
  home: 'M3.5 9 10 3.5 16.5 9v7a1 1 0 0 1-1 1h-3.5v-5h-4v5H4.5a1 1 0 0 1-1-1Z',
  today: 'M10 13.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM10 2v1.5M10 16.5V18M2 10h1.5M16.5 10H18M4.3 4.3l1.1 1.1M14.6 14.6l1.1 1.1M4.3 15.7l1.1-1.1M14.6 5.4l1.1-1.1',
  board: 'M3.5 3.5h3.5v13H3.5ZM8.25 3.5h3.5v9h-3.5ZM13 3.5h3.5v6H13Z',
  reviews: 'M6 3.5v13M6 3.5a2 2 0 1 0 0 .01M6 16.5a2 2 0 1 0 0-.01M14 16.5a2 2 0 1 0 0-.01M14 14.5V8a2.5 2.5 0 0 0-2.5-2.5H9',
  learnings: 'M7.5 15h5M8 17.5h4M10 2.5a5 5 0 0 0-3 9c.6.5 1 1.2 1 2V14h4v-.5c0-.8.4-1.5 1-2a5 5 0 0 0-3-9Z',
  settings: 'M10 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM16 10l1.5-1-1.5-2.6-1.7.6-1.4-.8-.4-1.7h-3l-.4 1.7-1.4.8-1.7-.6L2.5 9 4 10l-1.5 1 1.5 2.6 1.7-.6 1.4.8.4 1.7h3l.4-1.7 1.4-.8 1.7.6 1.5-2.6Z',
}

function Icon({ d, className = '' }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={`size-[18px] ${className}`} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

function BottomNav({ route, waiting, toReview }: { route: Route; waiting: number; toReview: number }) {
  const items = [
    { key: 'home', label: 'Home', to: href.home, active: route.page === 'home', badge: 0 },
    { key: 'today', label: 'Today', to: href.today, active: route.page === 'today', badge: 0 },
    { key: 'board', label: 'Board', to: href.board, active: route.page === 'board' || route.page === 'ticket', badge: waiting },
    { key: 'reviews', label: 'Reviews', to: href.reviews, active: route.page === 'reviews' || route.page === 'review', badge: toReview },
    { key: 'learnings', label: 'Learnings', to: href.learnings, active: route.page === 'learnings', badge: 0 },
    { key: 'settings', label: 'Settings', to: href.settings(), active: route.page === 'settings', badge: 0 },
  ]
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 flex border-t border-line bg-bg/90 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden" aria-label="sections">
      {items.map((item) => (
        <a key={item.key} href={item.to} aria-label={item.badge ? `${item.label}, ${item.badge}` : item.label} className={`relative flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-1 pt-1 ${item.active ? 'text-fg' : 'text-muted'}`}>
          {item.active && <motion.span layoutId="bottom-pill" className="absolute top-0 h-[2px] w-10 rounded-full bg-accent-fg" transition={{ type: 'spring', stiffness: 500, damping: 36 }} />}
          <span className="relative">
            <Icon d={TAB_ICONS[item.key] as string} className="size-5" />
            {item.badge > 0 && (
              <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} className="absolute -top-1.5 -right-2.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-warn px-1 text-[10px] leading-none font-semibold text-bg">
                {item.badge}
              </motion.span>
            )}
          </span>
          <span className="max-w-full truncate text-[11px] leading-none">{item.label}</span>
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
        : 'Start it on the Mac with pnpm daemon, or open the mevo app.'
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
