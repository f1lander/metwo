import { STATES, clamp, keys, type MascotStateId, type PoseInput } from './pose.js'

// What is going on around Mo. Times are seconds on the same clock as `t`.
export interface Mood {
  readonly energy: number
  // false: the coffee game is off, Mo stays full and never gets tired
  readonly coffee?: boolean
  readonly working?: boolean
  readonly asking?: boolean
  readonly sleeping?: boolean
  // a short reaction on top of everything else: 'merged', 'failed'...
  readonly flash?: { readonly state: MascotStateId; readonly at: number } | null
  readonly drag?: { readonly vx: number; readonly vy: number } | null
  readonly landedAt?: number
  readonly sipAt?: number
  readonly hyperUntil?: number
  // where the pupil should look, as an offset from the eye in px (follows the cursor)
  readonly look?: { readonly dx: number; readonly dy: number } | null
}

export const TIRED_BELOW = 0.25
const at = (id: MascotStateId, t: number) => STATES[id].pose(t % STATES[id].dur)

// The pose for this moment: dragging, landing, a reaction, coffee, empty, working (with a gesture
// now and then), tired, or idle following the cursor.
export function autoPose(t: number, m: Mood): PoseInput {
  const energy = m.coffee === false ? 1 : clamp(m.energy, 0, 1)
  const base: PoseInput = { fill: energy, wave: t * 2.4 }
  if (m.drag) {
    const sp = Math.min(1, Math.hypot(m.drag.vx, m.drag.vy) / 1800)
    return { y: -26, rot: clamp(m.drag.vx / 60, -18, 18), sx: 1 + 0.14 * sp, sy: 1 - 0.09 * sp, px: clamp(m.drag.vx / 40, -26, 26), py: clamp(m.drag.vy / 60, -18, 18), pr: 1.08, fill: energy, wave: t * 6, wa: 3 + sp * 6 }
  }
  const landed = m.landedAt ?? -99
  if (t >= landed && t < landed + 0.3) return { ...base, sy: keys(t, [landed, landed + 0.1, landed + 0.3], [0.86, 1.04, 1]), sx: keys(t, [landed, landed + 0.1, landed + 0.3], [1.1, 0.98, 1]) }
  if (m.flash && t - m.flash.at < STATES[m.flash.state].dur) return { ...STATES[m.flash.state].pose(t - m.flash.at), fill: energy }
  if (t < (m.hyperUntil ?? -99)) {
    const h = Math.sin(Math.PI * ((t % 0.26) / 0.26))
    return { ...base, y: -22 * h, sy: 1 + 0.04 * h, pr: 1.24, px: 6 * Math.sin(t * 30), wave: t * 8, wa: 5 }
  }
  const sip = t - (m.sipAt ?? -99)
  if (sip >= 0 && sip < 0.9) {
    const u = sip / 0.9
    return { ...base, cup: keys(u, [0, 0.15, 0.75, 1], [0, 1, 1, 0]), cupRot: keys(u, [0.1, 0.45, 0.8], [0, -28, 0]), y: -16 * Math.sin(Math.PI * u), wave: t * 9, wa: 7, lid: u < 0.4 ? 0.3 : 0 }
  }
  if (m.sleeping) return { ...at('sleep', t), fill: energy }
  if (energy <= 0) return at('empty', t)
  if (m.asking) return { ...at('asking', t), fill: energy }
  const tired = energy < TIRED_BELOW
  if (m.working) {
    // every 12 s: 6 s bouncing, a thinking gesture, then a focused one
    const c = t % 12
    if (c > 6 && c < 9.6) return { ...at('thinking', c - 6), fill: energy, wave: t * 3 }
    if (c >= 9.6 && c < 12 && !tired) return { ...at('focus', c - 9.6), fill: energy, wave: t * 3 }
    const p = at('working', tired ? t / 1.35 : t)
    return { ...p, y: (p.y ?? 0) * (tired ? 0.6 : 1), fill: energy, wave: t * 3, lid: tired ? Math.max(0.45, p.lid ?? 0) : p.lid ?? 0 }
  }
  if (tired) return { ...at('tired', t), fill: energy }
  const p = { ...at(t % 20 > 14 ? 'look' : 'idle', t), ...base }
  if (m.look && t % 20 <= 14) {
    const d = Math.hypot(m.look.dx, m.look.dy) || 1
    const r = Math.min(30, d / 10)
    return { ...p, px: (m.look.dx / d) * r, py: (m.look.dy / d) * r * 0.8 }
  }
  return p
}
