// App-wide messages for the toast stack: failures you need to see, and confirmations.
export type NoticeTone = 'ok' | 'bad' | 'warn' | 'accent'
export interface Notice {
  readonly id?: string
  readonly title: string
  readonly detail?: string
  readonly tone: NoticeTone
}

const listeners = new Set<(n: Notice) => void>()

export function notice(n: Notice): void {
  for (const l of listeners) l(n)
}

export function failed(err: unknown, id?: string): void {
  const text = err instanceof Error ? err.message : String(err)
  notice({ ...(id ? { id } : {}), title: id ? `${id}: that did not work` : 'That did not work', detail: text, tone: 'bad' })
}

export function onNotice(fn: (n: Notice) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
