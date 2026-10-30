import { useSyncExternalStore } from 'react'

// Linear's label colors, filled from the daemon's snapshot and label events.
let colors: Readonly<Record<string, string>> = {}
const listeners = new Set<() => void>()

export function setLabelColors(next: Readonly<Record<string, string>> | undefined): void {
  if (!next) return
  colors = { ...colors, ...next }
  for (const l of listeners) l()
}

export function useLabelColor(name: string): string | undefined {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => colors[name],
  )
}
