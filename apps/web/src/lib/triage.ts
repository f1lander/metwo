import type { Triage } from '@ticketflow/shared'
import { useSyncExternalStore } from 'react'

// The AI triage per issue, from the daemon's snapshot and triage events.
let map: Readonly<Record<string, Triage>> = {}
const listeners = new Set<() => void>()
const subscribe = (cb: () => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function setTriage(next: Readonly<Record<string, Triage>> | undefined): void {
  if (!next) return
  map = { ...map, ...next }
  for (const l of listeners) l()
}

export const useTriage = (id: string): Triage | undefined => useSyncExternalStore(subscribe, () => map[id])
export const useTriageMap = (): Readonly<Record<string, Triage>> => useSyncExternalStore(subscribe, () => map)
