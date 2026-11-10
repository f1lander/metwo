import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import { desktop, isDesktop } from './lib/tauri.js'
import './styles.css'

// The desktop window ignores target="_blank": every link that leaves the app (GitHub, Linear,
// previews, rendered markdown) opens in the system browser instead.
if (isDesktop) {
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0) return
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!a) return
    let url: URL
    try {
      url = new URL(a.href, window.location.href)
    } catch {
      return
    }
    if (url.origin === window.location.origin || !/^https?:$/.test(url.protocol)) return
    e.preventDefault()
    void desktop.open(url.href)
  })
}

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
