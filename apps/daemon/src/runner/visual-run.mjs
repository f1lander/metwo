// The visual plan, run by mevo: a headless Chromium on the app, the e2e test wallet when there is
// one, and for each step its Playwright lines, its check and its screenshots, with one video of
// the run. Runs from a folder with the repo's e2e packages linked in as node_modules. Writes the
// result to cfg.out (RUN.json) and prints one JSON line per step.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
const { chromium } = await import('@playwright/test').catch(() => import('playwright'))

const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`)
mkdirSync(cfg.shotsDir, { recursive: true })
mkdirSync(cfg.workDir, { recursive: true })

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } }
const before = cfg.prefix === 'before'
const browser = await chromium.launch({ headless: cfg.headed !== true })
const context = await browser.newContext({ viewport: VIEWPORTS.desktop, recordVideo: { dir: cfg.workDir, size: VIEWPORTS.desktop } })

// the step's title at the top of the page, for the video; hidden for screenshots
await context.addInitScript(() => {
  window.__mevoBanner = (text) => {
    let el = document.getElementById('__mevo-banner')
    if (!text) return el?.remove()
    if (!el) {
      el = document.createElement('div')
      el.id = '__mevo-banner'
      el.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:rgba(17,17,17,.88);color:#fff;font:600 15px/1.3 system-ui,sans-serif;padding:8px 14px;border-radius:8px;pointer-events:none;max-width:80vw'
      ;(document.body ?? document.documentElement).appendChild(el)
    }
    el.textContent = text
  }
})

// wallet calls, recorded on the wallet's side (the page can't wrap the headless provider)
const rpc = []
let wallet = null
if (cfg.wallet) {
  const { injectHeadlessWeb3Provider } = await import('@ensdomains/headless-web3-provider')
  const { mnemonicToAccount } = await import('viem/accounts')
  const { bytesToHex } = await import('viem')
  const { sepolia } = await import('viem/chains')
  const accounts = [0, 1, 2, 3].map((i) => mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: i }))
  // account 0's leftover contract code on the Sepolia fork makes UI registrations revert
  await fetch(cfg.wallet.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_setCode', params: [accounts[0].address, '0x'] }) }).catch(() => {})
  wallet = { address: accounts[0].address, backend: null }
  const page0 = await context.newPage()
  const w = await injectHeadlessWeb3Provider({
    page: page0,
    privateKeys: accounts.map((a) => bytesToHex(a.getHdKey().privateKey)),
    chains: [{ ...sepolia, rpcUrls: { default: { http: [cfg.wallet.rpc] } } }],
    permitted: ['eth_requestAccounts', 'eth_accounts', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_requestPermissions', 'personal_sign', 'eth_signTypedData', 'eth_signTypedData_v1', 'eth_signTypedData_v3', 'eth_signTypedData_v4'],
  })
  const request = w.request.bind(w)
  w.request = async (args) => {
    const t = Date.now()
    try {
      const result = await request(args)
      rpc.push({ method: args?.method, params: args?.params ?? null, result: result ?? null, t })
      return result
    } catch (e) {
      rpc.push({ method: args?.method, result: null, error: String(e?.message ?? e), t })
      throw e
    }
  }
  wallet.backend = w
}
const page = context.pages()[0] ?? (await context.newPage())
const t0 = Date.now()
const errors = []
page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))

const goto = async (p) => {
  await page.goto(new URL(p, cfg.url).toString(), { waitUntil: 'load' })
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {})
}
const banner = (text) => page.evaluate((t) => window.__mevoBanner?.(t), text).catch(() => {})

// what the e2e fixtures do: open the connect dialog, pick the test wallet, skip the sign-in prompt
async function connect() {
  if (!wallet) throw new Error('no test wallet in this run (the repo has no e2e wallet package)')
  const miss = await connectIn(page, wallet.address)
  if (miss) throw new Error(`connect: ${miss}`)
}
async function connectIn(p, address) {
  const button = p.getByRole('button', { name: /^connect( login| wallet)?$/i }).first()
  const shown = p.getByText(new RegExp(address.slice(0, 6), 'i')).first()
  // the app may reconnect the test wallet by itself: then there is no Connect button to press
  let state = null
  const first = Date.now() + 30_000
  while (!state && Date.now() < first) {
    if (await shown.isVisible().catch(() => false)) state = 'connected'
    else if (await button.isVisible().catch(() => false)) state = 'button'
    else await p.waitForTimeout(500)
  }
  if (!state) return 'neither a Connect button nor the test address showed on the page'
  if (state === 'button') {
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
  }
  // the backend sign-in prompt (its name changed over time): skipped, the local stack has no backend
  const prompt = p.getByRole('alertdialog', { name: /verify your wallet|authenticate to continue/i }).first()
  if (await prompt.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)) {
    await p.keyboard.type('skip', { delay: 50 })
    await p.locator('[data-slot="alert-dialog-overlay"]').waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {})
  }
  return null
}

// the next transaction the app sends, approved (local fork, test accounts)
async function approveTx(timeoutMs = 30_000) {
  if (!wallet) throw new Error('no test wallet in this run')
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (wallet.backend.getPendingRequestCount('eth_sendTransaction') > 0) {
      await wallet.backend.authorize('eth_sendTransaction')
      return
    }
    await page.waitForTimeout(300)
  }
  throw new Error('no transaction to approve')
}

const match = (value, text) => {
  if (!value) return Boolean(text)
  try {
    return new RegExp(value, 'i').test(text)
  } catch {
    return text.toLowerCase().includes(value.toLowerCase())
  }
}
async function seen(step, since) {
  const v = step.check?.value ?? ''
  switch (step.check?.kind) {
    case 'url':
      return match(v, page.url()) ? page.url() : null
    case 'text':
      return v && (await page.evaluate((t) => document.body?.innerText.toLowerCase().includes(t.toLowerCase()), v).catch(() => false)) ? `"${v}" on the page` : null
    case 'selector':
      return v && (await page.locator(v).first().isVisible().catch(() => false)) ? `${v} on the page` : null
    case 'rpc': {
      const hit = rpc.find((e) => e.t >= since && e.method === v && !e.error)
      return hit ? `${v}` : null
    }
    case 'tx': {
      const hit = rpc.find((e) => e.t >= since && e.method === 'eth_sendTransaction' && typeof e.result === 'string')
      return hit ? `transaction ${hit.result}` : null
    }
    default:
      return 'no check'
  }
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'step'
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} took longer than ${ms / 1000}s`)), ms))])

