import path from 'node:path'
import type { PrComment } from '@ticketflow/shared'

// The PR's stories on its Storybook preview deploy, so reviewers compare components there instead
// of in screenshots. The branch preview URL comes from the deploy bot's comment; the stories come
// from that Storybook's own index.json, matched to the files the PR changes.

const DEPLOY_BOTS = /^(cloudflare-workers-and-pages|cloudflare-pages|vercel|netlify|github-actions)(\[bot\])?$/i
const HOSTS = /\.(pages\.dev|workers\.dev|vercel\.app|netlify\.app)$/i

// The Storybook preview a deploy bot reported for this branch (the branch URL follows new
// commits), and the commit it was last built from when the comment says.
export function storybookPreview(comments: readonly Pick<PrComment, 'author' | 'body'>[]): { url: string; sha: string | null } | null {
  for (const c of [...comments].reverse()) {
    if (!DEPLOY_BOTS.test(c.author) || !/storybook/i.test(c.body)) continue
    const url = storybookPreviews([c])[0]
    if (!url) continue
    const sha = /storybook[^|\n]*\|\s*\[?`?(?:<tt>)?([0-9a-f]{7,40})\b/i.exec(c.body)?.[1] ?? null
    return { url, sha }
  }
  return null
}

export function storybookPreviews(comments: readonly Pick<PrComment, 'author' | 'body'>[]): string[] {
  const urls = new Set<string>()
  for (const c of comments) {
    if (!DEPLOY_BOTS.test(c.author) || !/storybook/i.test(c.body)) continue
    for (const m of c.body.matchAll(/\[Branch Preview URL\]\((https:\/\/[^)\s]+)\)|href="(https:\/\/[^"]+)"[^>]*>\s*Branch Preview URL/gi)) {
      const url = (m[1] ?? m[2] ?? '').replace(/\/+$/, '')
      try {
        if (/storybook/i.test(url) && HOSTS.test(new URL(url).hostname)) urls.add(url)
      } catch {
        // not a URL
      }
    }
  }
  return [...urls]
}

export interface StoryEntry {
  readonly id: string
  readonly title: string
  readonly name: string
  readonly importPath: string
  // the component the story renders (Storybook 8+)
  readonly componentPath?: string
  readonly type?: string
}

// Storybook 7+ serves index.json; 6.x served stories.json with the same shape.
export async function loadStoryIndex(base: string, timeoutMs = 10_000): Promise<StoryEntry[]> {
  for (const file of ['index.json', 'stories.json']) {
    try {
      const res = await fetch(`${base}/${file}`, { signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) continue
      const json = (await res.json()) as { entries?: Record<string, StoryEntry>; stories?: Record<string, StoryEntry> }
      const entries = Object.values(json.entries ?? json.stories ?? {})
      if (entries.length) return entries.filter((e) => e.type !== 'docs')
    } catch {
      // try the next name
    }
  }
  return []
}

const norm = (p: string) => p.replace(/^\.\//, '').replace(/\\/g, '/')
const stem = (p: string) => path.posix.basename(p).replace(/\.(stories|story)?\.?[jt]sx?$/, '')

// Stories whose file the PR changed, or that sit next to a changed component (Foo.tsx ↔ Foo.stories.tsx).
export function storiesForChange(entries: readonly StoryEntry[], changed: readonly string[], limit = 25): StoryEntry[] {
  const files = changed.map(norm)
  const components = files.filter((f) => /\.[jt]sx?$/.test(f) && !/\.(stories|test|spec)\.[jt]sx?$/.test(f))
  const changedHere = (p: string) => files.some((f) => f === p || f.endsWith(`/${p}`))
  const hit = (importPath: string, componentPath?: string) => {
    const p = norm(importPath)
    if (changedHere(p) || (componentPath && changedHere(norm(componentPath)))) return true
    const dir = path.posix.dirname(p)
    return components.some((f) => stem(f) === stem(p) && (path.posix.dirname(f) === dir || path.posix.dirname(f).endsWith(`/${dir}`)))
  }
  return entries.filter((e) => hit(e.importPath, e.componentPath)).slice(0, limit)
}

export function storiesBlock(base: string, stories: readonly StoryEntry[]): string {
  const lines = stories.map((s) => `- [${s.title.replace(/\//g, ' / ')} · ${s.name}](${base}/?path=/story/${s.id})`)
  return [
    '<!-- stories:start -->',
    `**Review in Storybook** ([open](${base})): the branch preview, compare the components there rather than in the screenshots.`,
    ...(lines.length ? lines : ['- No stories for the files this PR changes.']),
    '<!-- stories:end -->',
  ].join('\n')
}

// Fills the marker the first time, then keeps the block current on later pushes.
export function withStories(body: string, block: string): string | null {
  if (body.includes('<!-- stories:start -->')) {
    const next = body.replace(/<!-- stories:start -->[\s\S]*?<!-- stories:end -->/, block)
    return next === body ? null : next
  }
  return body.includes('<!-- stories -->') ? body.replace('<!-- stories -->', block) : null
}

// PR bodies written before thumbnails: every attached image becomes a linked thumbnail (the old
// ones were up to 720px and their click went to a link that expires), and the stories marker is
// added after the Preview line. Returns null when there is nothing to change.
export function tidyShots(body: string): string | null {
  let out = body.replace(/(<a href="[^"]*">)?<img src="(https:\/\/github\.com\/user-attachments\/assets\/[\w-]+)" width="(\d+)"( alt="[^"]*")>(<\/a>)?/g, (all, open: string | undefined, url: string, w: string, alt: string, close: string | undefined) => {
    const width = Math.min(Number(w), 240)
    return open && close && Number(w) <= 240 ? all : `<a href="${url}"><img src="${url}" width="${width}"${alt}></a>`
  })
  if (!/<!-- stories(:start)? -->/.test(out) && /^\*\*Preview:\*\*.*$/m.test(out)) out = out.replace(/^(\*\*Preview:\*\*.*)$/m, '$1\n\n<!-- stories -->')
  return out === body ? null : out
}
