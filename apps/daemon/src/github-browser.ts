import { execFileSync, spawn } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { type BrowserContext, chromium, type Locator, type Page } from 'playwright'
import { log } from './log.js'

export interface UploadedMedia {
  readonly name: string
  readonly url: string
  readonly kind: 'image' | 'video'
}

class GithubSignedOut extends Error {
  constructor() {
    super('the mevo GitHub browser is signed out; sign in again from Health or with /ghlogin')
  }
}

const ATTACHMENT = /https:\/\/github\.com\/user-attachments\/(?:assets|files)\/[\w-]+(?:\/[^\s)"'<>]+)?/g
const COMPOSER = ['textarea#new_comment_field', 'textarea[name="comment[body]"]', 'textarea[aria-label="Markdown value"]', 'textarea[placeholder*="comment" i]']
const VIDEO = /\.(mp4|mov|webm)$/i
const MAX_BYTES = 10 * 1024 * 1024

// GitHub only attaches files through its web composer, so mevo drives one: a Chromium with its
// own profile (signed in once by you), the comment box on the PR, and the same file input a drag
// and drop uses. The comment is never posted; the box is emptied once the links are read.
export class GithubBrowser {
  private busy: Promise<unknown> = Promise.resolve()

  constructor(private readonly profileDir: string) {}

  // Runs one browser job at a time: a persistent profile can only be opened once.
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const next = this.busy.then(job, job)
    this.busy = next.catch(() => undefined)
    return next
  }

  private async open(headless: boolean): Promise<BrowserContext> {
    // the real keychain, so cookies saved by the sign-in Chrome (plain, not automated) decrypt here
    const opts = { headless, viewport: { width: 1280, height: 900 }, ignoreDefaultArgs: process.platform === 'darwin' ? ['--use-mock-keychain'] : [] }
    const exe = process.env.METWO_CHROMIUM
    if (exe) return chromium.launchPersistentContext(this.profileDir, { ...opts, executablePath: exe })
    try {
      // your installed Chrome first: it needs no extra download and looks like a normal browser
      return await chromium.launchPersistentContext(this.profileDir, { ...opts, channel: 'chrome' })
    } catch {
      return chromium.launchPersistentContext(this.profileDir, opts)
    }
  }

  private static async login(ctx: BrowserContext): Promise<string | null> {
    const cookies = await ctx.cookies('https://github.com')
    const signedIn = cookies.some((c) => c.name === 'logged_in' && c.value === 'yes')
    return signedIn ? (cookies.find((c) => c.name === 'dotcom_user')?.value ?? 'signed in') : null
  }

  status(): Promise<string | null> {
    return this.serial(async () => {
      const ctx = await this.open(true)
      try {
        return await GithubBrowser.login(ctx)
      } finally {
        await ctx.close()
      }
    })
  }

  // Sign-in runs in a plain Chrome window, not an automated one: Google (and "Continue with
  // Google" on GitHub) refuses browsers driven by automation. You sign in, close the window,
  // and the session is read from the profile.
  signIn(timeoutMs = 10 * 60_000): Promise<string> {
    const chrome = process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    if (process.platform === 'darwin' && existsSync(chrome)) {
      return this.serial(async () => {
        await new Promise<void>((resolve, reject) => {
          const startedAt = Date.now()
          const child = spawn(chrome, [`--user-data-dir=${this.profileDir}`, '--no-first-run', '--no-default-browser-check', '--new-window', 'https://github.com/login'], { stdio: 'ignore' })
          const timer = setTimeout(() => {
            child.kill()
            reject(new Error('timed out waiting for the GitHub sign-in window to close'))
          }, timeoutMs)
          child.once('error', (e) => {
            clearTimeout(timer)
            reject(e)
          })
          // Chrome writes cookies to disk every few seconds: once the session shows up there,
          // quit the window ourselves (SIGTERM is a normal Chrome shutdown, which saves the rest)
          const watch = setInterval(() => {
            if (!hasGithubSession(this.profileDir, startedAt)) return
            clearInterval(watch)
            setTimeout(() => child.kill('SIGTERM'), 2500)
          }, 2000)
          child.once('exit', () => {
            clearInterval(watch)
            clearTimeout(timer)
            resolve()
          })
        })
        const ctx = await this.open(true)
        try {
          const who = await GithubBrowser.login(ctx)
          if (!who) throw new Error('the window closed without a GitHub session; sign in on github.com before closing it')
          return who
        } finally {
          await ctx.close().catch(() => undefined)
        }
      })
    }
    return this.serial(async () => {
      const ctx = await this.open(false)
      try {
        const page = ctx.pages()[0] ?? (await ctx.newPage())
        await page.goto('https://github.com/login')
        const until = Date.now() + timeoutMs
        while (Date.now() < until) {
          const who = await GithubBrowser.login(ctx)
          if (who) return who
          if (ctx.pages().length === 0) throw new Error('the sign-in window was closed before signing in')
          await new Promise((r) => setTimeout(r, 1500))
        }
        throw new Error('timed out waiting for the GitHub sign-in')
      } finally {
        await ctx.close().catch(() => undefined)
      }
    })
  }

  // One file at a time, so each link maps to its file without guessing from GitHub's markup.
  upload(prUrl: string, files: readonly string[]): Promise<readonly UploadedMedia[]> {
    return this.serial(async () => {
      const ctx = await this.open(true)
      try {
        if (!(await GithubBrowser.login(ctx))) throw new GithubSignedOut()
        const page = ctx.pages()[0] ?? (await ctx.newPage())
        await page.goto(prUrl, { waitUntil: 'domcontentloaded' })
        const box = await findComposer(page)
        if (!box) throw new Error('could not find the comment box on the PR page (GitHub may have changed its layout)')
        const out: UploadedMedia[] = []
        for (const file of files) {
          const name = path.basename(file)
          if (statSync(file).size > MAX_BYTES) {
            log.warn(`skipping ${name}: over 10 MB, GitHub would reject it`)
            continue
          }
          const before = new Set((await box.inputValue()).match(ATTACHMENT) ?? [])
          await attach(page, box, file)
          const url = await waitForNewLink(box, before)
          out.push({ name, url, kind: VIDEO.test(name) ? 'video' : 'image' })
        }
        await box.fill('')
        return out
      } finally {
        await ctx.close().catch(() => undefined)
      }
    })
  }
}