const results = []
const last = before ? Math.max(-1, ...cfg.steps.map((s, i) => (s.shot?.before ? i : -1))) : cfg.steps.length - 1
let broken = null
await goto(cfg.url).catch((e) => {
  broken = `could not open ${cfg.url}: ${e.message.split('\n')[0]}`
})
// a consent banner over the page: the privacy-preserving answer, so it stays out of the shots
await page.getByRole('button', { name: /^no thanks$/i }).first().click({ timeout: 2_000 }).catch(() => {})

for (const [i, step] of cfg.steps.entries()) {
  if (i > last) break
  const nn = String(i + 1).padStart(2, '0')
  const r = { id: step.id, title: step.title, status: 'skipped', shots: [], start: (Date.now() - t0) / 1000, end: 0 }
  results.push(r)
  if (broken) {
    r.error = `not run: ${broken}`
    r.end = r.start
    out({ type: 'step', ...r })
    continue
  }
  const since = Date.now()
  await banner(`${i + 1}. ${step.title}`)
  try {
    if (step.go) await goto(step.go)
    await banner(`${i + 1}. ${step.title}`)
    if (step.do) await withTimeout(new AsyncFunction('page', 'connect', 'approveTx', 'goto', step.do)(page, connect, approveTx, goto), cfg.stepTimeoutMs ?? 45_000, 'the step')
    // the old code may not have the new state: before runs only take the shots
    if (!before && step.check && step.check.kind !== 'manual') {
      const until = Date.now() + (cfg.checkTimeoutMs ?? 15_000)
      let hit = null
      while (!(hit = await seen(step, since)) && Date.now() < until) await page.waitForTimeout(300)
      if (!hit) throw new Error(`its check was not seen: ${step.check.kind}${step.check.value ? ` "${step.check.value}"` : ''}`)
      r.detail = String(hit).slice(0, 200)
    }
    if (step.shot && (!before || step.shot.before)) {
      await page.waitForTimeout(400)
      await banner('')
      for (const vp of step.shot.viewports?.length ? step.shot.viewports : ['desktop']) {
        await page.setViewportSize(VIEWPORTS[vp] ?? VIEWPORTS.desktop)
        await page.waitForTimeout(vp === 'desktop' ? 150 : 500)
        const name = `${nn}-${cfg.prefix}-${slug(step.title)}-${vp}.png`
        await page.screenshot({ path: path.join(cfg.shotsDir, name) })
        r.shots.push(name)
      }
      await page.setViewportSize(VIEWPORTS.desktop)
    }
    r.status = 'passed'
  } catch (e) {
    r.status = 'failed'
    // biome-ignore lint/suspicious/noControlCharactersInRegex: colour codes in Playwright's errors
    r.error = String(e?.message ?? e).replace(/\x1b\[[0-9;]*m/g, '').split('\n').slice(0, 4).join(' ').replace(/\s+/g, ' ').slice(0, 600)
    await banner('')
    const fail = `${nn}-failed-${slug(step.title)}.png`
    await page.screenshot({ path: path.join(cfg.workDir, fail) }).catch(() => {})
    r.failShot = fail
    r.url = page.url()
    broken = `step ${i + 1} failed`
  }
  r.end = (Date.now() - t0) / 1000
  out({ type: 'step', ...r })
}

await banner('')
const video = await page.video()?.path().catch(() => null)
await context.close().catch(() => {})
await browser.close().catch(() => {})
const report = { prefix: cfg.prefix, ok: results.every((r) => r.status === 'passed'), steps: results, errors: errors.slice(-10), ...(video ? { video: path.basename(video) } : {}) }
writeFileSync(cfg.out, JSON.stringify(report, null, 2))
out({ type: 'done', ok: report.ok })
process.exit(0)
