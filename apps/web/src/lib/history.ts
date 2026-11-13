import { useEffect, useState } from 'react'

// Back and forward between screens: the mouse side buttons, ⌘[ / ⌘] (Alt ←/→ elsewhere), and the
// arrows in the header. Screens are hash routes, so this is the window's own history; the depth
// is counted here so Back never leaves the app when it runs in a browser tab.
let depth = 0
let ahead = 0
let pending: 'back' | 'forward' | null = null
const subs = new Set<() => void>()
const emit = () => subs.forEach((f) => f())

export function goBack(): void {
  if (depth === 0) return
  pending = 'back'
  window.history.back()
}

export function goForward(): void {
  if (ahead === 0) return
  pending = 'forward'
  window.history.forward()
}

let installed = false
function install(): void {
  if (installed) return
  installed = true
  window.addEventListener('hashchange', () => {
    if (pending === 'back') {
      depth = Math.max(0, depth - 1)
      ahead++
    } else if (pending === 'forward') {
      depth++
      ahead = Math.max(0, ahead - 1)
    } else {
      depth++
      ahead = 0
    }
    pending = null
    emit()
  })
  // side buttons: 3 is back, 4 is forward. preventDefault keeps a browser from also going back itself.
  const side = (e: MouseEvent) => {
    if (e.button !== 3 && e.button !== 4) return
    e.preventDefault()
    if (e.type === 'mouseup') (e.button === 3 ? goBack : goForward)()
  }
  window.addEventListener('mousedown', side)
  window.addEventListener('mouseup', side)
  window.addEventListener('keydown', (e) => {
    const el = e.target as HTMLElement | null
    const typing = !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))
    const back = e.key === 'BrowserBack' || (e.metaKey && e.key === '[') || (!typing && e.altKey && e.key === 'ArrowLeft')
    const fwd = e.key === 'BrowserForward' || (e.metaKey && e.key === ']') || (!typing && e.altKey && e.key === 'ArrowRight')
    if (!back && !fwd) return
    e.preventDefault()
    ;(back ? goBack : goForward)()
  })
}

export function useHistoryNav(): { readonly canBack: boolean; readonly canForward: boolean } {
  const [, tick] = useState(0)
  useEffect(() => {
    install()
    const f = () => tick((n) => n + 1)
    subs.add(f)
    return () => {
      subs.delete(f)
    }
  }, [])
  return { canBack: depth > 0, canForward: ahead > 0 }
}
