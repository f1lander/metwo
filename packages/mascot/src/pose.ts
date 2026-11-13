import { COLORS } from './shape.js'

// Everything a frame needs. Overlays are 0..1 opacities unless noted.
export interface Pose {
  readonly x: number
  readonly y: number
  readonly sx: number
  readonly sy: number
  readonly rot: number
  // pupil offset and scale; lid 0 open .. 1 closed (the logo's wink: scaleY .08, scaleX 1.25)
  readonly px: number
  readonly py: number
  readonly pr: number
  readonly lid: number
  // energy: how full the ring is, 0..1, with a wave on top
  readonly fill: number
  readonly wave: number
  readonly wa: number
  readonly color: string
  readonly tank: string
  readonly shadow: number
  readonly q: number
  readonly qy: number
  // z: phase of the rising z's, -1 for none
  readonly z: number
  // dots: how many thinking dots, 0..3
  readonly dots: number
  // sparks: burst progress 0..1
  readonly sparks: number
  readonly sweat: number
  readonly sweatY: number
  readonly cup: number
  readonly cupRot: number
}

export type PoseInput = Partial<Pose>

export const DEFAULT_POSE: Pose = { x: 0, y: 0, sx: 1, sy: 1, rot: 0, px: 0, py: 0, pr: 1, lid: 0, fill: 1, wave: 0, wa: 3, color: COLORS.accent, tank: COLORS.tank, shadow: 1, q: 0, qy: 0, z: -1, dots: 0, sparks: 0, sweat: 0, sweatY: 0, cup: 0, cupRot: 0 }

export const ease = (x: number): number => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2)
export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))

// eased keyframes: keys(t, [0, 1, 2], [0, 10, 0])
export function keys(t: number, ts: readonly number[], vs: readonly number[]): number {
  const first = vs[0] ?? 0
  if (t <= (ts[0] ?? 0)) return first
  for (let i = 1; i < ts.length; i++) {
    const t1 = ts[i] as number
    if (t <= t1) {
      const t0 = ts[i - 1] as number
      const v0 = vs[i - 1] as number
      const v1 = vs[i] as number
      return v0 + (v1 - v0) * ease((t - t0) / (t1 - t0))
    }
  }
  return vs[vs.length - 1] ?? first
}

// the wink the logo does: closes over .35 of the time, holds, opens
export function blink(t: number, at: number, d = 0.42): number {
  const u = (t - at) / d
  return u < 0 || u > 1 ? 0 : keys(u, [0, 0.35, 0.6, 1], [0, 1, 1, 0])
}

export const breathe = (t: number, s = 3.2, a = 0.014): PoseInput => {
  const b = Math.sin((2 * Math.PI * t) / s)
  return { sx: 1 - a * 0.6 * b, sy: 1 + a * b }
}

export type MascotStateId = 'idle' | 'look' | 'working' | 'thinking' | 'focus' | 'asking' | 'failed' | 'merged' | 'sleep' | 'drag' | 'coffee' | 'tired' | 'empty'

export interface MascotState {
  readonly id: MascotStateId
  readonly name: string
  // loop length in seconds
  readonly dur: number
  readonly pose: (t: number) => PoseInput
}

const s = (id: MascotStateId, name: string, dur: number, pose: (t: number) => PoseInput): MascotState => ({ id, name, dur, pose })

