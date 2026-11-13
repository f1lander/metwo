import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// Figma frames linked in a ticket, turned into what a lane can use: the frame rendered as PNG and a
// plain-text spec (sizes, auto-layout, colors, type, radii, components and style names). The token
// stays in the daemon; the lane only gets files.

const API = 'https://api.figma.com/v1'
const MAX_FRAMES = 4
const MAX_NODES = 180

export interface FigmaLink {
  readonly url: string
  readonly fileKey: string
  readonly nodeId: string | null
}

export interface FigmaFrame {
  readonly url: string
  readonly name: string
  readonly image: string | null
  readonly spec: string
  readonly size: string
}

const LINK = /https:\/\/(?:www\.)?figma\.com\/(?:design|file|proto|board)\/([A-Za-z0-9]{10,})(?:\/branch\/([A-Za-z0-9]{10,}))?[^\s)"'<>\]]*/g

export function figmaLinks(...texts: readonly string[]): FigmaLink[] {
  const out = new Map<string, FigmaLink>()
  for (const text of texts) {
    for (const m of text.matchAll(LINK)) {
      const url = m[0].replace(/[.,;]+$/, '')
      const fileKey = m[2] ?? m[1] ?? ''
      const raw = new URL(url).searchParams.get('node-id')
      const nodeId = raw ? decodeURIComponent(raw).replace('-', ':') : null
      out.set(`${fileKey}:${nodeId ?? ''}`, { url, fileKey, nodeId })
    }
  }
  return [...out.values()]
}

async function get<T>(token: string, url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'X-Figma-Token': token }, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`Figma ${res.status}: ${(await res.text()).slice(0, 200)}`)
  return (await res.json()) as T
}

export async function figmaMe(token: string): Promise<string> {
  const me = await get<{ handle?: string; email?: string }>(token, `${API}/me`)
  return me.handle ?? me.email ?? 'signed in'
}

type Paint = { type: string; visible?: boolean; color?: { r: number; g: number; b: number; a: number }; opacity?: number }
interface Node {
  id: string
  name: string
  type: string
  visible?: boolean
  children?: Node[]
  absoluteBoundingBox?: { width: number; height: number } | null
  fills?: Paint[]
  strokes?: Paint[]
  strokeWeight?: number
  cornerRadius?: number
  rectangleCornerRadii?: number[]
  layoutMode?: 'NONE' | 'HORIZONTAL' | 'VERTICAL'
  itemSpacing?: number
  paddingLeft?: number
  paddingRight?: number
  paddingTop?: number
  paddingBottom?: number
  primaryAxisAlignItems?: string
  counterAxisAlignItems?: string
  characters?: string
  style?: { fontFamily?: string; fontSize?: number; fontWeight?: number; lineHeightPx?: number; letterSpacing?: number; textCase?: string }
  styles?: Record<string, string>
  componentId?: string
  opacity?: number
  effects?: { type: string; visible?: boolean; radius?: number }[]
}

const hex = (p: Paint | undefined): string | null => {
  if (!p || p.visible === false || p.type !== 'SOLID' || !p.color) return p && p.visible !== false && p.type.startsWith('GRADIENT') ? 'gradient' : null
  const c = p.color
  const h = [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')
  const a = (p.opacity ?? 1) * c.a
  return `#${h.toUpperCase()}${a < 0.995 ? ` ${Math.round(a * 100)}%` : ''}`
}
const n = (v: number | undefined) => (v === undefined ? '' : String(Math.round(v * 10) / 10))

function describe(node: Node, styles: Record<string, { name: string }>, components: Record<string, { name: string }>): string {
  const bits: string[] = []
  const box = node.absoluteBoundingBox
  if (box) bits.push(`${n(box.width)}×${n(box.height)}`)
  if (node.type === 'INSTANCE' && node.componentId && components[node.componentId]) bits.push(`instance of "${components[node.componentId]?.name}"`)
  if (node.layoutMode && node.layoutMode !== 'NONE') {
    const pad = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft].map((v) => n(v ?? 0)).join('/')
    bits.push(`auto-layout ${node.layoutMode.toLowerCase()} gap ${n(node.itemSpacing ?? 0)} padding ${pad}${node.primaryAxisAlignItems ? ` align ${node.primaryAxisAlignItems.toLowerCase()}` : ''}`)
  }
  const fill = hex(node.fills?.find((f) => f.visible !== false))
  if (fill && node.type !== 'TEXT') bits.push(`fill ${fill}`)
  const stroke = hex(node.strokes?.find((f) => f.visible !== false))
  if (stroke) bits.push(`border ${n(node.strokeWeight ?? 1)} ${stroke}`)
  if (node.cornerRadius) bits.push(`radius ${n(node.cornerRadius)}`)
  else if (node.rectangleCornerRadii?.some((r) => r > 0)) bits.push(`radius ${node.rectangleCornerRadii.map(n).join('/')}`)
  if (node.opacity !== undefined && node.opacity < 1) bits.push(`opacity ${Math.round(node.opacity * 100)}%`)
  const shadow = node.effects?.find((e) => e.visible !== false && e.type.includes('SHADOW'))
  if (shadow) bits.push(`shadow ${n(shadow.radius)}`)
  if (node.type === 'TEXT') {
    const s = node.style ?? {}
    bits.push(`"${(node.characters ?? '').replace(/\s+/g, ' ').slice(0, 80)}"`, `${s.fontFamily ?? ''} ${n(s.fontSize)}/${n(s.lineHeightPx)} ${s.fontWeight ?? ''}`.trim())
    if (fill) bits.push(`color ${fill}`)
  }
  const named = Object.entries(node.styles ?? {}).flatMap(([k, id]) => (styles[id] ? [`${k} style "${styles[id]?.name}"`] : []))
  bits.push(...named)
  return `${node.type} "${node.name}"${bits.length ? ` · ${bits.join(' · ')}` : ''}`
}

