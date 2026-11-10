// Injected into every page of a hand-test session: reports wallet calls and copies to mevo, and
// draws the steps in a sidebar (its own shadow DOM, so the app's styles don't touch it).
;(() => {
  if (window.__mevoInstalled) return
  window.__mevoInstalled = true

  // wallet calls, from window.ethereum and every EIP-6963 provider
  const report = (method, params, result, error) => {
    try {
      window.__mevoRpc?.({ method, params: JSON.parse(JSON.stringify(params ?? null)), result: JSON.parse(JSON.stringify(result ?? null)), error })
    } catch {}
  }
  const wrap = (prov) => {
    if (!prov || typeof prov.request !== 'function' || prov.__mevo) return
    const orig = prov.request.bind(prov)
    try {
      prov.request = async (args) => {
        try {
          const r = await orig(args)
          report(args?.method, args?.params, r)
          return r
        } catch (e) {
          report(args?.method, args?.params, null, String(e?.message ?? e))
          throw e
        }
      }
      prov.__mevo = true
    } catch {}
  }
  window.addEventListener('eip6963:announceProvider', (e) => wrap(e.detail?.provider))
  setInterval(() => wrap(window.ethereum), 500)

  // copies
  try {
    const cb = navigator.clipboard
    if (cb?.writeText) {
      const orig = cb.writeText.bind(cb)
      cb.writeText = (t) => {
        try {
          window.__mevoClip?.(String(t))
        } catch {}
        return orig(t)
      }
    }
  } catch {}
  document.addEventListener('copy', () =>
    setTimeout(() => {
      try {
        const sel = String(document.getSelection() ?? '')
        if (sel) window.__mevoClip?.(sel)
      } catch {}
    }, 0),
  )

  // the sidebar
  let host = null
  let root = null
  let open = true
  let last = null
  let sheet = false
  const mobile = () => Math.min(window.innerWidth, window.screen?.width || Infinity) < 700
  const css = `
    :host { all: initial }
    .bar { position: fixed; top: 0; right: 0; bottom: 0; width: 320px; z-index: 2147483647; display: flex; flex-direction: column; background: #111214; color: #e3e4e6; border-left: 1px solid #2a2b30; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Inter", sans-serif; box-shadow: -8px 0 24px rgba(0,0,0,.35) }
    .bar.closed { width: 44px }
    .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #2a2b30 }
    .logo { font-weight: 700; letter-spacing: -.02em } .logo b { color: #7c5cff }
    .mode { font-size: 11px; color: #8a8d94; border: 1px solid #2a2b30; border-radius: 999px; padding: 1px 7px }
    .toggle { margin-left: auto; background: none; border: 0; color: #8a8d94; cursor: pointer; font-size: 16px }
    .closed .body, .closed .foot, .closed .mode, .closed .logo { display: none }
    .body { flex: 1; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px }
    .title { font-size: 12px; color: #8a8d94 }
    .step { border: 1px solid #2a2b30; border-radius: 10px; padding: 8px 10px; background: #16171a }
    .step.current { border-color: #7c5cff; background: #1b1830 }
    .step.done { opacity: .7 } .step.failed { border-color: #6b2a33 }
    .row { display: flex; gap: 8px; align-items: baseline }
    .mark { width: 16px; flex: none; text-align: center }
    .done .mark { color: #4ade80 } .failed .mark { color: #f87171 } .skipped .mark { color: #8a8d94 }
    .name { font-weight: 600 }
    .how, .expect, .detail { font-size: 12px; color: #a3a6ad; margin: 4px 0 0 24px }
    .expect { color: #8a8d94 } .detail { color: #4ade80; word-break: break-all }
    .auto { font-size: 11px; color: #7c5cff; margin: 4px 0 0 24px }
    .btns { display: flex; gap: 6px; margin: 8px 0 0 24px; flex-wrap: wrap }
    button.b { background: #1f2024; color: #e3e4e6; border: 1px solid #33343a; border-radius: 6px; padding: 4px 9px; font-size: 12px; cursor: pointer }
    button.b:hover { border-color: #7c5cff } button.p { background: #7c5cff; border-color: #7c5cff; color: white } button.bad { color: #f87171 }
    input.note { display: block; box-sizing: border-box; width: calc(100% - 24px); margin: 8px 0 0 24px; background: #0d0e10; color: #e3e4e6; border: 1px solid #33343a; border-radius: 6px; padding: 4px 7px; font: inherit; font-size: 12px }
    .tx { margin: 0 12px 10px; padding: 9px 10px; border: 1px solid #7c5cff; border-radius: 10px; background: #1b1830 }
    .foot { padding: 10px 12px; border-top: 1px solid #2a2b30; display: flex; gap: 8px; align-items: center }
    .count { font-size: 12px; color: #8a8d94; margin-right: auto }
    .pill { position: fixed; left: 10px; right: 10px; bottom: calc(10px + env(safe-area-inset-bottom)); z-index: 2147483647; display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-radius: 999px; background: #111214; color: #e3e4e6; font: 13px/1.3 -apple-system, BlinkMacSystemFont, "Inter", "Roboto", sans-serif; box-shadow: 0 8px 24px rgba(0,0,0,.45); border: 1px solid #2a2b30; text-align: left; cursor: pointer }
    .pill .now { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
    .pill .n { color: #8a8d94; font-size: 12px }
    .pill.flash { border-color: #4ade80 }
    .float-tx { position: fixed; left: 10px; right: 10px; bottom: calc(64px + env(safe-area-inset-bottom)); z-index: 2147483647; margin: 0; font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Inter", "Roboto", sans-serif; color: #e3e4e6 }
    .sheet { position: fixed; left: 0; right: 0; bottom: 0; max-height: 72vh; z-index: 2147483647; display: flex; flex-direction: column; background: #111214; color: #e3e4e6; border-radius: 18px 18px 0 0; box-shadow: 0 -10px 30px rgba(0,0,0,.5); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Inter", "Roboto", sans-serif; padding-bottom: env(safe-area-inset-bottom) }
    .grab { display: block; width: 100%; padding: 8px 0 4px; background: none; border: 0; cursor: pointer }
    .grab i { display: block; width: 40px; height: 4px; margin: 0 auto; border-radius: 4px; background: #3a3b40 }
    .sheet .head { padding: 2px 14px 8px }
    .sheet button.b { padding: 8px 12px; font-size: 13px }
    .sheet input.note { font-size: 16px; padding: 7px 9px }
  `
  const act = (a) => {
    try {
      window.__mevoAction?.(a)
    } catch {}
  }
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const draw = () => {
    const s = last
    if (!s || !document.body) return
    if (!host || !host.isConnected) {
      host = document.createElement('mevo-test')
      root = host.attachShadow({ mode: 'open' })
      document.documentElement.appendChild(host)
      root.addEventListener('click', (e) => {
        const b = e.target.closest?.('button')
        if (!b) return
        if (b.dataset.sheet) {
          sheet = !sheet
          draw()
          return
        }
        if (b.dataset.toggle) {
          open = !open
          draw()
          return
        }
        if (b.dataset.act === 'go') {
          navigate(b.dataset.go)
          return
        }
        if (b.dataset.act === 'stay') {
          cancelNav = true
          banner = null
          draw()
          return
        }
        const note = root.querySelector('input.note')?.value?.trim() || undefined
        if (b.dataset.act === 'note') {
          act({ type: 'mark', id: b.dataset.id, status: 'failed', note })
          return
        }
        if (b.dataset.act) act({ type: b.dataset.act === 'done' || b.dataset.act === 'skipped' ? 'mark' : b.dataset.act, id: b.dataset.id, status: b.dataset.act, note })
      })
    }
    const done = s.steps.filter((x) => x.status === 'done').length
    const mark = { pending: '○', done: '✓', failed: '✕', skipped: '–' }
    const title = `<div class="title">${esc(s.title)}</div>`
    const list = s.steps
      .map((x) => {
        const cur = x.id === s.current
        return `<div class="step ${x.status} ${cur ? 'current' : ''}"><div class="row"><span class="mark">${mark[x.status]}</span><span class="name">${esc(x.title)}</span></div>
          ${cur || x.status === 'pending' ? `<div class="how">${esc(x.how)}</div><div class="expect">Expect: ${esc(x.expect)}</div>` : ''}
          ${x.detail && x.status === 'done' ? `<div class="detail">${esc(x.detail)}</div>` : ''}
          ${cur && !x.manual ? '<div class="auto">mevo checks this one by itself</div>' : ''}
          ${cur && x.go ? `<div class="btns"><button class="b" data-act="go" data-go="${esc(x.go)}">Go to ${esc(x.go)}</button></div>` : ''}
          ${cur ? `<input class="note" placeholder="Note (optional)" /><div class="btns"><button class="b ${x.manual ? 'p' : ''}" data-act="done" data-id="${esc(x.id)}">Done</button><button class="b bad" data-act="note" data-id="${esc(x.id)}">Didn't work</button><button class="b" data-act="skipped" data-id="${esc(x.id)}">Skip</button></div>` : ''}
          </div>`
      })
      .join('')
    const tx = (cls) => (s.pendingTx ? `<div class="tx ${cls}"><div class="name">The test wallet wants to send a transaction</div><div class="btns" style="margin-left:0"><button class="b p" data-act="approve">Approve</button><button class="b bad" data-act="reject">Reject</button></div></div>` : '')
    const foot = `<div class="foot"><span class="count">${done} of ${s.steps.length} done</span><button class="b ${s.current ? '' : 'p'}" data-act="finish">Finish</button></div>`
    const logo = '<span class="logo">mev<b>o</b></span>'
    if (mobile()) {
      // a phone: a pill with the step at hand, the steps in a bottom sheet
      const now = s.steps.find((x) => x.id === s.current)
      root.innerHTML = `<style>${css}</style>${
        sheet
          ? `<div class="sheet"><button class="grab" data-sheet="1" aria-label="hide the steps"><i></i></button><div class="head">${logo}<span class="mode">${esc(s.mode)}</span></div><div class="body">${title}${list}</div>${tx('')}${foot}</div>`
          : `${tx('float-tx')}<button class="pill" data-sheet="1">${logo}<span class="n">${done} of ${s.steps.length}</span><span class="now">${esc(now ? now.title : 'All steps done: open to finish')}</span><span>⌃</span></button>`
      }`
      return
    }
    root.innerHTML = `<style>${css}</style><div class="bar ${open ? '' : 'closed'}">
      <div class="head">${logo}<span class="mode">${esc(s.mode)}</span><button class="toggle" data-toggle="1" title="${open ? 'hide' : 'show'} the steps">${open ? '›' : '‹'}</button></div>
      ${banner ? `<div class="tx"><div class="name">Taking you to ${esc(banner)}</div><div class="btns" style="margin-left:0"><button class="b" data-act="stay">Stay here</button></div></div>` : ''}
      <div class="body">${title}${list}</div>
      ${tx('')}
      ${foot}
    </div>`
  }
  // each step can say where it happens: when it comes up, the panel takes you there (once)
  let banner = null
  let cancelNav = false
  let navFor = null
  function navigate(go) {
    try {
      location.assign(new URL(go, location.origin).href)
    } catch {}
  }
  const follow = (s) => {
    const step = s.steps.find((x) => x.id === s.current)
    if (!step?.go || navFor === step.id) return
    let target
    try {
      target = new URL(step.go, location.origin)
    } catch {
      return
    }
    const key = `__mevo_went_${s.run ?? ''}_${step.id}`
    let went = false
    try {
      went = sessionStorage.getItem(key) === '1'
    } catch {}
    if (went || location.pathname + location.search === target.pathname + target.search) return
    navFor = step.id
    cancelNav = false
    banner = step.go
    setTimeout(() => {
      if (cancelNav) return
      try {
        sessionStorage.setItem(key, '1')
      } catch {}
      navigate(step.go)
    }, 1500)
  }
  window.addEventListener('resize', () => last && document.body && draw())
  window.__mevoRender = (s) => {
    last = s
    follow(s)
    if (document.body) draw()
    else document.addEventListener('DOMContentLoaded', draw, { once: true })
  }
  window.__mevoHide = (h) => {
    if (host) host.style.display = h ? 'none' : ''
  }
})()
