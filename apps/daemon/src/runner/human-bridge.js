// Your-Chrome hand tests: no Playwright, so the panel talks to mevo through the local proxy that
// serves the app. It reports to /__mevo/event and reads the steps from /__mevo/state. The checks
// it can see in the page (URL, text, an element) it runs here; wallet calls and copies go to mevo.
;(() => {
  if (window.__mevoBridge) return
  window.__mevoBridge = true
  let state = null
  let reported = null
  let soon = null
  const post = (e) => {
    try {
      fetch('/__mevo/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(e), keepalive: true })
        .then(() => tick())
        .catch(() => {})
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
  // a wallet that is already connected never asks for accounts again: ask it (no prompt)
  let asking = false
  let asked = 0
  const connected = async () => {
    if (asking || Date.now() - asked < 800) return
    asking = true
    asked = Date.now()
    try {
      for (const p of [window.ethereum, ...(window.__mevoProviders ?? [])]) {
        const a = p?.request ? await p.request({ method: 'eth_accounts' }).catch(() => null) : null
        if (Array.isArray(a) && a.length) return
      }
    } finally {
      asking = false
    }
  }
  const check = () => {
    const step = state?.steps.find((x) => x.id === state.current)
    if (!step || reported === step.id) return
    if (step.check?.kind === 'rpc' && step.check.value === 'eth_requestAccounts') return void connected()
    const hit = seen(step)
    if (hit) {
      reported = step.id
      post({ type: 'seen', id: step.id, detail: String(hit).slice(0, 300) })
    }
  }
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const r = await fetch(`/__mevo/state?url=${encodeURIComponent(location.href)}`, { cache: 'no-store' })
      state = await r.json()
      window.__mevoRender?.(state)
      check()
    } catch {
    } finally {
      busy = false
    }
  }
  // check as soon as the page changes, not only on the poll
  const later = () => {
    clearTimeout(soon)
    soon = setTimeout(check, 120)
  }
  new MutationObserver((m) => {
    if (m.some((x) => !(x.target instanceof Element && x.target.closest?.('mevo-test')))) later()
  }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'open'] })
  for (const k of ['pushState', 'replaceState']) {
    const orig = history[k]
    history[k] = function (...a) {
      const r = orig.apply(this, a)
      later()
      return r
    }
  }
  window.addEventListener('popstate', later)
  setInterval(tick, 500)
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', tick, { once: true })
  else tick()
})()
