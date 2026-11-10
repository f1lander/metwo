// Your-Chrome hand tests: no Playwright, so the panel talks to mevo through the local proxy that
// serves the app. It reports to /__mevo/event and reads the steps from /__mevo/state. The checks
// it can see in the page (URL, text, an element) it runs here; wallet calls and copies go to mevo.
;(() => {
  if (window.__mevoBridge) return
  window.__mevoBridge = true
  const post = (e) => {
    try {
      fetch('/__mevo/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(e), keepalive: true }).catch(() => {})
    } catch {}
  }
  window.__mevoRpc = (e) => post({ type: 'rpc', ...e })
  window.__mevoClip = (text) => post({ type: 'clip', text })
  // mark (Done, Didn't work, Skip) and finish; approve/reject are only for the test wallet
  window.__mevoAction = (a) => post(a)
  window.addEventListener('error', (e) => post({ type: 'error', text: `page error: ${String(e.message).slice(0, 400)}` }))

  const match = (value, text) => {
    if (!value) return Boolean(text)
    try {
      return new RegExp(value, 'i').test(text)
    } catch {
      return text.toLowerCase().includes(value.toLowerCase())
    }
  }
  const seen = (step) => {
    const v = step.check?.value ?? ''
    if (step.check?.kind === 'url') return match(v, location.href) ? location.href : null
    if (step.check?.kind === 'text') return v && document.body?.innerText.toLowerCase().includes(v.toLowerCase()) ? `"${v}" on the page` : null
    if (step.check?.kind === 'selector') {
      try {
        const el = v && document.querySelector(v)
        return el && el.getClientRects().length ? `${v} on the page` : null
      } catch {
        return null
      }
    }
    return null
  }
  let reported = null
  const tick = async () => {
    try {
      const r = await fetch(`/__mevo/state?url=${encodeURIComponent(location.href)}`, { cache: 'no-store' })
      const s = await r.json()
      window.__mevoRender?.(s)
      const step = s.steps.find((x) => x.id === s.current)
      if (step && reported !== step.id) {
        const hit = seen(step)
        if (hit) {
          reported = step.id
          post({ type: 'seen', id: step.id, detail: String(hit).slice(0, 300) })
        }
      }
    } catch {}
  }
  setInterval(tick, 1000)
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick, { once: true })
  else tick()
})()