// Reads only cookie names and times from a copy of the profile's cookie store (values stay
// encrypted): a logged_in cookie written after the window opened means you just signed in.
function hasGithubSession(profileDir: string, sinceMs: number): boolean {
  const db = path.join(profileDir, 'Default', 'Cookies')
  if (!existsSync(db)) return false
  const copy = path.join(os.tmpdir(), `metwo-cookies-${process.pid}.db`)
  try {
    copyFileSync(db, copy)
    // Chrome stores times as microseconds since 1601-01-01
    const since = (sinceMs + 11_644_473_600_000) * 1000
    const out = execFileSync('sqlite3', [copy, `select count(*) from cookies where host_key = '.github.com' and name = 'logged_in' and last_update_utc >= ${since};`], { encoding: 'utf8', timeout: 3000 })
    return Number(out.trim()) > 0
  } catch {
    return false
  } finally {
    rmSync(copy, { force: true })
  }
}

async function findComposer(page: Page): Promise<Locator | null> {
  for (const selector of COMPOSER) {
    const loc = page.locator(selector).last()
    try {
      await loc.waitFor({ state: 'attached', timeout: selector === COMPOSER[0] ? 15_000 : 3_000 })
      await loc.scrollIntoViewIfNeeded().catch(() => undefined)
      return loc
    } catch {
      // try the next layout
    }
  }
  return null
}

// The file input next to the box when there is one; otherwise a synthetic drop on the box,
// which is what GitHub's <file-attachment> listens for.
async function attach(page: Page, box: Locator, file: string): Promise<void> {
  const scoped = box.locator('xpath=ancestor::form[1]//input[@type="file"] | ancestor::file-attachment[1]//input[@type="file"]')
  if ((await scoped.count()) > 0) {
    await scoped.first().setInputFiles(file)
    return
  }
  const b64 = readFileSync(file).toString('base64')
  const name = path.basename(file)
  const type = VIDEO.test(name) ? (name.endsWith('.webm') ? 'video/webm' : name.endsWith('.mov') ? 'video/quicktime' : 'video/mp4') : name.endsWith('.gif') ? 'image/gif' : name.endsWith('.jpg') || name.endsWith('.jpeg') ? 'image/jpeg' : 'image/png'
  const handle = await box.elementHandle()
  if (!handle) throw new Error('comment box disappeared')
  await page.evaluate(
    ({ el, b64, name, type }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const dt = new DataTransfer()
      dt.items.add(new File([bytes], name, { type }))
      for (const kind of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(kind, { bubbles: true, cancelable: true, dataTransfer: dt }))
    },
    { el: handle, b64, name, type },
  )
}

async function waitForNewLink(box: Locator, before: ReadonlySet<string>, timeoutMs = 120_000): Promise<string> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const value = await box.inputValue()
    const fresh = (value.match(ATTACHMENT) ?? []).find((u) => !before.has(u))
    if (fresh && !/\[Uploading [^\]]*\]\(\)/.test(value)) return fresh
    if (/\[Upload failed|could not be uploaded|not supported/i.test(value)) throw new Error(`GitHub rejected the file: ${value.slice(-200)}`)
    await new Promise((r) => setTimeout(r, 700))
  }
  throw new Error('timed out waiting for GitHub to finish the upload')
}
