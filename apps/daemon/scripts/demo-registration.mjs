#!/usr/bin/env node
// Records a mevo hand test of registering a name in the manager, for a demo video. It starts a
// real mevo session (headed Chromium, the steps in the page, the test wallet on the local e2e
// chain), then moves a visible cursor through the flow: search, connect, pay with stablecoins,
// approve the transactions in mevo's sidebar, check the result, finish. The page is recorded
// frame by frame to <out>/screen.mjpeg with timings and markers for editing.
//
// Before: the e2e stack and the manager in CI mode, from apps-monorepo:
//   pnpm e2e:infra:up
//   pnpm --filter manager dev -- --port 3000 --mode ci
// Then, from apps/daemon:
//   node scripts/demo-registration.mjs --repo ~/Coderoasters/apps-monorepo
import { spawn } from 'node:child_process'
import { copyFileSync, createWriteStream, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const home = (p) => p?.replace(/^~(?=\/|$)/, os.homedir())
const repo = home(arg('--repo', path.join(os.homedir(), 'Coderoasters', 'apps-monorepo')))
const url = arg('--url', 'http://localhost:3000').replace(/\/$/, '')
const rpc = arg('--rpc', 'http://127.0.0.1:8545')
const mode = arg('--mode', 'mock')
const label = arg('--name', `mevo-demo-${Date.now().toString(36).slice(-5)}`)
const out = path.resolve(home(arg('--out', path.join(process.cwd(), `mevo-demo-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`))))
const modules = home(arg('--modules', path.join(repo, 'e2e', 'node_modules')))
const cdpPort = Number(arg('--cdp', '9333'))
const W = 1600
const H = 900

const t0 = Date.now()
const markers = []
const mark = (label) => {
  markers.push({ t: (Date.now() - t0) / 1000, label })
  console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const steps = [
  { id: 's1', title: 'Search for a name', how: `Type ${label} in the search.`, expect: 'It shows as Available.', check: { kind: 'text', value: 'Available' } },
  { id: 's2', title: 'Open the registration page', how: 'Pick the name from the results.', expect: 'The register page for the name.', check: { kind: 'url', value: '/register/' } },
  { id: 's3', title: 'Connect the test wallet', how: 'Connect to Register, then Headless Web3 Provider.', expect: 'The wallet connects.', check: { kind: 'rpc', value: 'eth_requestAccounts' } },
  { id: 's4', title: 'Pay with stablecoins', how: 'Pay with stablecoins, pick USDC.', expect: 'The Approve and register dialog.', check: { kind: 'text', value: 'Approve and register' } },
  { id: 's5', title: 'Approve the transactions', how: 'Approve each transaction in this sidebar.', expect: 'Registration Complete.', check: { kind: 'text', value: 'Registration Complete' } },
  { id: 's6', title: 'The name looks right', how: 'Check the success page.', expect: 'The name, owner and expiry are right.', check: { kind: 'manual' } },
]

async function preflight() {
  const up = await fetch(url).then((r) => r.ok || r.status < 500, () => false)
  if (!up) throw new Error(`the manager is not answering on ${url}. Start it: pnpm --filter manager dev -- --port ${new URL(url).port || 3000} --mode ci`)
  if (mode !== 'mock') return
  if (!existsSync(path.join(modules, '@ensdomains', 'headless-web3-provider'))) throw new Error(`no e2e packages in ${modules}: run pnpm install in ${repo}`)
  const call = (method, params) => fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json())
  const chain = await call('eth_chainId', []).catch(() => null)
  if (!chain?.result) throw new Error(`the local chain is not answering on ${rpc}. Start the e2e stack: pnpm e2e:infra:up`)
  // account 0 carries leftover code on the Sepolia fork; the e2e fixture clears it the same way
  await call('anvil_setCode', ['0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', '0x']).catch(() => undefined)
}

function startSession() {
  const dir = path.join(out, 'session')
  mkdirSync(dir, { recursive: true })
  copyFileSync(path.join(HERE, '..', 'src', 'runner', 'human-session.mjs'), path.join(dir, 'session.mjs'))
  copyFileSync(path.join(HERE, '..', 'src', 'runner', 'human-page.js'), path.join(dir, 'human-page.js'))
  rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true })
  symlinkSync(modules, path.join(dir, 'node_modules'), 'dir')
  const config = path.join(dir, 'config.json')
  writeFileSync(config, JSON.stringify({ url, mode, steps, outDir: path.join(out, 'certificate'), wallet: mode === 'mock' ? { rpc } : null, title: `Register ${label}.eth in the manager` }))
  const child = spawn(process.execPath, [path.join(dir, 'session.mjs'), config], { cwd: dir, env: { ...process.env, METWO_CDP_PORT: String(cdpPort) }, stdio: ['pipe', 'pipe', 'inherit'] })
  const events = []
  let ready
  const isReady = new Promise((r) => (ready = r))
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const e = JSON.parse(line)
      events.push({ ...e, t: (Date.now() - t0) / 1000 })
      if (e.type === 'ready') ready()
      if (e.type === 'step') mark(`mevo: ${e.id} ${e.status} (${e.how})`)
      if (e.type === 'error') console.log(`  page: ${e.text}`)
    } catch {}
  })
  const done = new Promise((r) => child.on('exit', r))
  return { child, events, isReady, done }
}

