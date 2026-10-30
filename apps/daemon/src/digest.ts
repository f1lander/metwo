import type { Digest, Ticket } from '@ticketflow/shared'

const NEEDS_ME = new Set(['assigned', 'needs_input', 'review_ready', 'no_change', 'failed', 'stopped'])

function localDay(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

export function computeDigest(tickets: readonly Ticket[], now = new Date()): Digest {
  const today = localDay(now)
  const isToday = (iso: string) => localDay(iso) === today
  const label = (t: Ticket) => `${t.id} ${t.title}`
  let costToday = 0
  let lanesToday = 0
  const closed: string[] = []
  for (const t of tickets) {
    const todays = (t.journal ?? []).filter((j) => isToday(j.at))
    for (const j of todays) {
      if (j.kind === 'run' || j.kind === 'review') {
        if (j.kind === 'run') lanesToday++
        const cost = Number(j.meta?.cost ?? 0)
        if (Number.isFinite(cost)) costToday += cost
      }
    }
    const movedToday = todays.find((j) => j.kind === 'linear')
    if (movedToday) closed.push(`${label(t)} → ${movedToday.title.replace(/^Moved to | in Linear$/g, '')}`)
    else if (t.status === 'done' && isToday(t.updatedAt)) closed.push(label(t))
  }
  return {
    closed,
    waiting: tickets.filter((t) => NEEDS_ME.has(t.status)).map((t) => `${label(t)} · ${t.status.replace('_', ' ')}`),
    running: tickets.filter((t) => t.status === 'running' || t.status === 'queued').map(label),
    prsOpen: tickets
      .filter((t) => t.status === 'pr_draft')
      .map((t) => {
        const notes = [t.pr?.ci && t.pr.ci !== 'none' ? `CI ${t.pr.ci}` : null, t.pr?.comments.filter((c) => !c.bot).length ? `${t.pr.comments.filter((c) => !c.bot).length} comment(s)` : null].filter(Boolean)
        return `${label(t)}${notes.length ? ` · ${notes.join(', ')}` : ''}`
      }),
    costToday: Math.round(costToday * 100) / 100,
    lanesToday,
  }
}

export function formatDigest(d: Digest): string {
  const block = (title: string, items: readonly string[]) => (items.length ? `${title}\n${items.map((i) => `• ${i}`).join('\n')}` : null)
  const parts = [
    '📋 metwo · today',
    block(`✅ Closed (${d.closed.length})`, d.closed),
    block(`🙋 Waiting on you (${d.waiting.length})`, d.waiting),
    block(`⟳ Running (${d.running.length})`, d.running),
    block(`🔀 Draft PRs (${d.prsOpen.length})`, d.prsOpen),
    `${d.lanesToday} lane turn(s) · $${d.costToday.toFixed(2)} in Claude today`,
  ].filter(Boolean)
  return parts.length === 2 ? `${parts[0]}\nQuiet day: nothing moved.\n${parts[1]}` : parts.join('\n\n')
}

// Fires once a day at "HH:MM" local time. Checked every 30s, remembers the day it last sent.
export function scheduleDaily(at: string, send: () => Promise<void>): void {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at)
  if (!m) throw new Error(`pipeline.digestAt must be "HH:MM", got "${at}"`)
  const [hh, mm] = [Number(m[1]), Number(m[2])]
  let sentOn = ''
  setInterval(() => {
    const now = new Date()
    const day = localDay(now)
    const due = now.getHours() > hh || (now.getHours() === hh && now.getMinutes() >= mm)
    // start-up after the hour counts as already sent, so a restart at 19:00 does not re-send
    if (!sentOn) sentOn = due ? day : 'pending'
    if (due && sentOn !== day) {
      sentOn = day
      void send()
    }
  }, 30_000)
}
