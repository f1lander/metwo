import { connect } from 'node:net'
import type { CheckState, Health } from '@ticketflow/shared'
import type { Config } from './config.js'
import { sh } from './runner/shell.js'

const now = () => new Date().toISOString()
const unknown = (detail = 'not checked yet'): CheckState => ({ ok: null, detail, at: null })

// The daemon records what it already observes (polls, sends, lane results) and runs a few
// cheap probes on a timer (gh auth, e2e ports). Nothing here spends model tokens.
export class HealthTracker {
  private readonly startedAt = now()
  telegram: CheckState & { bot: string | null } = { ...unknown(), bot: null }
  linear: CheckState & { lastPollAt: string | null; tracked: number } = { ...unknown(), lastPollAt: null, tracked: 0 }
  github: CheckState = unknown()
  claude: CheckState = unknown('known after the first lane runs')
  e2e: CheckState & { ports: Record<string, boolean> } = { ...unknown(), ports: {} }
  tunnel: CheckState & { url: string | null } = { ...unknown('off'), url: null }
  prSync: CheckState = unknown()
  mainSync: CheckState = unknown()
  reviews: CheckState = unknown()
  uploads: CheckState & { login: string | null } = { ...unknown(), login: null }

  constructor(private readonly cfg: Config) {}

  ok(): CheckState {
    return { ok: true, detail: 'ok', at: now() }
  }

  bad(detail: string): CheckState {
    return { ok: false, detail: detail.slice(0, 300), at: now() }
  }

  async probe(): Promise<void> {
    await Promise.all([this.probeGithub(), this.probeE2e(), this.probeClaude()])
  }

  // Cheap: proves the CLI is on the daemon's PATH. Login state is only known once a lane
  // talks to the API, so a lane result (ok or auth failure) always wins over this probe.
  private claudeFromLane = false

  markClaudeFromLane(state: CheckState): void {
    this.claudeFromLane = true
    this.claude = state
  }

  private async probeClaude(): Promise<void> {
    try {
      const { stdout } = await sh('claude', ['--version'], this.cfg.repo.path)
      const version = stdout.split('\n')[0]?.trim() || 'installed'
      if (!this.claudeFromLane || this.claude.ok !== false) {
        this.claude = { ok: true, detail: this.claudeFromLane ? this.claude.detail : `${version} · login is confirmed on the first lane`, at: now() }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.claude = this.bad(
        message.includes('ENOENT')
          ? 'claude CLI not found on the daemon PATH. Check `which claude` in a terminal; if it lives in a folder your shell adds in .zshrc, the app picks it up on restart.'
          : `claude --version failed: ${message.split('\n')[0]}`,
      )
    }
  }

  private async probeGithub(): Promise<void> {
    try {
      const { stdout, stderr } = await sh('gh', ['auth', 'status'], this.cfg.repo.path)
      const account = /account (\S+)/.exec(`${stdout}\n${stderr}`)?.[1] ?? /as (\S+)/.exec(`${stdout}\n${stderr}`)?.[1]
      this.github = { ok: true, detail: account ? `signed in as ${account}` : 'signed in', at: now() }
    } catch (error) {
      this.github = this.bad(error instanceof Error ? error.message.split('\n').slice(-2).join(' ') : String(error))
    }
  }

  private async probeE2e(): Promise<void> {
    const e2e = this.cfg.e2e
    if (!e2e || Object.keys(e2e.ports).length === 0) {
      this.e2e = { ok: null, detail: 'not set up (e2e in the config)', at: now(), ports: {} }
      return
    }
    const ports = e2e.ports
    const entries = await Promise.all(Object.entries(ports).map(async ([name, port]) => [name, await isOpen(port)] as const))
    const map = Object.fromEntries(entries)
    const down = entries.filter(([, up]) => !up).map(([n]) => n)
    this.e2e = {
      ok: down.length === 0,
      detail: down.length === 0 ? `${Object.keys(ports).join(', ')} up` : `down: ${down.join(', ')}${e2e.up ? ` (${e2e.up})` : ''}`,
      at: now(),
      ports: map,
    }
  }

  snapshot(lanes: Health['lanes']): Health {
    return {
      startedAt: this.startedAt,
      pid: process.pid,
      version: '0.2.0',
      daemon: { ok: true, detail: `up since ${this.startedAt.slice(11, 19)} UTC`, at: now() },
      telegram: this.telegram,
      linear: this.linear,
      github: this.github,
      claude: this.claude,
      e2e: this.e2e,
      tunnel: this.tunnel,
      lanes,
      prSync: this.prSync,
      mainSync: this.mainSync,
      reviews: this.reviews,
      uploads: this.uploads,
    }
  }
}

function isOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' })
    const done = (up: boolean) => {
      socket.destroy()
      resolve(up)
    }
    socket.setTimeout(800, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}
