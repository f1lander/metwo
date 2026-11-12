import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'
import type { DescChange, MediaFile, Ticket } from '@ticketflow/shared'
import type { Config } from '../config.js'
import type { GithubBrowser } from '../github-browser.js'
import { log } from '../log.js'
import type { Store } from '../store.js'
import { buildPrBody, commentOnPr, editPrBody, livePrBody, mediaBlock, openDraftPr, prettyShot, type PrMedia, replyToReviewComment } from './github.js'
import { applyChanges } from './pr-desc.js'
import { listMedia, prMedia, uploadShots } from './shots.js'

// Everything that puts a ticket's work on its PR: the body, screenshots and videos, and the
// update comment after each push.
export class PrPublisher {
  constructor(
    private readonly config: () => Config,
    private readonly store: Store,
    private readonly flowDir: (id: string) => string,
    private readonly notify: { readonly uploads: (ok: boolean, detail: string) => void },
    private readonly browser: () => GithubBrowser | null,
  ) {}

  // the config with Settings on top
  private get cfg(): Config {
    return this.config()
  }

  laneBody(id: string): string | null {
    const bodyFile = path.join(this.flowDir(id), 'PR-BODY.md')
    return existsSync(bodyFile) ? readFileSync(bodyFile, 'utf8') : null
  }

  // A screenshot or video from the flow dir, by bare file name only.
  mediaFile(id: string, name: string): string | null {
    const safe = path.basename(name)
    const hit = listMedia(this.flowDir(id)).find((m) => path.basename(m.file) === safe)
    if (hit) return hit.file
    // what the page showed when a visual plan step failed, asked for as run--<name>
    if (safe.startsWith('run--')) {
      const run = path.join(this.flowDir(id), 'visual-run', 'after', safe.slice(5))
      return existsSync(run) ? run : null
    }
    // the previous visual run's shots, asked for as prev--<name>
    if (safe.startsWith('prev--')) {
      const prev = path.join(this.flowDir(id), 'shots-prev', safe.slice(6))
      return existsSync(prev) ? prev : null
    }
    // the preview QA round's shots, asked for as qa--<name>
    if (safe.startsWith('qa--')) {
      const qa = path.join(this.flowDir(id), 'qa', safe.slice(4))
      return existsSync(qa) ? qa : null
    }
    // screenshots you attached to an instruction
    const feedback = path.join(this.flowDir(id), 'feedback', safe)
    return existsSync(feedback) ? feedback : null
  }

