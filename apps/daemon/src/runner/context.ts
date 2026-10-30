import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Ticket } from '@ticketflow/shared'
import type { Linear, LinearComment } from '../linear.js'
import { log } from '../log.js'

export interface TicketContext {
  // absolute paths of images saved next to the brief, with where they came from
  readonly images: readonly { readonly file: string; readonly from: string }[]
  readonly comments: readonly LinearComment[]
}

const IMAGE_MD = /!\[[^\]]*\]\((\S+?)(?:\s+"[^"]*")?\)/g
const LINEAR_UPLOAD = /https:\/\/uploads\.linear\.app\/[^\s)"'>]+/g
const MAX_IMAGES = 12

const EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

function imageUrls(...texts: readonly string[]): readonly string[] {
  const found = new Set<string>()
  for (const text of texts) {
    for (const m of text.matchAll(IMAGE_MD)) if (m[1]) found.add(m[1])
    for (const m of text.matchAll(LINEAR_UPLOAD)) found.add(m[0])
  }
  return [...found].filter((u) => u.startsWith('https://')).slice(0, MAX_IMAGES)
}

// Screenshots and mockups in the ticket are often the real spec; give them to the lane.
// Best effort: a failed download never blocks the lane.
export async function gatherContext(linear: Linear, ticket: Ticket, flowDir: string): Promise<TicketContext> {
  let comments: readonly LinearComment[] = []
  try {
    comments = await linear.humanComments(ticket.uuid)
  } catch (error) {
    log.warn(`${ticket.id}: could not load Linear comments`, error)
  }
  const urls = imageUrls(ticket.description, ...comments.map((c) => c.body))
  const dir = path.join(flowDir, 'images')
  const images: { file: string; from: string }[] = []
  for (const [i, url] of urls.entries()) {
    try {
      const got = await linear.download(url)
      if (!got || !got.type.startsWith('image/')) continue
      mkdirSync(dir, { recursive: true })
      const file = path.join(dir, `${String(i + 1).padStart(2, '0')}.${EXT[got.type.split(';')[0] ?? ''] ?? 'png'}`)
      writeFileSync(file, got.bytes)
      images.push({ file, from: url })
    } catch (error) {
      log.warn(`${ticket.id}: image download failed ${url}`, error)
    }
  }
  return { images, comments }
}

export function contextSection(ctx: TicketContext): string {
  const parts: string[] = []
  if (ctx.images.length > 0) {
    parts.push(`## Images attached to the ticket
Open each one with the Read tool before planning; they are often the actual spec
(mockups, screenshots of the bug, expected vs actual):
${ctx.images.map((img) => `- ${img.file}`).join('\n')}`)
  }
  if (ctx.comments.length > 0) {
    parts.push(`## Discussion on the Linear issue (oldest first)
Later comments can narrow or change the scope in the description; the latest word wins.
${ctx.comments.map((c) => `### ${c.author} · ${c.createdAt.slice(0, 10)}\n${c.body.trim().slice(0, 2000)}`).join('\n\n')}`)
  }
  return parts.join('\n\n')
}
