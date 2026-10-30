import { type ChildProcess, spawn } from 'node:child_process'
import { log } from './log.js'

// Cloudflare quick tunnel: no account, no DNS, a random https://*.trycloudflare.com URL that
// changes on every restart. Needs `brew install cloudflared`. Only ever started with a token set.
export class Tunnel {
  private child: ChildProcess | null = null
  url: string | null = null

  constructor(private readonly port: number, private readonly onUrl: (url: string) => void) {}

  start(): void {
    const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://localhost:${this.port}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    const scan = (chunk: Buffer) => {
      const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(chunk.toString())
      if (match && match[0] !== this.url) {
        this.url = match[0]
        log.info(`tunnel ${this.url}`)
        this.onUrl(this.url)
      }
    }
    child.stdout?.on('data', scan)
    child.stderr?.on('data', scan)
    child.on('error', (e) => log.warn('cloudflared failed to start (brew install cloudflared)', e.message))
    child.on('exit', (code) => {
      log.warn(`cloudflared exited ${code}; restarting in 10s`)
      this.url = null
      this.child = null
      setTimeout(() => this.start(), 10_000)
    })
  }

  stop(): void {
    this.child?.removeAllListeners('exit')
    this.child?.kill()
  }
}
