import { useSyncExternalStore } from 'react'

// Mo's place in the app: out floating, or put away in the logo. The logo's ring is where he flies.
const KEY = 'mevo.mo.hidden'
let hidden = (() => {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
})()
let ring: SVGPathElement | null = null
let present = false
let summons = 0
const subs = new Set<() => void>()

export const mascot = {
  hidden: () => hidden,
  setHidden(v: boolean) {
    hidden = v
    try {
      localStorage.setItem(KEY, v ? '1' : '0')
    } catch {
      // not remembered
    }
    subs.forEach((f) => f())
  },
  // on screen right now (not docked, not stuck off an edge)
  present: () => present,
  setPresent(v: boolean) {
    present = v
  },
  // the logo's job: bring him out, whatever state he is in
  summon() {
    summons += 1
    mascot.setHidden(false)
  },
  ring: () => ring,
  setRing(el: SVGPathElement | null) {
    if (el) ring = el
  },
}

export function useSummons(): number {
  return useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => summons,
  )
}

export function useMascotHidden(): boolean {
  return useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => hidden,
  )
}

// What a click on Mo does: the ticket page opens its chat; elsewhere Today's ask box.
export const TELL_EVENT = 'mevo:tell'
export const ASK_EVENT = 'mevo:ask'
