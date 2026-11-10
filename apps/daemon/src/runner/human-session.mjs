// A hand-test session: a real (headed) Chromium on the app, a sidebar with the steps, and mevo
// watching for each step's check. Runs from the ticket's flow dir with the repo's e2e packages
// (Playwright, the headless wallet) linked in as node_modules. Talks to the daemon in JSON lines:
// events on stdout, commands on stdin.
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
const { chromium, _android } = await import('@playwright/test').catch(() => import('playwright'))

const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)
const now = () => new Date().toISOString()
mkdirSync(cfg.outDir, { recursive: true })

const steps = cfg.steps.map((s) => ({ ...s, status: 'pending' }))
let since = Date.now()
const rpc = []
const clips = []
let pendingTx = false
let finished = false
let autorunning = false
let connected = false

// on a phone: Chrome over adb (the daemon records the screen itself). On the Mac: a Chromium
// window; METWO_CDP_PORT lets tests drive the same browser over CDP.
let browser = null
let device = null
let context
if (cfg.android) {
  device = (await _android.devices()).find((d) => d.serial() === cfg.android.serial)
  if (!device) throw new Error(`the phone ${cfg.android.serial} is not connected`)
  await device.shell('am force-stop com.android.chrome').catch(() => {})
  context = await device.launchBrowser().catch((e) => {
    throw new Error(`Chrome on the phone did not start: ${e.message.split('\n')[0]}. On the phone, open chrome://flags and turn on "Enable command line on non-rooted devices", then try again.`)
  })
} else {
  browser = await chromium.launch({ headless: false, args: ['--start-maximized', ...(process.env.METWO_CDP_PORT ? [`--remote-debugging-port=${process.env.METWO_CDP_PORT}`] : [])] })
  context = await browser.newContext({ viewport: null, recordVideo: { dir: cfg.outDir, size: { width: 1440, height: 900 } } })
}

const current = () => steps.find((s) => s.status === 'pending')
// the app's tab: never MetaMask's own windows or the Web Store
const page = () => context.pages().filter((p) => !p.isClosed() && !/^chrome-extension:|chromewebstore/.test(p.url())).at(-1)
const state = () => ({ title: cfg.title, run: cfg.run, mode: cfg.android ? `${cfg.mode} · phone` : cfg.mode, steps: steps.map(({ id, title, how, expect, status, check, detail, go }) => ({ id, title, how, expect, status, manual: check.kind === 'manual', detail, go })), current: current()?.id ?? null, pendingTx, autorun: Boolean(cfg.doSteps && wallets.length), autorunning })
const render = async () => {
  for (const p of context.pages()) await p.evaluate((s) => window.__mevoRender?.(s), state()).catch(() => {})
}

// --- what the page does, reported to us
await context.exposeBinding('__mevoRpc', (_src, e) => {
  rpc.push({ ...e, t: Date.now() })
  if (e.method === 'eth_sendTransaction' && typeof e.result === 'string') out({ type: 'tx', hash: e.result })
})
await context.exposeBinding('__mevoClip', (_src, text) => clips.push({ text, t: Date.now() }))
await context.exposeBinding('__mevoAction', async (_src, a) => {
  if (a.type === 'mark') await mark(a.id, a.status, 'manual', a.note)
  if (a.type === 'approve' || a.type === 'reject') await walletDecision(a.type)
  if (a.type === 'finish') await finish()
  if (a.type === 'autorun') void autorun()
  await render()
})
await context.addInitScript({ content: readFileSync(new URL('./human-page.js', import.meta.url), 'utf8') })

