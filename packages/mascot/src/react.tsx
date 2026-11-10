import { type CSSProperties, type KeyboardEvent, type ReactNode, type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { autoPose, type Mood } from './brain.js'
import { COFFEE } from './coffee.js'
import { type MascotStateId, type PoseInput, STATES } from './pose.js'
import { createMascot, type MascotRenderer } from './render.js'
import { RING_CENTER, RING_WIDTH, VIEWBOX } from './shape.js'

// frame budget for the animation loops (about 30 fps)
const FRAME_MS = 32

const prefersReduced = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches
const still = (p: PoseInput): PoseInput => ({ ...p, x: 0, y: 0, rot: 0, sx: 1, sy: 1 })

function useRenderer(host: RefObject<HTMLElement | null>, title?: string): RefObject<MascotRenderer | null> {
  const r = useRef<MascotRenderer | null>(null)
  useEffect(() => {
    if (!host.current) return
    const m = createMascot(host.current, title ? { title } : {})
    m.svg.style.width = '100%'
    m.svg.style.height = '100%'
    m.svg.style.display = 'block'
    r.current = m.renderer
    return () => {
      r.current = null
      m.destroy()
    }
  }, [host, title])
  return r
}

// Mo playing one state on a loop, or holding a pose. For docs, empty states, settings previews.
export function Mascot({ state = 'idle', pose, width = 120, className, style, title }: { state?: MascotStateId; pose?: PoseInput; width?: number; className?: string; style?: CSSProperties; title?: string }) {
  const host = useRef<HTMLDivElement>(null)
  const renderer = useRenderer(host, title)
  useEffect(() => {
    const reduce = prefersReduced()
    if (pose || reduce) {
      renderer.current?.set(pose ?? still(STATES[state].pose(0.8)))
      return
    }
    let raf = 0
    let last = 0
    const t0 = performance.now()
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      if (now - last < FRAME_MS) return
      last = now
      const t = (now - t0) / 1000
      renderer.current?.set(STATES[state].pose(t % STATES[state].dur))
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [state, pose, renderer])
  return <div ref={host} className={className} style={{ width, aspectRatio: `${VIEWBOX.w} / ${VIEWBOX.h}`, ...style }} />
}

type Corner = { h: 'left' | 'right'; v: 'top' | 'bottom' }
type Insets = { top: number; right: number; bottom: number; left: number }

export interface FloatingMascotProps {
  // what is going on: energy 0..1, working, asking, sleeping, coffee game on or off
  mood: Pick<Mood, 'energy' | 'coffee' | 'working' | 'asking' | 'sleeping'>
  // a short reaction; a new key plays it once
  flash?: { state: MascotStateId; key: string | number } | null
  // a speech bubble; a new key shows it for a few seconds
  bubble?: { text: string; key: string | number } | null
  // one click
  onPress?: () => void
  // clicks in a row: coffee, `sips` at a time
  onCoffee?: (sips: number) => void
  // ✕, or dragged off the screen
  onHide?: () => void
  hidden?: boolean
  // a new value brings Mo back to his corner, wherever he got stuck
  summon?: number
  // true while Mo is actually on screen; false when hidden, docked or stuck off the edge
  onPresence?: (present: boolean) => void
  // the element Mo flies into when hidden and out of when shown (the logo's "o")
  dock?: () => Element | null
  width?: number
  insets?: Partial<Insets>
  // remembers the corner across reloads
  storageKey?: string
  label?: string
  zIndex?: number
  // a panel next to Mo (a chat, a menu): placed toward the middle of the screen, never over him
  popover?: ReactNode
  popoverWidth?: number
  popoverHeight?: number
}

const DEFAULT_INSETS: Insets = { top: 64, right: 20, bottom: 20, left: 20 }

function loadCorner(key?: string): Corner {
  try {
    const v = key ? JSON.parse(localStorage.getItem(key) ?? 'null') : null
    if (v && (v.h === 'left' || v.h === 'right') && (v.v === 'top' || v.v === 'bottom')) return v
  } catch {
    // no storage: default corner
  }
  return { h: 'right', v: 'bottom' }
}

// Mo floating over the app: drag him to any corner, click to press, click a few times for coffee,
// ✕ (or throw him off screen) to dock him into the logo.
export function FloatingMascot({ mood, flash, bubble, onPress, onCoffee, onHide, hidden = false, summon, onPresence, dock, width = 76, insets, storageKey, label = 'Mo: click to open, click a few times for coffee, drag to move', zIndex = 40, popover, popoverWidth = 340, popoverHeight = 360 }: FloatingMascotProps) {
  const height = (width * VIEWBOX.h) / VIEWBOX.w
  const ins: Insets = { ...DEFAULT_INSETS, ...insets }
  const wrap = useRef<HTMLDivElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const renderer = useRenderer(host)
  const [corner, setCorner] = useState<Corner>(() => loadCorner(storageKey))
  const [drag, setDrag] = useState<{ left: number; top: number } | null>(null)
  const [visible, setVisible] = useState(!hidden)
  const [bubbleText, setBubbleText] = useState<string | null>(null)
  const [, setViewport] = useState(0)
  const t0 = useRef(performance.now())
  const clock = () => (performance.now() - t0.current) / 1000
  const live = useRef({ mood, drag: null as { vx: number; vy: number } | null, landedAt: -99, sipAt: -99, hyperUntil: -99, flash: null as Mood['flash'], pointer: null as { x: number; y: number } | null })
  live.current.mood = mood

  useEffect(() => {
    const onResize = () => setViewport((n) => n + 1)
    const onMove = (e: PointerEvent) => (live.current.pointer = { x: e.clientX, y: e.clientY })
    addEventListener('resize', onResize)
    addEventListener('pointermove', onMove)
    return () => {
      removeEventListener('resize', onResize)
      removeEventListener('pointermove', onMove)
    }
  }, [])

  // filling up makes him hyper for a moment
  const prevEnergy = useRef(mood.energy)
  useEffect(() => {
    if (mood.energy >= 1 && prevEnergy.current < 1) live.current.hyperUntil = clock() + COFFEE.hyperSeconds
    prevEnergy.current = mood.energy
  }, [mood.energy])

  const flashKey = flash?.key
  const firstFlash = useRef(true)
  useEffect(() => {
    if (firstFlash.current) {
      firstFlash.current = false
      return
    }
    if (flash) live.current.flash = { state: flash.state, at: clock() }
  }, [flashKey])

  useEffect(() => {
    if (!bubble) return
    setBubbleText(bubble.text)
    const id = setTimeout(() => setBubbleText(null), 4200)
    return () => clearTimeout(id)
  }, [bubble?.key])

  // the frame loop
  useEffect(() => {
    if (!visible) return
    const reduce = prefersReduced()
    let raf = 0
    let last = 0
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      // a slow mascot: 30 frames a second is plenty and halves the work
      if (now - last < FRAME_MS && !live.current.drag) return
      last = now
      const t = clock()
      const l = live.current
      let look: Mood['look'] = null
      const el = wrap.current
      if (l.pointer && el) {
        const r = el.getBoundingClientRect()
        look = { dx: l.pointer.x - (r.left + r.width / 2), dy: l.pointer.y - (r.top + r.height * 0.6) }
      }
      const p = autoPose(t, { ...l.mood, drag: l.drag, landedAt: l.landedAt, sipAt: l.sipAt, hyperUntil: l.hyperUntil, flash: l.flash ?? null, look })
      renderer.current?.set(reduce ? still(p) : p)
      if (el && ++frames % 10 === 0) {
        const r = el.getBoundingClientRect()
        present(r.right > 24 && r.bottom > 24 && r.left < innerWidth - 24 && r.top < innerHeight - 24)
      }
    }
    let frames = 0
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [visible, renderer])
  const presence = useRef<boolean | null>(null)
  const present = (v: boolean) => {
    if (presence.current === v) return
    presence.current = v
    onPresenceRef.current?.(v)
  }
  const onPresenceRef = useRef(onPresence)
  onPresenceRef.current = onPresence
  useEffect(() => {
    if (!visible) present(false)
  }, [visible])

  const cornerPos = (c: Corner) => ({
    left: c.h === 'left' ? ins.left : (typeof innerWidth === 'number' ? innerWidth : 1024) - ins.right - width,
    top: c.v === 'top' ? ins.top : (typeof innerHeight === 'number' ? innerHeight : 768) - ins.bottom - height,
  })
  const pos = drag ?? cornerPos(corner)

  // flying into the dock and out of it
  const dockMotion = () => {
    const el = wrap.current
    const target = dock?.()
    if (!el || !target) return null
    const r = el.getBoundingClientRect()
    const d = target.getBoundingClientRect()
    if (!d.width) return null
    const ox = r.width / 2
    const oy = ((RING_CENTER.y - VIEWBOX.y) / VIEWBOX.h) * r.height
    const s = d.width / ((RING_WIDTH / VIEWBOX.w) * r.width)
    el.style.transformOrigin = `${ox}px ${oy}px`
    return { dx: d.left + d.width / 2 - (r.left + ox), dy: d.top + d.height / 2 - (r.top + oy), s }
  }
  const wasHidden = useRef(hidden)
  const showing = useRef(false)
  useEffect(() => {
    if (hidden === wasHidden.current) return
    wasHidden.current = hidden
    const reduce = prefersReduced()
    if (hidden) {
      setBubbleText(null)
      const m = reduce ? null : dockMotion()
      if (!m || !wrap.current) return setVisible(false)
      const a = wrap.current.animate(
        [
          { transform: 'none' },
          { transform: 'translate(0, 4px) scale(1.08, .86)', offset: 0.18 },
          { transform: `translate(${m.dx * 0.5}px, ${m.dy * 0.5 - 70}px) scale(${(1 + m.s) / 2}) rotate(-24deg)`, offset: 0.6 },
          { transform: `translate(${m.dx}px, ${m.dy}px) scale(${m.s})` },
        ],
        { duration: 760, easing: 'cubic-bezier(.5,0,.3,1)' },
      )
      // brought back before he landed: stay out
      a.onfinish = () => wasHidden.current && setVisible(false)
    } else {
      setDrag(null)
      setVisible(true)
    }
  }, [hidden])
  useLayoutEffect(() => {
    if (!visible || hidden || prefersReduced()) return
    if (!showing.current) return
    showing.current = false
    const m = dockMotion()
    if (!m || !wrap.current) return
    wrap.current.animate(
      [
        { transform: `translate(${m.dx}px, ${m.dy}px) scale(${m.s})` },
        { transform: `translate(${m.dx * 0.5}px, ${m.dy * 0.5 - 90}px) scale(${(1 + m.s) / 2}) rotate(20deg)`, offset: 0.5 },
        { transform: 'translate(0, 0) scale(1.08, .88)', offset: 0.86 },
        { transform: 'none' },
      ],
      { duration: 740, easing: 'cubic-bezier(.3,0,.3,1)' },
    )
  }, [visible])
  useEffect(() => {
    if (!hidden) showing.current = true
  }, [hidden])
  const firstSummon = useRef(true)
  useEffect(() => {
    if (firstSummon.current) {
      firstSummon.current = false
      return
    }
    start.current = null
    live.current.drag = null
    setDrag(null)
    live.current.landedAt = clock() + 0.45
    const home = cornerPos(corner)
    if (wrap.current) {
      wrap.current.style.left = `${home.left}px`
      wrap.current.style.top = `${home.top}px`
    }
    if (!hidden && !visible) {
      showing.current = true
      setVisible(true)
    }
  }, [summon])

  // press, coffee, drag
  const press = useRef<{ timer: ReturnType<typeof setTimeout> | null; coffeeUntil: number }>({ timer: null, coffeeUntil: 0 })
  const sip = (n: number) => {
    live.current.sipAt = clock()
    onCoffee?.(n)
  }
  const click = () => {
    const p = press.current
    const now = performance.now()
    if (p.timer) {
      clearTimeout(p.timer)
      p.timer = null
      p.coffeeUntil = now + COFFEE.multiClickMs * 2
      sip(2)
    } else if (now < p.coffeeUntil) {
      p.coffeeUntil = now + COFFEE.multiClickMs * 2
      sip(1)
    } else {
      p.timer = setTimeout(() => {
        p.timer = null
        onPress?.()
      }, COFFEE.multiClickMs)
    }
  }
  useEffect(() => () => {
    if (press.current.timer) clearTimeout(press.current.timer)
  }, [])

  const start = useRef<{ x: number; y: number; left: number; top: number; moved: boolean; lx: number; ly: number; lt: number } | null>(null)
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('[data-mo-close]')) return
    e.currentTarget.setPointerCapture(e.pointerId)
    start.current = { x: e.clientX, y: e.clientY, left: pos.left, top: pos.top, moved: false, lx: e.clientX, ly: e.clientY, lt: performance.now() }
  }
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = start.current
    if (!s) return
    const dx = e.clientX - s.x
    const dy = e.clientY - s.y
    if (!s.moved && Math.hypot(dx, dy) < 6) return
    s.moved = true
    const now = performance.now()
    const dt = Math.max(8, now - s.lt)
    const v = live.current.drag ?? { vx: 0, vy: 0 }
    live.current.drag = { vx: v.vx * 0.7 + ((e.clientX - s.lx) / dt) * 300, vy: v.vy * 0.7 + ((e.clientY - s.ly) / dt) * 300 }
    s.lx = e.clientX
    s.ly = e.clientY
    s.lt = now
    setBubbleText(null)
    setDrag({ left: s.left + dx, top: s.top + dy })
  }
  // lost: the pointer was released outside the window or the browser took it; never strand him there
  const onPointerUp = (lost = false) => {
    const s = start.current
    start.current = null
    if (!s) return
    if (!s.moved) return lost ? undefined : click()
    live.current.drag = null
    const cx = pos.left + width / 2
    const cy = pos.top + height / 2
    if (!lost && onHide && (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight)) {
      onHide()
      return
    }
    const next: Corner = { h: cx < innerWidth / 2 ? 'left' : 'right', v: cy < innerHeight / 2 ? 'top' : 'bottom' }
    setCorner(next)
    setDrag(null)
    live.current.landedAt = clock() + 0.45
    try {
      if (storageKey) localStorage.setItem(storageKey, JSON.stringify(next))
    } catch {
      // not remembered
    }
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onPress?.()
    } else if (e.key === 'c') sip(1)
  }

  const [hover, setHover] = useState(false)
  // hidden, the box stays mounted: its SVG lives in it and would be lost on a remount
  const bubbleSide: CSSProperties = corner.h === 'right' && !drag ? { right: '70%' } : { left: '70%' }
  const bubbleV: CSSProperties = corner.v === 'top' && !drag ? { top: '78%' } : { bottom: '86%' }
  const vw = typeof innerWidth === 'number' ? innerWidth : 1024
  const vh = typeof innerHeight === 'number' ? innerHeight : 768
  const pw = Math.min(popoverWidth, vw - 24)
  const below = pos.top + height / 2 < vh / 2
  const popStyle: CSSProperties = {
    position: 'fixed',
    zIndex: zIndex + 1,
    width: pw,
    left: Math.max(12, Math.min(vw - pw - 12, pos.left + width / 2 < vw / 2 ? pos.left + width * 0.2 : pos.left + width * 0.8 - pw)),
    ...(below ? { top: pos.top + height * 0.92 } : { bottom: vh - pos.top - height * 0.12 }),
    height: Math.min(popoverHeight, below ? vh - pos.top - height - 12 : pos.top + height * 0.12 - 12),
  }
  return (
    <>
    <div
      ref={wrap}
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-hidden={!visible || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={() => onPointerUp()}
      onPointerCancel={() => onPointerUp(true)}
      onLostPointerCapture={() => onPointerUp(true)}
      onKeyDown={onKeyDown}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      style={{
        position: 'fixed',
        display: visible ? undefined : 'none',
        left: pos.left,
        top: pos.top,
        width,
        height,
        zIndex,
        cursor: drag ? 'grabbing' : 'pointer',
        touchAction: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        outline: 'none',
        transition: drag ? 'none' : 'left .5s cubic-bezier(.34,1.56,.64,1), top .5s cubic-bezier(.34,1.56,.64,1)',
      }}
    >
      <div ref={host} style={{ width: '100%', height: '100%' }} />
      {onHide && (
        <button
          type="button"
          data-mo-close=""
          aria-label="Put Mo away in the logo"
          onClick={(e) => {
            e.stopPropagation()
            onHide()
          }}
          style={{
            position: 'absolute',
            top: '8%',
            right: '-2%',
            width: 20,
            height: 20,
            borderRadius: '50%',
            border: '1px solid var(--mo-line, #33343a)',
            background: 'var(--mo-bubble-bg, #1d1e23)',
            color: 'var(--mo-muted, #8a8d94)',
            font: '11px/1 system-ui, sans-serif',
            display: 'grid',
            placeItems: 'center',
            cursor: 'pointer',
            padding: 0,
            opacity: hover && !drag ? 1 : 0,
            pointerEvents: hover && !drag ? 'auto' : 'none',
            transition: 'opacity .15s',
          }}
        >
          ✕
        </button>
      )}
      {bubbleText && !popover && (
        <div
          role="status"
          style={{
            position: 'absolute',
            ...bubbleSide,
            ...bubbleV,
            width: 'max-content',
            maxWidth: 240,
            padding: '7px 10px',
            borderRadius: 12,
            background: 'var(--mo-bubble-bg, #1d1e23)',
            border: '1px solid var(--mo-line, #33343a)',
            color: 'var(--mo-bubble-fg, #e6e7ea)',
            font: '12.5px/1.4 Inter, system-ui, sans-serif',
            boxShadow: '0 8px 24px rgba(0,0,0,.35)',
            pointerEvents: 'none',
          }}
        >
          {bubbleText}
        </div>
      )}
    </div>
    {visible && popover && !drag && <div data-mo-pop="" style={popStyle}>{popover}</div>}
    </>
  )
}