function specOf(root: Node, styles: Record<string, { name: string }>, components: Record<string, { name: string }>): string {
  const lines: string[] = []
  const walk = (node: Node, depth: number) => {
    if (lines.length >= MAX_NODES || node.visible === false) return
    lines.push(`${'  '.repeat(depth)}- ${describe(node, styles, components)}`)
    // an instance's insides are the component's: its name says enough past two levels
    if (depth < 8 && !(node.type === 'INSTANCE' && depth > 1)) for (const c of node.children ?? []) walk(c, depth + 1)
  }
  walk(root, 0)
  if (lines.length >= MAX_NODES) lines.push(`- … (stopped at ${MAX_NODES} layers)`)
  return lines.join('\n')
}

// Renders and describes each linked frame into dir. Links to a whole file (no node-id) are noted, not rendered.
export async function fetchFrames(token: string, links: readonly FigmaLink[], dir: string): Promise<{ frames: FigmaFrame[]; skipped: string[] }> {
  mkdirSync(dir, { recursive: true })
  const frames: FigmaFrame[] = []
  const skipped: string[] = []
  for (const [i, link] of links.slice(0, MAX_FRAMES).entries()) {
    if (!link.nodeId) {
      skipped.push(`${link.url} (links the whole file, not a frame: copy the link to a frame)`)
      continue
    }
    try {
      const ids = encodeURIComponent(link.nodeId)
      const data = await get<{ nodes: Record<string, { document: Node; styles?: Record<string, { name: string }>; components?: Record<string, { name: string }> } | null> }>(token, `${API}/files/${link.fileKey}/nodes?ids=${ids}`)
      const node = data.nodes[link.nodeId]
      if (!node) throw new Error('frame not found (deleted, or no access with this token)')
      const spec = specOf(node.document, node.styles ?? {}, node.components ?? {})
      const box = node.document.absoluteBoundingBox
      const base = `${String(i + 1).padStart(2, '0')}-${node.document.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'frame'}`
      writeFileSync(path.join(dir, `${base}.md`), `# ${node.document.name}\n${link.url}\n\n${spec}\n`)
      let image: string | null = null
      const render = await get<{ images: Record<string, string | null> }>(token, `${API}/images/${link.fileKey}?ids=${ids}&scale=2&format=png`).catch(() => null)
      const src = render?.images[link.nodeId]
      if (src) {
        const res = await fetch(src, { signal: AbortSignal.timeout(30_000) })
        if (res.ok) {
          image = path.join(dir, `${base}.png`)
          writeFileSync(image, Buffer.from(await res.arrayBuffer()))
        }
      }
      frames.push({ url: link.url, name: node.document.name, image, spec: path.join(dir, `${base}.md`), size: box ? `${Math.round(box.width)}×${Math.round(box.height)}` : '' })
    } catch (error) {
      skipped.push(`${link.url} (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  if (links.length > MAX_FRAMES) skipped.push(`${links.length - MAX_FRAMES} more link(s) not fetched`)
  return { frames, skipped }
}

// The brief section: look at the frames before building, use the repo's tokens, compare at the end.
export function figmaSection(frames: readonly FigmaFrame[], skipped: readonly string[], shotsDir: string): string {
  if (!frames.length && !skipped.length) return ''
  return [
    '## Design reference (Figma)',
    'The ticket links these Figma frames. They are the target for anything visible. Before writing UI code, open each image with the Read tool and read its spec. Build it with the components and design tokens the repo already has (match the spec\'s colors, spacing, radii and type to the closest token, never hard-code a value when a token exists); note in ARM-SUMMARY.md under Design decisions where the code and Figma differ on purpose.',
    ...frames.map((f) => `- ${f.name}${f.size ? ` (${f.size})` : ''}: ${f.image ? `image ${f.image}, ` : ''}spec ${f.spec}\n  ${f.url}`),
    skipped.length ? `Not fetched:\n${skipped.map((s) => `- ${s}`).join('\n')}` : '',
    `In the visual check, shoot the after state at the frame's width (or the closest viewport), save it next to the reference in ${shotsDir}/, compare them element by element (layout, spacing, sizes, colors, type, states), and add a check "Matches Figma: <frame>" to VISUAL.json: pass only when they match, otherwise list what differs in its note.`,
  ]
    .filter(Boolean)
    .join('\n\n')
}
