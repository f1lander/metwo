import { EventEmitter } from 'node:events'

import type { LiveLine } from '@ticketflow/shared'

export type { LiveLine }

// In-memory ring buffer per ticket of what the lane is doing right now. Not persisted:
// the full record is the lane.jsonl in the flow dir.
export class LiveLog extends EventEmitter {
  private readonly lines = new Map<string, LiveLine[]>()

  constructor(private readonly max = 300) {
    super()
  }

  push(id: string, kind: LiveLine['kind'], text: string): void {
    const line: LiveLine = { at: new Date().toISOString(), kind, text }
    const buf = this.lines.get(id) ?? []
    buf.push(line)
    if (buf.length > this.max) buf.splice(0, buf.length - this.max)
    this.lines.set(id, buf)
    this.emit('line', id, line)
  }

  recent(id: string, n = this.max): readonly LiveLine[] {
    return (this.lines.get(id) ?? []).slice(-n)
  }

  // every line after `since`, oldest first; what the polling board asks for
  since(since: string, cap = 500): readonly { id: string; line: LiveLine }[] {
    const out: { id: string; line: LiveLine }[] = []
    for (const [id, buf] of this.lines) for (const line of buf) if (line.at > since) out.push({ id, line })
    return out.sort((a, b) => a.line.at.localeCompare(b.line.at)).slice(-cap)
  }

  last(id: string): LiveLine | undefined {
    return this.lines.get(id)?.at(-1)
  }
}
