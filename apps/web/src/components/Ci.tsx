import type { CiVerdict, Ticket } from '@ticketflow/shared'
import { useState } from 'react'
import { actions } from '../lib/api.js'
import { failed } from '../lib/notice.js'
import { desktop } from '../lib/tauri.js'
import { Button, Mono, Pill, Section, timeAgo } from './ui.js'

const VERDICT: Record<CiVerdict, { label: string; tone: 'bad' | 'warn' | 'neutral' | 'ok' }> = {
  ours: { label: 'looks like this change', tone: 'bad' },
  main: { label: 'red on the base branch too', tone: 'neutral' },
  flaky: { label: 'looks flaky', tone: 'warn' },
  unclear: { label: 'unclear', tone: 'warn' },
}

// Why CI is red: each failing job, whether main has it too, this PR's files in its log, the log's end.
export function CiCard({ ticket: t }: { ticket: Ticket }) {
  const [busy, setBusy] = useState(false)
  if (t.pr?.ci !== 'failure') return null
  const ci = t.ci
  const check = async () => {
    setBusy(true)
    try {
      await actions.checkCi(t)
    } catch (err) {
      failed(err, t.id)
    } finally {
      setBusy(false)
    }
  }
  const stale = ci && ci.sha && t.pr.headSha && ci.sha !== t.pr.headSha
  return (
    <Section
      title="CI"
      right={
        <button type="button" className="text-xs text-muted hover:text-fg disabled:opacity-50" disabled={busy} onClick={() => void check()}>
          {busy ? 'Reading the checks…' : ci ? 'Check again' : 'Read the failing checks'}
        </button>
      }
    >
      <div className="flex flex-col gap-2.5 rounded-lg border border-[#4a2a2f] bg-[#1b1416] px-4 py-3">
        {!ci ? (
          <span className="text-xs text-fg-2">CI is red. mevo has not read the failing checks yet.</span>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Pill tone={VERDICT[ci.verdict].tone}>{VERDICT[ci.verdict].label}</Pill>
              <span className="text-dim">
                read {timeAgo(ci.at)} ago{stale ? ' · new commits since' : ''}
              </span>
            </div>
            <p className="text-[13px] leading-relaxed text-fg-2">{ci.why}</p>
            {ci.error && <p className="text-xs text-bad">{ci.error}</p>}
            {ci.jobs.map((j) => (
              <details key={j.url} className="rounded-md border border-line bg-bg px-3 py-2 text-xs">
                <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                  <span className="font-medium text-fg">{j.name}</span>
                  {j.onMain && <Pill>red on main</Pill>}
                  {j.infra && <Pill tone="warn">infra</Pill>}
                  {j.files.length > 0 && <Mono className="text-bad">{j.files.map((f) => f.split('/').pop()).join(', ')}</Mono>}
                  <button type="button" className="ml-auto text-accent-fg hover:underline" onClick={(e) => { e.preventDefault(); void desktop.open(j.url) }}>
                    Open
                  </button>
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted">{j.tail || 'No log captured.'}</pre>
              </details>
            ))}
          </>
        )}
        {!ci && (
          <Button className="self-start" disabled={busy} onClick={() => void check()}>
            Read the failing checks
          </Button>
        )}
      </div>
    </Section>
  )
}
