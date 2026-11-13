import { markdownSection, type Ticket } from '@ticketflow/shared'
import { actions } from '../lib/api.js'
import { notice } from '../lib/notice.js'
import { Markdown } from './Markdown.js'
import { Pill } from './ui.js'

type Run = (fn: () => Promise<unknown>) => () => Promise<void>

const dur = (s?: number) => (s === undefined ? '' : s < 90 ? `${s}s` : `${Math.round(s / 60)}m`)

export const localFailed = (t: Ticket) => t.localChecks?.status === 'fail'

// Push: runs the local checks first when this commit has none, and says so.
export async function push(t: Ticket, force = false): Promise<void> {
  const r = await actions.push(t, force)
  if (r.result === 'checking') notice({ id: t.id, title: 'Running the local checks first', detail: 'It pushes by itself if they pass', tone: 'accent' })
}

// What CI would run, run here on this commit: one line of chips, and the failures under it.
export function LocalChecksCard({ ticket: t, busy, run }: { ticket: Ticket; busy: boolean; run: Run }) {
  const lc = t.localChecks
  if (!lc) return null
  const running = lc.status === 'running'
  const red = lc.steps.filter((s) => s.ok === false)
  const green = lc.steps.filter((s) => s.ok === true)
  const skipped = lc.steps.filter((s) => s.ok === null)
  const longest = Math.max(0, ...lc.steps.map((s) => s.seconds ?? 0))
  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-muted">
          Local checks <span className="font-mono text-dim">{lc.sha.slice(0, 7)}</span>
        </span>
        {running ? (
          <span className="animate-pulse text-accent-fg">{lc.step ?? 'running…'}</span>
        ) : (
          <>
            {green.length > 0 && <Pill tone="ok">✓ {green.map((s) => s.name).join(' · ')}</Pill>}
            {red.map((s) => (
              <Pill key={s.name} tone="bad">✕ {s.name}</Pill>
            ))}
            {skipped.map((s) => (
              <span key={s.name} title={s.note} className="rounded-full border border-line-2 px-2 py-px text-[11px] whitespace-nowrap text-muted">
                – {s.name}
                {s.note ? `: ${/no spec/.test(s.note) ? 'no spec matched' : 'not run'}` : ''}
              </span>
            ))}
            {(longest > 0 || lc.specs?.length) && (
              <span className="text-dim" title={lc.specs?.length ? `e2e specs: ${lc.specs.join(', ')}` : undefined}>
                · {longest > 0 ? dur(longest) : ''}
                {lc.specs?.length ? `${longest > 0 ? ' · ' : ''}${lc.specs.length} spec${lc.specs.length === 1 ? '' : 's'}` : ''}
              </span>
            )}
          </>
        )}
        {!running && t.status !== 'running' && (
          <button type="button" className="ml-auto text-muted hover:text-fg disabled:opacity-50" disabled={busy} onClick={run(() => actions.localChecks(t))}>
            Run again
          </button>
        )}
      </div>
      {!running && red.length > 0 && lc.staleDaemon && (
        <p className="text-warn">These ran while mevo still had old code loaded, so they may fail for its reasons, not this change. Run them again once mevo has restarted.</p>
      )}
      {!running && red.length > 0 && (
        <ul className="flex flex-col gap-1 border-t border-[#3a2226] pt-2">
          {red.map((s) => (
            <li key={s.name}>
              <details className="group">
                <summary className="flex cursor-pointer list-none items-baseline gap-2 [&::-webkit-details-marker]:hidden">
                  <span className="text-bad">✕</span>
                  <span className="shrink-0 text-fg">{s.name}</span>
                  <span className="min-w-0 truncate text-fg-2">{s.note ?? (s.tail ? s.tail.trim().split('\n').at(-1) : '')}</span>
                  {s.tail && <span className="ml-auto shrink-0 text-accent-fg">output <span className="inline-block transition-transform group-open:rotate-90">▸</span></span>}
                </summary>
                {s.tail && <pre className="mt-1 ml-5 max-h-48 overflow-auto rounded-md bg-sunk p-2 font-mono text-[11px] whitespace-pre-wrap text-muted">{s.tail}</pre>}
              </details>
            </li>
          ))}
        </ul>
      )}
      {!running && red.length > 0 && <LaneVerdict ticket={t} />}
    </div>
  )
}

// What the lane said about the failures when it last looked: its fix, or why they aren't this branch's
function LaneVerdict({ ticket: t }: { ticket: Ticket }) {
  const said = markdownSection(t.summary, /^local checks/i)
  if (!said) return null
  return (
    <details className="rounded-md border border-line px-2.5 py-1.5">
      <summary className="cursor-pointer text-fg-2">What the lane found when it looked at these failures</summary>
      <Markdown source={said} ticketId={t.id} className="mt-1 text-xs" />
    </details>
  )
}
