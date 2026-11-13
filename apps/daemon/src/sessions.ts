import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

// Phone sign-in without sending the dashboard token around: Telegram gets a one-time code
// (10 minutes, single use) that the browser trades for its own session. Sessions last 30 days,
// are stored hashed, and "sign out everywhere" drops them all.
const CODE_MS = 10 * 60_000
const SESSION_MS = 30 * 24 * 60 * 60_000

interface Session {
  readonly hash: string
  readonly created: string
  lastSeen: string
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

export class Sessions {
  private readonly file: string
  private readonly codes = new Map<string, number>()
  private list: Session[]

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'sessions.json')
    try {
      this.list = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as Session[]) : []
    } catch {
      this.list = []
    }
  }

  issueCode(): string {
    const now = Date.now()
    for (const [c, exp] of this.codes) if (exp < now) this.codes.delete(c)
    const code = randomBytes(16).toString('hex')
    this.codes.set(sha(code), now + CODE_MS)
    return code
  }

  // the code's session id, or null when it is unknown, used or expired
  redeem(code: string): string | null {
    const key = sha(code)
    const exp = this.codes.get(key)
    this.codes.delete(key)
    if (!exp || exp < Date.now()) return null
    return this.create()
  }

  create(): string {
    const id = randomBytes(32).toString('hex')
    const now = new Date().toISOString()
    this.list.push({ hash: sha(id), created: now, lastSeen: now })
    this.save()
    return id
  }

  valid(id: string): boolean {
    const now = Date.now()
    const s = this.list.find((x) => x.hash === sha(id))
    if (!s || now - new Date(s.created).getTime() > SESSION_MS) return false
    // keep lastSeen roughly current without writing on every request
    if (now - new Date(s.lastSeen).getTime() > 60 * 60_000) {
      s.lastSeen = new Date().toISOString()
      this.save()
    }
    return true
  }

  revokeAll(): number {
    const n = this.list.length
    this.list = []
    this.codes.clear()
    this.save()
    return n
  }

  get count(): number {
    return this.list.filter((s) => Date.now() - new Date(s.created).getTime() <= SESSION_MS).length
  }

  private save(): void {
    this.list = this.list.filter((s) => Date.now() - new Date(s.created).getTime() <= SESSION_MS)
    writeFileSync(this.file, JSON.stringify(this.list, null, 2), { mode: 0o600 })
  }
}