  mediaList(id: string): readonly MediaFile[] {
    const current = listMedia(this.flowDir(id)).map((m) => {
      const st = statSync(m.file)
      return { name: path.basename(m.file), kind: m.kind, bytes: st.size, at: st.mtime.toISOString() }
    })
    const prevDir = path.join(this.flowDir(id), 'shots-prev')
    const previous = existsSync(prevDir)
      ? readdirSync(prevDir)
          .filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f))
          .map((f) => ({ previous: true, name: f, kind: 'image' as const, bytes: statSync(path.join(prevDir, f)).size, at: statSync(path.join(prevDir, f)).mtime.toISOString() }))
      : []
    return [...current, ...previous]
  }

  // What the PR will say before it exists: the lane's body with local media listed.
  previewBody(id: string): { body: string; media: readonly { name: string; kind: 'image' | 'video' }[] } {
    const ticket = this.store.get(id)
    if (!ticket) throw new Error(`unknown ticket ${id}`)
    const media = prMedia(this.flowDir(id), this.cfg.shots).map((m) => ({ name: path.basename(m.file), kind: m.kind }))
    const body = buildPrBody(ticket, ticket.summary ?? '', this.laneBody(id), media.map((m) => ({ ...m, url: `metwo-local:${m.name}` })))
    return { body, media }
  }

  // Opens the draft, then attaches screenshots and videos. Browser mode needs the PR page to
  // exist, so the body goes up with a marker and is edited once the media links are back.
  // Browser upload first, secret gist for images as the fallback; null when nothing could go up.
  // files into GitHub's own uploader on any PR (a review you post on a teammate's PR)
  async uploadFiles(prUrl: string, files: readonly string[]): Promise<readonly PrMedia[]> {
    if (!files.length) return []
    const browser = this.browser()
    if (!browser) throw new Error("mevo's GitHub browser is not signed in (Health → Sign in); screenshots need it")
    const attached = await browser.upload(prUrl, [...files])
    this.notify.uploads(true, `last upload ${attached.length} file(s) on ${prUrl}`)
    return attached
  }

  async uploadMedia(ticket: Ticket, prUrl: string, media: readonly { file: string; kind: 'image' | 'video' }[]): Promise<{ attached: readonly PrMedia[] | null; how: string }> {
    const id = ticket.id
    if (media.length === 0 || this.cfg.github.screenshots === 'none') return { attached: null, how: '' }
    const browser = this.browser()
    if (this.cfg.github.screenshots === 'browser' && browser) {
      try {
        const attached = await browser.upload(prUrl, media.map((m) => m.file))
        this.notify.uploads(true, `last upload ${attached.length} file(s) on ${id}`)
        return { attached, how: 'attached on GitHub' }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.warn(`${id}: browser upload failed`, error)
        this.notify.uploads(false, message)
        this.store.journal(id, { kind: 'failure', title: 'Browser upload failed, using the gist', body: message })
      }
    }
    const images = media.filter((m) => m.kind === 'image').map((m) => m.file)
    try {
      const up = await uploadShots(ticket.worktree as string, id, images, this.store.get(id)?.gistId)
      if (up.gistId && up.gistId !== this.store.get(id)?.gistId) this.store.patch(id, { gistId: up.gistId })
      return { attached: up.shots.map((s) => ({ ...s, kind: 'image' as const })), how: `in a secret gist${media.some((m) => m.kind === 'video') ? ' (videos need the browser upload)' : ''}` }
    } catch (error) {
      this.store.journal(id, { kind: 'failure', title: 'Screenshots not attached', body: `${error instanceof Error ? error.message : String(error)}\n\nThey are in ${path.join(this.flowDir(id), 'shots')}; drag them into the PR.` })
      return { attached: null, how: '' }
    }
  }

  // After a push to an open PR: one comment that says what changed in which commit, with the
  // screenshots taken since the last push, replies in the threads it answers, and a line in the
  // PR body's Updates log so the description never shows stale screenshots silently.
  async postUpdate(ticket: Ticket, sha: string, visual?: { text: string; since: number }): Promise<string | null> {
    const id = ticket.id
    const worktree = ticket.worktree as string
    const prUrl = ticket.prUrl
    const number = ticket.pr?.number ?? Number(/\/pull\/(\d+)/.exec(prUrl ?? '')?.[1])
    if (!prUrl || !number) return null
    const since = visual?.since ?? Date.parse(ticket.lastPushAt ?? (ticket.journal ?? []).filter((j) => j.kind === 'pr').at(-1)?.at ?? '1970-01-01')
    const fresh = prMedia(this.flowDir(id), this.cfg.shots).filter((m) => statSync(m.file).mtimeMs > since)
    const updateFile = path.join(this.flowDir(id), 'UPDATE.md')
    const what = visual ? visual.text : existsSync(updateFile) ? readFileSync(updateFile, 'utf8').trim() : ''
    const replies = visual ? [] : (ticket.pendingReplies ?? [])
    if (fresh.length === 0 && !what && replies.length === 0) return null

    const { attached } = await this.uploadMedia(ticket, prUrl, fresh)
    const short = sha.slice(0, 7)
    const quoted = replies
      .filter((r) => r.kind !== 'inline')
      .map((r) => `> **@${r.author}**: ${r.body.replace(/\s+/g, ' ').trim().slice(0, 200)}`)
      .join('\n')
    const body = [
      `### ${visual ? 'Visual check' : 'Update'} · [\`${short}\`](${prUrl}/commits/${sha})`,
      quoted,
      what || (fresh.length ? 'Screenshots retaken after this change.' : ''),
      attached?.length ? mediaBlock(attached) : fresh.length ? `_${fresh.length} new screenshot(s) could not be attached._` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
    const commentUrl = await commentOnPr(worktree, String(number), body)
    for (const r of replies.filter((x) => x.kind === 'inline')) {
      await replyToReviewComment(worktree, number, r.id.replace(/^inline-/, ''), `Fixed in ${short}${commentUrl ? `, details: ${commentUrl}` : ''}.`).catch((e: unknown) => log.warn(`${id}: thread reply failed`, e))
    }
    // a dated line in the description's Updates log
    try {
      const live = await livePrBody(worktree, String(number))
      const line = `- ${new Date().toISOString().slice(0, 10)} · \`${short}\` ${(what.split('\n')[0] ?? 'Screenshots retaken').replace(/^#+\s*/, '').slice(0, 160)}${commentUrl ? ` ([details](${commentUrl}))` : ''}`
      const withLog = addUpdateLine(swapImages(live.body, attached ?? []).body, line)
      if (withLog !== live.body) await editPrBody(worktree, String(number), withLog)
    } catch (error) {
      log.warn(`${id}: could not add to the Updates log`, error)
    }
    if (!visual && existsSync(updateFile)) {
      mkdirSync(path.join(this.flowDir(id), 'updates'), { recursive: true })
      renameSync(updateFile, path.join(this.flowDir(id), 'updates', `UPDATE-${short}.md`))
    }
    this.store.journal(id, { kind: 'comment', title: `Posted an update on the PR${attached?.length ? ` with ${attached.length} screenshot(s)` : ''}`, body, meta: commentUrl ? { url: commentUrl } : {} })
    return commentUrl || null
  }

  // After a visual check (or by hand): applies the description changes you approved, swaps the
  // retaken screenshots, adds a dated line to the Updates log and, if asked, a short comment.
  async updateDescription(ticket: Ticket, sha: string, input: { changes: readonly DescChange[]; log: string; comment: string | null; since: number }): Promise<{ url: string | null; applied: number; skipped: number }> {
    const id = ticket.id
    const worktree = ticket.worktree as string
    const prUrl = ticket.prUrl
    const number = ticket.pr?.number ?? Number(/\/pull\/(\d+)/.exec(prUrl ?? '')?.[1])
    if (!prUrl || !number) throw new Error(`${id} has no PR`)
    const fresh = prMedia(this.flowDir(id), this.cfg.shots).filter((m) => statSync(m.file).mtimeMs > input.since)
    const { attached } = fresh.length ? await this.uploadMedia(ticket, prUrl, fresh) : { attached: [] as PrMedia[] }
    const live = await livePrBody(worktree, String(number))
    const changed = applyChanges(live.body, input.changes)
    const swapped = swapImages(changed.body, attached ?? [])
    const short = sha.slice(0, 7)
    const stamp = new Date().toLocaleString('sv-SE', { hour12: false }).slice(0, 16)
    const newShots = swapped.unmatched.length ? `\n\n**Retaken after \`${short}\`**\n\n${mediaBlock(swapped.unmatched)}` : ''
    let body = swapped.unmatched.length && /^## Screenshots/m.test(swapped.body)
      ? swapped.body.replace(/(^## Screenshots[^\n]*\n)([\s\S]*?)(?=\n## |\n*(?:Ref:|Fixes) [A-Z]|(?![\s\S]))/m, (_m, h: string, rest: string) => `${h}${rest.trimEnd()}${newShots}\n`)
      : swapped.body
    let commentUrl: string | null = null
    if (input.comment) {
      const extra = swapped.unmatched.length && !/^## Screenshots/m.test(swapped.body) ? `\n\n${mediaBlock(swapped.unmatched)}` : ''
      commentUrl = await commentOnPr(worktree, String(number), `### Description updated · [\`${short}\`](${prUrl}/commits/${sha})\n\n${input.comment}${extra}`)
    }
    const line = `- ${stamp} · \`${short}\` ${input.log || 'Description updated'}${changed.applied.length ? ` (${changed.applied.length} line${changed.applied.length === 1 ? '' : 's'} updated)` : ''}${commentUrl ? ` ([comment](${commentUrl}))` : ''}`
    body = addUpdateLine(body, line)
    if (body !== live.body) await editPrBody(worktree, String(number), body)
    this.store.journal(id, {
      kind: 'pr',
      title: `Updated the PR description · ${changed.applied.length} line(s)${attached?.length ? `, ${attached.length} screenshot(s)` : ''}`,
      body: changed.applied.map((c) => `- ${c.from.trim()}\n+ ${c.to.trim()}`).join('\n') || input.log,
      meta: commentUrl ? { url: commentUrl } : { url: prUrl },
    })
    return { url: commentUrl ?? prUrl, applied: changed.applied.length, skipped: changed.skipped.length }
  }

  // A standalone PR comment with its own screenshots (the preview QA round).
  async postNote(ticket: Ticket, title: string, text: string, files: readonly string[]): Promise<string | null> {
    const prUrl = ticket.prUrl as string
    const number = ticket.pr?.number ?? Number(/\/pull\/(\d+)/.exec(prUrl)?.[1])
    const { attached } = files.length ? await this.uploadMedia(ticket, prUrl, files.map((file) => ({ file, kind: 'image' as const }))) : { attached: [] as PrMedia[] }
    const body = [`### ${title}`, text, attached?.length ? mediaBlock(attached) : files.length ? `_${files.length} screenshot(s) could not be attached._` : ''].filter(Boolean).join('\n\n')
    const url = await commentOnPr(ticket.worktree as string, String(number), body)
    this.store.journal(ticket.id, { kind: 'comment', title: `Posted "${title}" on the PR${attached?.length ? ` with ${attached.length} screenshot(s)` : ''}`, body, meta: url ? { url } : {} })
    return url || null
  }

  async openWithMedia(ticket: Ticket): Promise<string> {
    const id = ticket.id
    const worktree = ticket.worktree as string
    const summary = ticket.summary ?? ''
    const laneBody = this.laneBody(id)
    const media = prMedia(this.flowDir(id), this.cfg.shots)
    const mode = this.cfg.github.screenshots

    if (media.length === 0 || mode === 'none') {
      const body = buildPrBody(ticket, summary, laneBody, [])
      const url = await openDraftPr(worktree, ticket, this.cfg.repo.baseBranch, body)
      this.store.journal(id, { kind: 'pr', title: 'Opened a draft PR', body, meta: { url } })
      return url
    }

    const url = await openDraftPr(worktree, ticket, this.cfg.repo.baseBranch, buildPrBody(ticket, summary, laneBody, 'pending'))
    const { attached, how } = await this.uploadMedia(ticket, url, media)
    const body = buildPrBody(ticket, summary, laneBody, attached ?? [])
    await editPrBody(worktree, ticket.branch, body).catch((e: unknown) => log.warn(`${id}: could not update the PR body`, e))
    this.store.journal(id, { kind: 'pr', title: `Opened a draft PR${attached?.length ? ` · ${attached.length} file(s) ${how}` : ''}`, body, meta: { url } })
    return url
  }
}

// A retaken shot keeps its name, so the description's old image for it is swapped in place.
function swapImages(body: string, attached: readonly PrMedia[]): { body: string; unmatched: PrMedia[] } {
  let out = body
  const unmatched: PrMedia[] = []
  for (const m of attached) {
    const alt = prettyShot(m.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const linked = new RegExp(`<a href="[^"]+"><img src="[^"]+"(\\s+width="\\d+"\\s+alt="${alt}")>`, 'g')
    const re = new RegExp(`<img src="[^"]+"(\\s+width="\\d+"\\s+alt="${alt}")`, 'g')
    if (linked.test(out)) out = out.replace(linked, `<a href="${m.url}"><img src="${m.url}"$1>`)
    else if (re.test(out)) out = out.replace(re, `<img src="${m.url}"$1`)
    else unmatched.push(m)
  }
  return { body: out, unmatched }
}

export function addUpdateLine(body: string, line: string): string {
  if (body.includes('## Updates')) return body.replace(/## Updates\n/, `## Updates\n${line}\n`)
  const withRef = body.replace(/\n*((?:Ref:|Fixes) [A-Z]+-\d+)\s*$/, `\n\n## Updates\n${line}\n\n$1`)
  return withRef !== body ? withRef : `${body.trimEnd()}\n\n## Updates\n${line}\n`
}