export const STATES: Readonly<Record<MascotStateId, MascotState>> = {
  idle: s('idle', 'Idle', 6, (t) => ({ ...breathe(t), px: keys(t, [0, 1, 1.5, 2.8, 3.3, 4.6, 5.2], [0, 0, -22, -22, 18, 18, 0]), py: keys(t, [0, 1.5, 3.3, 5.2], [0, 4, -3, 0]), lid: Math.max(blink(t, 2.1), blink(t, 5.4)) })),
  look: s('look', 'Looking around', 4, (t) => ({ ...breathe(t, 2), px: keys(t, [0, 0.4, 1.1, 1.5, 2.3, 2.7], [0, -30, -30, 30, 30, 0]), lid: Math.max(blink(t, 3.0, 0.32), blink(t, 3.42, 0.32)) })),
  working: s('working', 'Working', 3.2, (t) => {
    const ph = (t % 0.8) / 0.8
    const h = Math.sin(Math.PI * ph)
    const g = clamp(1 - h / 0.28, 0, 1)
    return { y: -64 * h, sy: 1 - 0.13 * g + 0.06 * h * (1 - g), sx: 1 + 0.11 * g - 0.04 * h, px: keys(t, [0, 0.8, 1.6, 2.4, 3.2], [0, -18, 0, 18, 0]), lid: blink(t, 2.95, 0.25) }
  }),
  thinking: s('thinking', 'Thinking', 3.6, (t) => ({ ...breathe(t), rot: keys(t, [0, 0.5, 3, 3.5], [0, 8, 8, 0]), px: keys(t, [0, 0.5, 3, 3.5], [0, 22, 22, 0]), py: keys(t, [0, 0.5, 3, 3.5], [0, -26, -26, 0]), dots: t > 0.6 && t < 3.1 ? 1 + (Math.floor((t - 0.6) / 0.45) % 3) : 0, lid: blink(t, 3.2) })),
  focus: s('focus', 'Focused', 2.8, (t) => ({ ...breathe(t, 1.4, 0.01), pr: 0.64, lid: keys(t, [0, 0.3, 2.4, 2.8], [0, 0.42, 0.42, 0]), x: t > 0.5 && t < 2.2 ? 1.8 * Math.sin(t * 46) : 0, sweat: keys(t, [0, 0.8, 1.1, 2.1, 2.4], [0, 0, 1, 1, 0]), sweatY: keys(t, [0.8, 2.4], [0, 46]) })),
  asking: s('asking', 'Asking you', 1.6, (t) => {
    const hop = t < 0.7 ? Math.sin(Math.PI * ((t % 0.35) / 0.35)) : 0
    return { y: -30 * hop, sy: 1 + 0.04 * hop, color: COLORS.amber, pr: 1.14, py: -3, q: 1, qy: -6 * Math.sin(t * 4), lid: blink(t, 1.15, 0.3) }
  }),
  failed: s('failed', 'Something failed', 3, (t) => ({ x: t < 0.5 ? 9 * Math.sin(t * 62) * (1 - t / 0.5) : 0, sy: keys(t, [0, 0.5, 2.6, 3], [1, 0.92, 0.92, 1]), sx: keys(t, [0, 0.5, 2.6, 3], [1, 1.05, 1.05, 1]), color: COLORS.bad, py: keys(t, [0, 0.5, 2.6, 3], [0, 26, 26, 0]), px: -6, lid: keys(t, [0, 0.5, 2.6, 3], [0, 0.32, 0.32, 0]), sweat: keys(t, [0, 0.6, 2.4, 2.8], [0, 1, 1, 0]), sweatY: keys(t, [0.6, 2.6], [0, 30]) })),
  merged: s('merged', 'Celebrating', 2.4, (t) => {
    const j = clamp((t - 0.3) / 0.8, 0, 1)
    const air = t > 0.3 && t < 1.1
    const landing = t >= 1.1 && t < 1.4
    return {
      y: air ? -150 * Math.sin(Math.PI * j) : 0,
      rot: 360 * ease(j),
      sy: t < 0.3 ? keys(t, [0, 0.3], [1, 0.84]) : landing ? keys(t, [1.1, 1.22, 1.4], [0.82, 1.05, 1]) : air ? 1.05 : 1,
      sx: t < 0.3 ? keys(t, [0, 0.3], [1, 1.1]) : landing ? keys(t, [1.1, 1.22, 1.4], [1.12, 0.97, 1]) : 1,
      sparks: (t - 0.55) / 0.7,
      pr: 1.12,
      lid: blink(t, 1.9, 0.3),
    }
  }),
  sleep: s('sleep', 'Asleep', 4, (t) => ({ ...breathe(t, 4, 0.03), lid: 1, py: 6, z: t / 4 })),
  drag: s('drag', 'Being dragged', 2.4, (t) => {
    const c = Math.cos((2 * Math.PI * t) / 2.4)
    return { x: 64 * Math.sin((2 * Math.PI * t) / 2.4), y: -28, rot: 12 * c, sx: 1 + 0.13 * Math.abs(c), sy: 1 - 0.08 * Math.abs(c), px: 24 * c, pr: 1.08 }
  }),
  coffee: s('coffee', 'Coffee', 4, (t) => {
    const hyper = t > 2.1
    const h = hyper ? Math.sin(Math.PI * ((t % 0.26) / 0.26)) : 0
    return { cup: keys(t, [0, 0.2, 1.7, 2.0], [0, 1, 1, 0]), cupRot: keys(t, [0.3, 0.8, 1.6], [0, -28, 0]), fill: keys(t, [0, 0.6, 2.0], [0.12, 0.12, 1]), wave: t * 7, wa: 6, y: -22 * h, sy: 1 + 0.04 * h, pr: hyper ? 1.24 : keys(t, [0, 0.6, 2], [0.9, 0.9, 1.1]), px: hyper ? 6 * Math.sin(t * 30) : 0, lid: t < 0.6 ? 0.3 : 0 }
  }),
  tired: s('tired', 'Tired', 5, (t) => ({ ...breathe(t, 5, 0.02), fill: 0.16, rot: keys(t, [0, 2.6, 3.4, 3.6, 5], [3, 6, 11, 2, 3]), lid: Math.max(0.52, keys(t, [2.4, 3.2, 3.5, 3.6], [0.52, 1, 1, 0.2])), py: 8, px: -4 })),
  empty: s('empty', 'Out of coffee', 4, (t) => ({ fill: 0, sy: 0.9 + 0.01 * Math.sin(t * 1.6), sx: 1.06, rot: -4, lid: 0.76, py: 12, cup: 0.35 + 0.65 * Math.abs(Math.sin(t * 1.8)), cupRot: -10 })),
}
