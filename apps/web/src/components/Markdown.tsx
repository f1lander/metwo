import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useMemo } from 'react'
import { API } from '../lib/api.js'
import { desktop } from '../lib/tauri.js'

const ATTACHMENT_ONLY = /^<p>(?:<a [^>]*>)?(https:\/\/github\.com\/user-attachments\/assets\/[\w-]+)(?:<\/a>)?<\/p>$/gm
const LOCAL = /metwo-local:([^"'\s)]+)/g

// GitHub-flavoured markdown from Linear and GitHub, sanitised. Linear uploads go through the
// daemon (they need the API key), local screenshots through the ticket's media route, and a
// bare GitHub attachment link on its own line is a video, as GitHub renders it.
export function Markdown({ source, ticketId, className = '' }: { source: string; ticketId?: string; className?: string }) {
  const html = useMemo(() => {
    let out = marked.parse(source, { gfm: true, breaks: false, async: false }) as string
    out = out.replace(/https:\/\/uploads\.linear\.app\/[^"'\s)<]+/g, (u) => `${API}/api/linear-file?u=${encodeURIComponent(u)}`)
    if (ticketId) out = out.replace(LOCAL, (_m, name: string) => `${API}/api/tickets/${ticketId}/media/${name}`)
    out = out.replace(ATTACHMENT_ONLY, (_m, url: string) => `<p><video src="${url}" controls preload="metadata"></video><br><a href="${url}">open video</a></p>`)
    out = out.replace(/<p>(?:<a [^>]*>)?(\S*\/api\/tickets\/[^/]+\/media\/[^<\s]+\.(?:webm|mp4|mov))(?:<\/a>)?<\/p>/g, (_m, url: string) => `<p><video src="${url}" controls preload="metadata"></video></p>`)
    // a local video the PR body lists as an image tag
    out = out.replace(/<img([^>]*?)src="([^"]+\.(?:webm|mp4|mov))"[^>]*>/gi, (_m, _a, src: string) => `<video src="${src}" controls preload="metadata"></video>`)
    return DOMPurify.sanitize(out, { ADD_TAGS: ['video'], ADD_ATTR: ['controls', 'preload', 'target'] })
  }, [source, ticketId])

  return (
    <div
      className={`md ${className}`}
      // links leave the app: the system browser on desktop, a new tab elsewhere
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest('a')
        if (!a?.href) return
        e.preventDefault()
        void desktop.open(a.href)
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}