// a cursor people can see, drawn in the page (the real one is not in the recording)
const CURSOR = () => {
  if (window.__demoCursor) return
  window.__demoCursor = true
  const add = () => {
    const c = document.createElement('div')
    c.id = '__demo_cursor'
    c.style.cssText = 'position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);will-change:transform'
    c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2.5 L4 19.5 L8.6 15.3 L11.6 22 L14.6 20.7 L11.7 14.2 L18 14.2 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg><span style="position:absolute;left:-14px;top:-14px;width:28px;height:28px;border-radius:50%;background:rgba(124,92,255,.35);transform:scale(0);transition:transform .18s,opacity .35s;opacity:0"></span>'
    document.documentElement.appendChild(c)
    const ring = c.querySelector('span')
    addEventListener('mousemove', (e) => (c.style.transform = `translate(${e.clientX - 3}px,${e.clientY - 2}px)`), true)
    addEventListener('mousedown', () => {
      ring.style.transition = 'none'
      ring.style.transform = 'scale(.4)'
      ring.style.opacity = '1'
      requestAnimationFrame(() => {
        ring.style.transition = 'transform .35s ease-out,opacity .45s ease-out'
        ring.style.transform = 'scale(1.6)'
        ring.style.opacity = '0'
      })
    }, true)
  }
  if (document.documentElement) add()
  else addEventListener('DOMContentLoaded', add)
}

