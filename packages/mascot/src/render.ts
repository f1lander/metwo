import { DEFAULT_POSE, clamp, type PoseInput } from './pose.js'
import { COLORS, HOLE, PUPIL, RING, VIEWBOX } from './shape.js'

const NS = 'http://www.w3.org/2000/svg'
let uid = 0

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag)
  for (const k in attrs) e.setAttribute(k, String(attrs[k]))
  parent.appendChild(e)
  return e
}

// Draws Mo into an SVG group; set(pose) moves it. No framework, no animation loop of its own.
export class MascotRenderer {
  private readonly clip: SVGPathElement
  private readonly shadowEl: SVGEllipseElement
  private readonly body: SVGGElement
  private readonly tankEl: SVGPathElement
  private readonly fillEl: SVGPathElement
  private readonly pupilG: SVGGElement
  private readonly pupil: SVGCircleElement
  private readonly ov: SVGGElement
  private readonly qEl: SVGTextElement
  private readonly zs: SVGTextElement[]
  private readonly dotEls: SVGCircleElement[]
  private readonly sparkEls: SVGLineElement[]
  private readonly sweatEl: SVGPathElement
  private readonly cupEl: SVGGElement

  constructor(root: SVGGElement | SVGSVGElement) {
    const id = `mo-${++uid}`
    const defs = el('defs', {}, root)
    const cp = el('clipPath', { id: `${id}-c` }, defs)
    this.clip = el('path', {}, cp)
    this.shadowEl = el('ellipse', { cx: 0, cy: 300, rx: 115, ry: 13, fill: COLORS.shadow }, root)
    this.body = el('g', {}, root)
    this.tankEl = el('path', { d: RING, fill: COLORS.tank }, this.body)
    this.fillEl = el('path', { d: RING, fill: COLORS.accent, 'clip-path': `url(#${id}-c)` }, this.body)
    this.pupilG = el('g', {}, this.body)
    this.pupil = el('circle', { cx: PUPIL.cx, cy: PUPIL.cy, r: PUPIL.r, fill: COLORS.pupil }, this.pupilG)
    this.ov = el('g', { 'font-family': 'Inter, system-ui, sans-serif', 'font-weight': 700 }, root)
    this.qEl = el('text', { x: 118, y: -18, 'font-size': 64, fill: COLORS.amber }, this.ov)
    this.qEl.textContent = '?'
    this.zs = [0, 1, 2].map(() => {
      const z = el('text', { fill: COLORS.z }, this.ov)
      z.textContent = 'z'
      return z
    })
    this.dotEls = [0, 1, 2].map((i) => el('circle', { cx: 96 + i * 26, cy: -6 - i * 14, r: 9 + i * 2, fill: COLORS.soft }, this.ov))
    this.sparkEls = Array.from({ length: 8 }, () => el('line', { stroke: COLORS.amber, 'stroke-width': 11, 'stroke-linecap': 'round' }, this.ov))
    this.sweatEl = el('path', { d: 'M0 -22 C 10 -6 14 4 14 10 a14 14 0 0 1 -28 0 C -14 4 -10 -6 0 -22 Z', fill: COLORS.sweat }, this.ov)
    this.cupEl = el('g', {}, this.ov)
    el('path', { d: 'M-26 -24 h52 l-6 46 a8 8 0 0 1 -8 7 h-24 a8 8 0 0 1 -8 -7 Z', fill: COLORS.ink }, this.cupEl)
    el('path', { d: 'M26 -12 h8 a12 12 0 0 1 0 24 h-10', fill: 'none', stroke: COLORS.ink, 'stroke-width': 7 }, this.cupEl)
    el('path', { d: 'M-10 -36 q6 -8 0 -16 M8 -36 q6 -8 0 -16', fill: 'none', stroke: '#8a8d94', 'stroke-width': 5, 'stroke-linecap': 'round' }, this.cupEl)
    this.set({})
  }

  // a frosted disk under the SVG, in the hole: an SVG can't blur what is behind it, so a div with
  // backdrop-filter follows the body's transform instead
  frost: HTMLElement | null = null

  private place(q: { x: number; y: number; rot: number; sx: number; sy: number }): void {
    const f = this.frost
    const host = f?.parentElement
    if (!f || !host) return
    const k = host.clientWidth / VIEWBOX.w
    if (!k) return
    // the body's transform: translate(x y) rotate(rot 0 137) translate(0 273) scale(sx sy) translate(0 -273)
    const r = (q.rot * Math.PI) / 180
    const cos = Math.cos(r)
    const sin = Math.sin(r)
    const a = cos * q.sx
    const b = sin * q.sx
    const c = -sin * q.sy
    const d = cos * q.sy
    // where the hole's top-left corner lands, in the viewBox
    const ox = HOLE.cx - HOLE.r
    const oy = HOLE.cy - HOLE.r - 273
    const sx = ox * q.sx
    const sy = oy * q.sy + 273 - 137
    const px = cos * sx - sin * sy + q.x
    const py = sin * sx + cos * sy + 137 + q.y
    f.style.width = f.style.height = `${HOLE.r * 2 * k}px`
    f.style.transform = `matrix(${a.toFixed(4)}, ${b.toFixed(4)}, ${c.toFixed(4)}, ${d.toFixed(4)}, ${((px - VIEWBOX.x) * k).toFixed(2)}, ${((py - VIEWBOX.y) * k).toFixed(2)})`
  }

