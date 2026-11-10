import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { log } from './log.js'

// Append-only record of everything that happens, one JSON line each, a file per month
// (data/history/2026-11.jsonl). Never rewritten or pruned; it is what stats are built from.
export interface HistoryEntry {
  readonly type: 'event' | 'journal' | 'status' | 'action' | 'settings' | 'spend' | 'review'
  readonly ticket?: string | undefined
  readonly [key: string]: unknown
}

export class History {
  readonly dir: string

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'history')
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
  }

  record(entry: HistoryEntry): void {
    const at = new Date().toISOString()
    try {
      appendFileSync(path.join(this.dir, `${at.slice(0, 7)}.jsonl`), `${JSON.stringify({ at, ...entry })}\n`, { mode: 0o600 })
    } catch (error) {
      log.warn('history: could not append', error)
    }
  }

  // A closed ticket's lane, review and supervisor logs, gzipped, so they outlive the worktree.
  archiveLogs(ticket: string, flowDir: string): number {
    const from = path.join(flowDir, 'logs')
    if (!existsSync(from)) return 0
    const to = path.join(this.dir, 'lanes', ticket)
    mkdirSync(to, { recursive: true })
    let n = 0
    for (const name of readdirSync(from)) {
      if (!name.endsWith('.jsonl')) continue
      writeFileSync(path.join(to, `${name}.gz`), gzipSync(readFileSync(path.join(from, name))))
      n++
    }
    return n
  }
}
