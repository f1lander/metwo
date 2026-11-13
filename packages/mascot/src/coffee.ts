// The coffee game, without any DOM: work drains Mo, clicks refill him, empty blocks new lanes.
export const COFFEE = {
  // closing an issue (a ticket done)
  issue: 0.18,
  // one turn of a lane
  turn: 0.03,
  // one click
  sip: 0.1,
  // clicks within this many ms are coffee, a single click is a press
  multiClickMs: 320,
  // after filling up, how long Mo stays fast
  hyperSeconds: 2.6,
} as const

export const drink = (energy: number, sips = 1): number => Math.min(1, Math.max(0, energy) + COFFEE.sip * sips)
export const drain = (energy: number, amount: number): number => Math.max(0, energy - amount)
export const isEmpty = (energy: number): boolean => energy <= 0.0001