  set(input: PoseInput): void {
    const q = { ...DEFAULT_POSE, ...input }
    this.body.setAttribute('transform', `translate(${q.x} ${q.y}) rotate(${q.rot} 0 137) translate(0 273) scale(${q.sx} ${q.sy}) translate(0 -273)`)
    this.place(q)
    this.fillEl.setAttribute('fill', q.color)
    this.tankEl.setAttribute('fill', q.tank)
    const level = 276 - clamp(q.fill, 0, 1) * 282
    const a = q.fill <= 0.001 || q.fill >= 0.995 ? 0 : q.wa
    let d = `M-170 ${level}`
    for (let x = -170; x <= 170; x += 20) d += ` L${x} ${(level + a * Math.sin(x / 26 + q.wave)).toFixed(1)}`
    this.clip.setAttribute('d', `${d} L170 340 L-170 340 Z`)
    this.pupilG.setAttribute('transform', `translate(${q.px} ${q.py})`)
    const psx = q.pr * (1 + q.lid * 0.25)
    const psy = Math.max(0.06, q.pr * (1 - q.lid * 0.92))
    this.pupil.setAttribute('transform', `translate(0 ${PUPIL.cy}) scale(${psx.toFixed(3)} ${psy.toFixed(3)}) translate(0 ${-PUPIL.cy})`)
    const lift = clamp(-q.y / 220, 0, 1)
    this.shadowEl.setAttribute('rx', (115 * (1 - lift * 0.45) * q.sx).toFixed(1))
    this.shadowEl.setAttribute('opacity', (q.shadow * 0.5 * (1 - lift * 0.6)).toFixed(2))
    this.ov.setAttribute('transform', `translate(${q.x} ${q.y})`)
    this.qEl.setAttribute('opacity', String(q.q))
    this.qEl.setAttribute('transform', `translate(0 ${q.qy})`)
    this.zs.forEach((z, i) => {
      if (q.z < 0) return z.setAttribute('opacity', '0')
      const ph = (((q.z + i / 3) % 1) + 1) % 1
      z.setAttribute('x', String(112 + ph * 34))
      z.setAttribute('y', String(10 - ph * 120))
      z.setAttribute('font-size', String(26 + ph * 26))
      z.setAttribute('opacity', Math.sin(Math.PI * ph).toFixed(2))
    })
    this.dotEls.forEach((c, i) => c.setAttribute('opacity', i < q.dots ? '1' : '0'))
    this.sparkEls.forEach((l, i) => {
      const s = q.sparks
      if (s <= 0 || s >= 1) return l.setAttribute('opacity', '0')
      const ang = (i / 8) * Math.PI * 2
      const r1 = 165 + 60 * s
      const r2 = r1 + 34 * (1 - s)
      l.setAttribute('x1', String(Math.cos(ang) * r1))
      l.setAttribute('y1', String(137 + Math.sin(ang) * r1))
      l.setAttribute('x2', String(Math.cos(ang) * r2))
      l.setAttribute('y2', String(137 + Math.sin(ang) * r2))
      l.setAttribute('opacity', (1 - s).toFixed(2))
    })
    this.sweatEl.setAttribute('opacity', String(q.sweat))
    this.sweatEl.setAttribute('transform', `translate(128 ${44 + q.sweatY})`)
    this.cupEl.setAttribute('opacity', String(q.cup))
    this.cupEl.setAttribute('transform', `translate(150 18) rotate(${q.cupRot})`)
  }
}

// An <svg> with Mo in it, appended to `host`.
export function createMascot(host: Element, opts: { title?: string } = {}): { svg: SVGSVGElement; renderer: MascotRenderer; destroy: () => void } {
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('viewBox', `${VIEWBOX.x} ${VIEWBOX.y} ${VIEWBOX.w} ${VIEWBOX.h}`)
  svg.setAttribute('overflow', 'visible')
  if (opts.title) {
    svg.setAttribute('role', 'img')
    svg.setAttribute('aria-label', opts.title)
  } else svg.setAttribute('aria-hidden', 'true')
  // the frosted hole sits under the SVG; the host is the positioning box
  const frost = document.createElement('div')
  frost.setAttribute('aria-hidden', 'true')
  Object.assign(frost.style, { position: 'absolute', left: '0', top: '0', borderRadius: '50%', transformOrigin: '0 0', pointerEvents: 'none', background: 'rgba(17, 18, 22, 0.35)', backdropFilter: 'blur(10px) saturate(1.2)', webkitBackdropFilter: 'blur(10px) saturate(1.2)' })
  if (host instanceof HTMLElement && getComputedStyle(host).position === 'static') host.style.position = 'relative'
  host.appendChild(frost)
  host.appendChild(svg)
  svg.style.position = 'relative'
  const renderer = new MascotRenderer(svg)
  renderer.frost = frost
  renderer.set({})
  return {
    svg,
    renderer,
    destroy: () => {
      svg.remove()
      frost.remove()
    },
  }
}
