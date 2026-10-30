// Small text helpers the daemon and the web app both use.

// claude-opus-5-5 → Opus 5.5, opus → Opus; other engines' ids pass through.
export function modelName(id: string | undefined): string {
  if (!id) return ''
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id)
  if (!m) return /^[a-z]+$/.test(id) ? id.charAt(0).toUpperCase() + id.slice(1) : id
  const family = (m[1] ?? '').charAt(0).toUpperCase() + (m[1] ?? '').slice(1)
  return `${family} ${m[2]}${m[3] && m[3].length <= 2 ? `.${m[3]}` : ''}`
}

// The body under a markdown heading (#, ## or ###) whose text starts with `heading`.
export function markdownSection(markdown: string | undefined, heading: string | RegExp): string {
  if (!markdown) return ''
  const matches = (title: string) => (typeof heading === 'string' ? title.trim().toLowerCase().startsWith(heading.toLowerCase()) : heading.test(title))
  const chunk = markdown
    .split(/^#{1,3}\s+/m)
    .slice(1)
    .find((c) => matches(c.split('\n')[0] ?? ''))
  return chunk ? chunk.split('\n').slice(1).join('\n').trim() : ''
}
