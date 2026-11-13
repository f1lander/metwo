import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { CodeState } from '@ticketflow/shared'

// What the daemon loaded at boot: its own code, the shared packages, the config and .env.
// Files that change after that need a restart to count.
const SKIP = new Set(['node_modules', 'dist', '.turbo', 'coverage'])
const CODE = /\.(ts|tsx|mts|js|mjs|cjs|json)$/

function walk(dir: string, out: Map<string, string>, root: string): void {
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (SKIP.has(e.name) || e.name.startsWith('.')) continue
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, out, root)
    else if (CODE.test(e.name) && !/\.(test|spec|stories)\.tsx?$/.test(e.name)) stamp(p, out, root)
  }
}

function stamp(p: string, out: Map<string, string>, root: string): void {
  try {
    const s = statSync(p)
    out.set(path.relative(root, p), `${s.mtimeMs}:${s.size}`)
  } catch {
    // gone: not part of the picture
  }
}

export function fingerprint(root: string): Map<string, string> {
  const out = new Map<string, string>()
  walk(path.join(root, 'apps', 'daemon', 'src'), out, root)
  stamp(path.join(root, 'apps', 'daemon', 'package.json'), out, root)
  let pkgs: string[] = []
  try {
    pkgs = readdirSync(path.join(root, 'packages'))
  } catch {
    // no packages folder
  }
  for (const p of pkgs) {
    walk(path.join(root, 'packages', p, 'src'), out, root)
    stamp(path.join(root, 'packages', p, 'package.json'), out, root)
  }
  stamp(path.join(root, 'ticketflow.config.json'), out, root)
  stamp(path.join(root, '.env'), out, root)
  return out
}

// The app's build: when it changes, an open window is showing the old one.
function webBuild(root: string): string | null {
  try {
    return String(statSync(path.join(root, 'apps', 'web', 'dist', 'index.html')).mtimeMs)
  } catch {
    return null
  }
}

export class CodeWatch {
  private readonly boot: Map<string, string>
  private readonly bootedAt = new Date().toISOString()
  private since: string | null = null
  private files: string[] = []
  private prev = ''
  // nothing changed between the last two checks: the edit is finished, not half written
  settled = false

  constructor(private readonly root: string) {
    this.boot = fingerprint(root)
  }

  check(): CodeState {
    const now = fingerprint(this.root)
    const sig = [...now.entries()].map((e) => e.join('=')).join('\n')
    this.settled = sig === this.prev
    this.prev = sig
    const changed = [...new Set([...now.keys(), ...this.boot.keys()])].filter((f) => now.get(f) !== this.boot.get(f))
    if (changed.length && !this.since) this.since = new Date().toISOString()
    this.files = changed.slice(0, 8)
    return this.state(changed.length)
  }

  state(count = this.files.length): CodeState {
    return { bootedAt: this.bootedAt, stale: count > 0, since: count ? this.since : null, files: this.files, changed: count, web: webBuild(this.root), supervised: process.env.METWO_SUPERVISED === '1' }
  }
}