// mock mode: the e2e headless wallet on the local chain, in every tab; signing is allowed,
// transactions wait for Approve in the sidebar
const wallets = []
let armWallet = null
let walletAddress = null
if (cfg.wallet) {
  const { injectHeadlessWeb3Provider } = await import('@ensdomains/headless-web3-provider')
  const { mnemonicToAccount } = await import('viem/accounts')
  const { bytesToHex } = await import('viem')
  const { sepolia } = await import('viem/chains')
  const accounts = [0, 1, 2, 3].map((i) => mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: i }))
  const keys = accounts.map((a) => bytesToHex(a.getHdKey().privateKey))
  walletAddress = accounts[0].address
  // account 0 carries leftover contract code on the Sepolia fork, which makes UI registrations
  // revert; the e2e fixtures clear it the same way
  await fetch(cfg.wallet.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_setCode', params: [walletAddress, '0x'] }) }).catch((e) => out({ type: 'error', text: `could not clear account 0's code on the fork: ${e.message}` }))
  armWallet = async (p) => {
    const w = await injectHeadlessWeb3Provider({
      page: p,
      privateKeys: keys,
      chains: [{ ...sepolia, rpcUrls: { default: { http: [cfg.wallet.rpc] } } }],
      permitted: ['eth_requestAccounts', 'eth_accounts', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_requestPermissions', 'personal_sign', 'eth_signTypedData', 'eth_signTypedData_v1', 'eth_signTypedData_v3', 'eth_signTypedData_v4'],
    })
    // the page can't wrap this provider (a Proxy that ignores writes), so its calls are recorded here
    const request = w.request.bind(w)
    w.request = async (args) => {
      const t = Date.now()
      try {
        const result = await request(args)
        rpc.push({ method: args?.method, params: args?.params ?? null, result: result ?? null, t })
        if (args?.method === 'eth_sendTransaction' && typeof result === 'string') out({ type: 'tx', hash: result })
        return result
      } catch (e) {
        rpc.push({ method: args?.method, params: args?.params ?? null, result: null, error: String(e?.message ?? e), t })
        throw e
      }
    }
    wallets.push(w)
    p.on('close', () => {
      const i = wallets.indexOf(w)
      if (i >= 0) wallets.splice(i, 1)
    })
  }
  await armWallet(await context.newPage())
  context.on('page', (p) => void armWallet(p).catch((e) => out({ type: 'error', text: `no test wallet in the new tab: ${e.message}` })))
  setInterval(async () => {
    const n = wallets.reduce((sum, w) => sum + w.getPendingRequestCount('eth_sendTransaction'), 0)
    if ((n > 0) !== pendingTx) {
      pendingTx = n > 0
      out({ type: 'pendingTx', on: pendingTx })
      await render()
    }
  }, 700)
}
async function walletDecision(kind) {
  for (const w of wallets) {
    if (!w.getPendingRequestCount('eth_sendTransaction')) continue
    if (kind === 'approve') await w.authorize('eth_sendTransaction').catch((e) => out({ type: 'error', text: `approve failed: ${e.message}` }))
    else await w.reject('eth_sendTransaction').catch(() => {})
  }
}

// What the e2e fixtures do before a test: open the connect dialog, pick the test wallet (the
// connection requests are permitted, so they go through) and skip the backend sign-in prompt,
// which needs a worker the local stack doesn't run. Best effort: on a miss you connect by hand.
async function connectWallet(p) {
  const button = p.getByRole('button', { name: /^connect( login| wallet)?$/i }).first()
  const ok = await button.waitFor({ state: 'visible', timeout: 60_000 }).then(() => true, () => false)
  if (!ok) return 'no Connect button on the first page'
  const option = p.getByText('Headless Web3 Provider').first()
  // the server-rendered button can be clickable before the app hydrates: retry until the dialog opens
  const until = Date.now() + 40_000
  while (Date.now() < until && !(await option.isVisible().catch(() => false))) {
    if (!(await p.getByRole('dialog').first().isVisible().catch(() => false))) await button.click({ timeout: 5_000 }).catch(() => {})
    await option.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => {})
  }
  if (!(await option.isVisible().catch(() => false))) return 'the connect dialog did not list "Headless Web3 Provider"'
  await option.click()
  if (!(await button.waitFor({ state: 'hidden', timeout: 20_000 }).then(() => true, () => false))) return 'the app did not finish connecting'
  const verify = p.getByRole('alertdialog', { name: 'Verify your wallet' })
  if (await verify.waitFor({ state: 'visible', timeout: 15_000 }).then(() => true, () => false)) {
    await p.keyboard.type('skip', { delay: 50 })
    await p.locator('[data-slot="alert-dialog-overlay"]').waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {})
  }
  return null
}

const p0 = page() ?? (await context.newPage())
p0.on('console', (m) => m.type() === 'error' && out({ type: 'error', text: m.text().slice(0, 400) }))
p0.on('pageerror', (e) => out({ type: 'error', text: `page error: ${e.message.slice(0, 400)}` }))
context.on('page', (p) => {
  p.on('console', (m) => m.type() === 'error' && out({ type: 'error', text: m.text().slice(0, 400) }))
  p.on('load', () => void render())
})
p0.on('load', () => void render())
await p0.goto(cfg.url).catch((e) => out({ type: 'error', text: `could not open ${cfg.url}: ${e.message}` }))
out({ type: 'ready' })
await render()
if (cfg.wallet) {
  out({ type: 'note', text: 'Connecting the test wallet…' })
  const miss = await connectWallet(p0).catch((e) => e.message)
  connected = !miss
  out({ type: 'note', text: miss ? `Connect the wallet yourself: pick "Headless Web3 Provider" in the connect dialog (${miss})` : `Test wallet connected: ${walletAddress}` })
}

// --- the checks: only the current step is watched, and only what happened since it became current
const match = (value, text) => {
  if (!value) return Boolean(text)
  try {
    return new RegExp(value, 'i').test(text)
  } catch {
    return text.toLowerCase().includes(value.toLowerCase())
  }
}
async function seen(step) {
  const p = page()
  const v = step.check.value ?? ''
  switch (step.check.kind) {
    case 'url':
      return p && match(v, p.url()) ? p.url() : null
    case 'text':
      return p && v && (await p.evaluate((t) => document.body?.innerText.toLowerCase().includes(t.toLowerCase()), v).catch(() => false)) ? `"${v}" on the page` : null
    case 'selector':
      return p && v && (await p.locator(v).first().isVisible().catch(() => false)) ? `${v} visible` : null
    case 'rpc': {
      const hit = rpc.find((e) => e.t >= since && e.method === v && !e.error && (e.method !== 'eth_requestAccounts' || (Array.isArray(e.result) && e.result.length)))
      return hit ? `${hit.method}${Array.isArray(hit.result) ? ` → ${hit.result[0]}` : ''}` : null
    }
    case 'tx': {
      const hit = rpc.find((e) => e.t >= since && e.method === 'eth_sendTransaction' && typeof e.result === 'string' && (!v || JSON.stringify(e.params ?? '').toLowerCase().includes(v.toLowerCase())))
      return hit ? hit.result : null
    }
    case 'clipboard': {
      const hit = clips.find((c) => c.t >= since && match(v, c.text))
      return hit ? `copied ${hit.text.slice(0, 80)}` : null
    }
    default:
      return null
  }
}

async function shot(step) {
  const p = page()
  if (!p) return undefined
  const name = `${String(steps.indexOf(step) + 1).padStart(2, '0')}-${step.id}.png`
  await p.evaluate(() => window.__mevoHide?.(true)).catch(() => {})
  await p.screenshot({ path: path.join(cfg.outDir, name) }).catch(() => {})
  await p.evaluate(() => window.__mevoHide?.(false)).catch(() => {})
  return name
}

async function mark(id, status, how, note) {
  const step = steps.find((s) => s.id === id)
  if (!step || finished) return
  step.status = status
  const shotName = status === 'skipped' ? undefined : await shot(step)
  out({ type: 'step', id, status, how, at: now(), ...(shotName ? { shot: shotName } : {}), ...(note ? { note } : {}), ...(step.detail ? { detail: step.detail } : {}) })
  since = Date.now()
  await render()
}

const timer = setInterval(async () => {
  const step = current()
  if (!step || step.check.kind === 'manual' || finished) return
  const hit = await seen(step).catch(() => null)
  if (hit) {
    step.detail = String(hit).slice(0, 300)
    await mark(step.id, 'done', 'auto')
  }
}, 1000)

// "Run the steps for me": the lane's Playwright lines for each step, in order, while you watch.
// It stops at a step with no lines or one only you can judge, and on any error.
async function autorun() {
  if (autorunning || !cfg.doSteps) return
  autorunning = true
  await render()
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
  const p = page()
  const goto = (to) => p.goto(new URL(to, cfg.url).toString(), { waitUntil: 'load' })
  const approveTx = async (ms = 30_000) => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (wallets.some((w) => w.getPendingRequestCount('eth_sendTransaction') > 0)) return walletDecision('approve')
      await new Promise((r) => setTimeout(r, 300))
    }
    throw new Error('no transaction to approve')
  }
  try {
    for (;;) {
      const step = current()
      const lines = step && cfg.doSteps[step.id]
      if (!step || finished) break
      if (step.go) await goto(step.go)
      if (!lines) break
      await Promise.race([new AsyncFunction('page', 'connect', 'approveTx', 'goto', lines)(p, async () => {
        if (connected) return
        const miss = await connectWallet(p)
        if (miss) throw new Error(miss)
        connected = true
      }, approveTx, goto), new Promise((_, rej) => setTimeout(() => rej(new Error('the step took longer than 45s')), 45_000))])
      if (step.check.kind === 'manual') break
      const until = Date.now() + 15_000
      while (current() === step && Date.now() < until) await new Promise((r) => setTimeout(r, 300))
      if (current() === step) {
        out({ type: 'note', text: `Ran "${step.title}" but its check didn't show; over to you` })
        break
      }
    }
  } catch (e) {
    out({ type: 'error', text: `Run the steps: ${String(e?.message ?? e).split('\n')[0].slice(0, 300)}` })
  } finally {
    autorunning = false
    await render()
  }
}

async function finish() {
  if (finished) return
  finished = true
  clearInterval(timer)
  const video = await page()?.video()?.path().catch(() => null)
  await context.close().catch(() => {})
  await browser?.close().catch(() => {})
  await device?.close().catch(() => {})
  const status = steps.some((s) => s.status === 'failed') ? 'failed' : steps.every((s) => s.status === 'done' || s.status === 'skipped') ? 'passed' : 'incomplete'
  out({ type: 'done', status, ...(video ? { video: path.basename(video) } : {}) })
  process.exit(0)
}

browser?.on('disconnected', () => void finish())
device?.on('close', () => void finish())
context.on('close', () => void finish())
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  try {
    const c = JSON.parse(line)
    if (c.type === 'stop') void finish()
    if (c.type === 'autorun') void autorun()
  } catch {}
})