async function main() {
  mkdirSync(out, { recursive: true })
  console.log(`recording to ${out}\nname: ${label}.eth · ${mode} · ${url}`)
  await preflight()
  const session = startSession()
  await Promise.race([session.isReady, session.done.then(() => Promise.reject(new Error('the mevo session exited before it was ready')))])
  mark('session ready')

  let browser
  for (let i = 0; i < 40 && !browser; i++) browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`).catch(() => sleep(500).then(() => null))
  if (!browser) throw new Error('could not attach to the session browser')
  const context = browser.contexts()[0]
  const page = context.pages().filter((p) => p.url().startsWith(url)).at(-1) ?? context.pages().at(-1)
  await context.addInitScript(CURSOR)
  await page.evaluate(CURSOR)

  // a fixed 16:9 page, and the window around it
  const cdp = await context.newCDPSession(page)
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget')
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } })
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 40, top: 40, width: W + 40, height: H + 140 } })
  } catch {}
  // after the window settles, or the resize undoes it
  await sleep(600)
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1.2, mobile: false })
  await sleep(600)

  // the recording: every frame Chrome paints, as JPEG, with its time
  const video = createWriteStream(path.join(out, 'screen.mjpeg'))
  const frames = []
  let recording = true
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    if (recording) {
      video.write(Buffer.from(data, 'base64'))
      frames.push(metadata.timestamp)
    }
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 })

  let pos = { x: W / 2, y: H / 2 }
  await page.mouse.move(pos.x, pos.y)
  const glide = async (x, y) => {
    const d = Math.hypot(x - pos.x, y - pos.y)
    const n = Math.max(8, Math.min(45, Math.round(d / 14)))
    for (let i = 1; i <= n; i++) {
      const k = i / n
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2
      await page.mouse.move(pos.x + (x - pos.x) * e, pos.y + (y - pos.y) * e)
      await sleep(12)
    }
    pos = { x, y }
  }
  const center = async (loc) => {
    await loc.waitFor({ state: 'visible', timeout: 30_000 })
    await loc.scrollIntoViewIfNeeded().catch(() => {})
    const b = await loc.boundingBox()
    if (!b) throw new Error('not on screen')
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  }
  const click = async (loc, why) => {
    const c = await center(loc)
    if (why) mark(why)
    await glide(c.x, c.y)
    await sleep(280)
    await page.mouse.down()
    await sleep(70)
    await page.mouse.up()
    await sleep(350)
  }
  const type = async (text) => page.keyboard.type(text, { delay: 110 })
  const tick = (i, timeout = 30_000) =>
    page.waitForFunction((n) => document.querySelector('mevo-test')?.shadowRoot?.querySelectorAll('.step')[n]?.classList.contains('done'), i, { timeout, polling: 250 }).then(
      () => sleep(900),
      () => mark(`(step ${i + 1} was not ticked by mevo)`),
    )
  const side = (act) => page.locator(`mevo-test button[data-act="${act}"]`).first()
  const visible = (loc) => loc.isVisible().catch(() => false)

  // the app only: mevo's sidebar hangs off <html>, outside <body>, and repeats some of the same words
  const app = page.locator('body')
  try {
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {})
    await sleep(1500)
    mark('home')

    // 1. search
    const search = app.getByPlaceholder('.eth').first().or(app.getByPlaceholder('Search name, address...').first())
    await click(search.first(), 'search')
    await type(label)
    await app.getByText('Available').first().waitFor({ state: 'visible', timeout: 20_000 })
    await tick(0)

    // 2. the register page
    const result = app.getByText(`${label}.eth`).first()
    if (await visible(result)) await click(result, 'open the name')
    else await page.keyboard.press('Enter')
    if (!(await page.waitForURL(/\/register\//, { timeout: 8000 }).then(() => true, () => false))) await page.goto(`${url}/register/${label}`)
    await page.evaluate(CURSOR)
    await page.mouse.move(pos.x, pos.y)
    await tick(1)

    // 3. connect the test wallet
    const connect = app.getByRole('button', { name: /connect to register/i })
    const headless = app.getByText('Headless Web3 Provider')
    for (let i = 0; i < 8 && !(await visible(headless)); i++) {
      if (await visible(connect)) await click(connect, 'connect to register')
      await headless.waitFor({ state: 'visible', timeout: 4000 }).catch(() => {})
    }
    await click(headless, 'pick the headless wallet')
    await tick(2)
    // the app asks to sign in to its backend; the e2e skips it with its hidden key sequence
    const verify = app.getByRole('alertdialog', { name: 'Verify your wallet' })
    if (await verify.waitFor({ state: 'visible', timeout: 45_000 }).then(() => true, () => false)) {
      mark('skip the sign-in prompt')
      await sleep(800)
      await page.keyboard.type('skip', { delay: 60 })
      await app.locator('[data-slot="alert-dialog-overlay"]').waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {})
    }

    // 4. pay with stablecoins
    await click(app.getByRole('button', { name: /pay with stablecoins/i }), 'pay with stablecoins')
    const enable = app.getByRole('button', { name: /enable sessions/i })
    if (await enable.waitFor({ state: 'visible', timeout: 6000 }).then(() => true, () => false)) await click(enable, 'enable sessions')
    const usdc = app.getByRole('button', { name: 'Select USDC', exact: true })
    await usdc.or(app.getByText(/No additional payment needed/)).first().waitFor({ timeout: 30_000 })
    if (await visible(usdc)) await click(usdc, 'pick USDC')
    await tick(3)
    await click(app.getByRole('dialog', { name: 'Approve and register name' }).getByRole('button', { name: /^(approve and register|sign payment approval|register name)$/i }), 'approve and register')
    const later = app.getByRole('button', { name: 'Set up later' })
    if (await later.waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false)) await click(later, 'notifications: set up later')

    // 5. approve each transaction in mevo's sidebar until it is registered
    const success = app.getByRole('status').filter({ hasText: 'Registration Complete' })
    const failure = app.getByText('Registration Failed').first()
    const until = Date.now() + 6 * 60_000
    let idle = null
    while (Date.now() < until) {
      if (await visible(success)) break
      if (await visible(failure)) throw new Error('the app says Registration Failed')
      if (await visible(side('approve'))) {
        if (idle) mark(`wait ended (${((Date.now() - idle) / 1000).toFixed(0)}s)`)
        idle = null
        await click(side('approve'), 'approve the transaction in mevo')
        await sleep(1200)
        continue
      }
      if (!idle) {
        idle = Date.now()
        mark('waiting')
      }
      await sleep(400)
    }
    if (idle) mark(`wait ended (${((Date.now() - idle) / 1000).toFixed(0)}s)`)
    if (!(await visible(success))) throw new Error('no Registration Complete after 6 minutes')
    mark('registered')
    await tick(4)

    // 6. look at the result and mark the last step by hand
    await glide((await center(success)).x, (await center(success)).y)
    await sleep(1500)
    await click(page.locator('mevo-test input.note').first(), 'write a note')
    await type('name, owner and expiry look right')
    await sleep(400)
    await click(side('done'), 'mark it done')
    await sleep(1500)
    await click(side('finish'), 'finish')
  } catch (error) {
    mark(`stopped: ${error.message}`)
    await page.screenshot({ path: path.join(out, 'stopped-here.png') }).catch(() => {})
    console.log('\nThe browser stays open: finish the test by hand in the sidebar, or close the window.')
  }

  await session.done
  recording = false
  video.end()
  const certificate = session.events.filter((e) => e.type === 'step' || e.type === 'done' || e.type === 'tx')
  writeFileSync(path.join(out, 'timeline.json'), JSON.stringify({ label, mode, url, size: [1920, 1080], frames, markers, certificate }, null, 1))
  await browser.close().catch(() => {})
  const secs = frames.length > 1 ? frames.at(-1) - frames[0] : 0
  console.log(`\ndone: ${frames.length} frames, ${secs.toFixed(0)}s of screen in ${path.join(out, 'screen.mjpeg')}`)
  console.log(`the certificate (screenshots per step, the session video) is in ${path.join(out, 'certificate')}`)
}

main().catch((e) => {
  console.error(`\n${e.message}`)
  process.exit(1)
})
