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
const state = () => ({ title: cfg.title, run: cfg.run, mode: cfg.android ? `${cfg.mode} · phone` : cfg.mode, steps: steps.map(({ id, title, how, expect, status, check, detail, go }) => ({ id, title, how, expect, status, manual: check.kind === 'manual', detail, go })), current: current()?.id ?? null, pendingTx })
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
  await render()
})
await context.addInitScript({ content: readFileSync(new URL('./human-page.js', import.meta.url), 'utf8') })

// mock mode: the e2e headless wallet on the local chain; signing is allowed, transactions wait
// for Approve in the sidebar
let wallet = null
if (cfg.wallet) {
  const { injectHeadlessWeb3Provider } = await import('@ensdomains/headless-web3-provider')
  const { mnemonicToAccount } = await import('viem/accounts')
  const { bytesToHex } = await import('viem')
  const { sepolia } = await import('viem/chains')
  const keys = [0, 1, 2, 3].map((i) => bytesToHex(mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: i }).getHdKey().privateKey))
  const p0 = await context.newPage()
  wallet = await injectHeadlessWeb3Provider({
    page: p0,
    privateKeys: keys,
    chains: [{ ...sepolia, rpcUrls: { default: { http: [cfg.wallet.rpc] } } }],
    permitted: ['eth_requestAccounts', 'eth_accounts', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_requestPermissions', 'personal_sign', 'eth_signTypedData', 'eth_signTypedData_v3', 'eth_signTypedData_v4'],
  })
  setInterval(async () => {
    const n = wallet.getPendingRequestCount('eth_sendTransaction')
    if ((n > 0) !== pendingTx) {
      pendingTx = n > 0
      out({ type: 'pendingTx', on: pendingTx })
      await render()
    }
  }, 700)
}
async function walletDecision(kind) {
  if (!wallet) return
  if (kind === 'approve') await wallet.authorize('eth_sendTransaction').catch((e) => out({ type: 'error', text: `approve failed: ${e.message}` }))
  else await wallet.reject('eth_sendTransaction').catch(() => {})
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
  } catch {}
})
