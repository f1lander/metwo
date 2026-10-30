import type { Ticket } from '@ticketflow/shared'
import { useEffect, useState } from 'react'
import { actions, mediaUrl } from '../lib/api.js'
import { PostToPr } from './PrDescPanel.js'
import { Button, Pill } from './ui.js'

const MARK = { pass: '✅', fail: '❌', not_checked: '➖' } as const
const TONE = { pass: 'ok', partial: 'warn', fail: 'bad' } as const

// A QA round on the PR's preview deploy (Cloudflare): the ticket's criteria and the PR's testing
// steps, checked on the deployed app. You decide what gets posted.
export function PreviewQaCard({ ticket: t }: { ticket: Ticket }) {
  const [preview, setPreview] = useState<{ url: string; sha: string | null; current: boolean } | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const qa = t.previewQa
  const requested = (t.pr?.labels ?? []).some((l) => /qa requested/i.test(l))

  useEffect(() => {
    actions.preview(t).then((r) => setPreview(r.preview), () => setPreview(null))
  }, [t.id, t.pr?.syncedAt])

  const run = async (fn: () => Promise<unknown>, done: string | null) => {
    setBusy(true)
    setNote(null)
    try {
      await fn()
      if (done) setNote(done)
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  if (!t.pr || t.pr.state !== 'OPEN') return null
  const running = qa?.status === 'running'

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-panel px-4 py-3 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-fg">QA on preview</span>
        {requested && <Pill tone="accent">QA requested</Pill>}
        {qa?.verdict && <Pill tone={TONE[qa.verdict]}>{qa.verdict}</Pill>}
        {qa?.postedAt && <span className="text-dim">posted</span>}
        <span className="ml-auto truncate text-muted">
          {preview === undefined ? 'looking for the deploy…' : preview ? (
            <a href={preview.url} target="_blank" rel="noreferrer" className="text-accent-fg hover:underline">
              {preview.url.replace(/^https:\/\//, '')}
            </a>
          ) : 'no preview deploy on the PR yet'}
          {preview && !preview.current && <span className="text-warn"> · older commit</span>}
        </span>
      </div>

      {qa?.status === 'done' && (
        <>
          {qa.summary && <p className="text-fg-2">{qa.summary}</p>}
          <ul className="flex flex-col gap-0.5">
            {(qa.checks ?? []).map((c, i) => (
              <li key={i} className="text-fg-2">
                {MARK[c.result]} {c.what}
                {c.note && <span className="text-dim"> · {c.note}</span>}
              </li>
            ))}
          </ul>
          {(qa.checks ?? []).some((c) => c.shot) && (
            <div className="grid grid-cols-3 gap-1.5">
              {[...new Set((qa.checks ?? []).map((c) => c.shot).filter(Boolean))].slice(0, 6).map((s) => (
                <a key={s} href={mediaUrl(t.id, `qa--${s}`, qa.at)} target="_blank" rel="noreferrer">
                  <img src={mediaUrl(t.id, `qa--${s}`, qa.at)} alt={s} loading="lazy" className="aspect-[16/10] w-full rounded border border-line object-cover object-top" />
                </a>
              ))}
            </div>
          )}
        </>
      )}
      {qa?.status === 'failed' && <p className="text-bad">QA round failed: {qa.error}</p>}
      {running && <p className="text-muted">Testing the preview at desktop and mobile… you also get it in Telegram.</p>}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant={qa?.status === 'done' ? 'default' : 'primary'} disabled={busy || running || !preview} onClick={() => void run(() => actions.previewQa(t, Boolean(preview && !preview.current)), 'Started; it keeps the ticket where it is.')}>
          {qa ? 'Test again' : preview && !preview.current ? 'Test the older deploy' : 'Test on preview'}
        </Button>
        {qa?.status === 'done' && (
          <>
            <Button variant="primary" disabled={busy} onClick={() => void run(() => actions.postPreviewQa(t), 'Posted to the PR.')}>
              Post to PR
            </Button>
            <Button disabled={busy} onClick={() => void run(async () => {
              await actions.postPreviewQa(t)
              await actions.descPropose(t, 'manual')
            }, 'Posted; preparing the description changes for you to approve.')}>
              Post + update description
            </Button>
          </>
        )}
        {note && <span className="text-fg-2">{note}</span>}
      </div>
      {t.descProposal?.trigger === 'manual' && <PostToPr ticket={t} onClose={() => setNote(null)} />}
      <p className="text-[11px] leading-relaxed text-dim">Checks the ticket's criteria and the PR's testing steps on the deployed app. Wallet and onchain steps are left as not checked. Nothing is posted until you press Post.</p>
    </div>
  )
}
