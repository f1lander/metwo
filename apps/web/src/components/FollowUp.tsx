import { type PrReview, type PrThread, type ReviewerFollowUp, reviewerFollowUps, type Ticket, type ThreadVerdict } from '@ticketflow/shared'
import { useState } from 'react'
import { actions, reviewActions, slackActions } from '../lib/api.js'
import { failed, notice } from '../lib/notice.js'
import { href } from '../lib/route.js'
import { ChannelPicker, lastChannel } from './ChannelPicker.js'
import { NudgeChip } from './Nudge.js'
import { Avatar, Button, ConfirmButton, timeAgo } from './ui.js'

type Run = (fn: () => Promise<unknown>) => () => Promise<void>

export const followUps = (t: Ticket): ReviewerFollowUp[] => (t.conversation && t.pr?.state === 'OPEN' ? reviewerFollowUps(t.conversation, t.commentsHandled ?? {}) : [])
// your PR has a reviewer waiting on you: comments to fix, or fixes GitHub doesn't show yet
export const changesWaiting = (t: Ticket) => followUps(t).some((f) => f.next === 'fix' || f.next === 'tell')

const NEXT: Record<ReviewerFollowUp['next'], { text: string; cls: string }> = {
  fix: { text: 'comments to address', cls: 'text-bad' },
  tell: { text: 'addressed, not told on GitHub', cls: 'text-warn' },
  waiting: { text: 're-review asked', cls: 'text-muted' },
  done: { text: 'approved', cls: 'text-ok' },
}

const where = (t: PrThread) => `${t.path ?? 'PR'}${t.line ? `:${t.line}` : ''}`

// Your PR: each reviewer, what they asked, and what GitHub shows of your answer.
export function ReviewersCard({ ticket: t, busy, run }: { ticket: Ticket; busy: boolean; run: Run }) {
  const list = followUps(t)
  if (!list.length) return null
  const pushed = t.status !== 'review_ready' && t.status !== 'running'
  const canTell = pushed && list.some((f) => f.answered.length > 0 && f.next !== 'waiting' && f.next !== 'done')
  return (
    <div className="flex flex-col gap-1.5 text-xs">
      {/* one line: each reviewer and where they are */}
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-muted">Reviewers</span>
        {list.map((f) => (
          <span key={f.login} className="inline-flex items-center gap-1.5 rounded-full border border-line-2 py-px pr-2 pl-0.5 whitespace-nowrap">
            <Avatar login={f.login} size={16} />
            <span className="text-fg">{f.login}</span>
            <span className="text-muted">{f.state === 'CHANGES_REQUESTED' ? 'requested changes' : f.state === 'APPROVED' ? 'approved' : f.state === 'NONE' ? 'asked' : 'commented'}</span>
            <span className={NEXT[f.next].cls}>· {f.state === 'NONE' ? 'not reviewed yet' : NEXT[f.next].text}</span>
            {f.pushedSince && f.next !== 'done' && <span className="text-muted">· you pushed since</span>}
            <NudgeChip ticket={t} login={f.login} />
          </span>
        ))}
      </div>
      {list.map((f) => {
        const todo = f.open.filter((x) => !f.answered.includes(x))
        if (!todo.length && !(f.answered.length > 0 && f.next !== 'done')) return null
        return (
          <div key={f.login} className="flex flex-col gap-1">
            {todo.length > 0 && (
              <ul className="flex flex-col gap-0.5 border-t border-line pt-1.5">
                {todo.map((x) => (
                  <li key={x.id} className="truncate text-fg-2">
                    {list.length > 1 && <span className="text-muted">{f.login} · </span>}
                    <a href={x.comments[0]?.url} target="_blank" rel="noreferrer" className="font-mono text-[11px] text-muted hover:text-fg">
                      {where(x)}
                    </a>{' '}
                    {x.comments[0]?.body.replace(/\s+/g, ' ').slice(0, 140)}
                  </li>
                ))}
              </ul>
            )}
            {f.answered.length > 0 && f.next !== 'done' && (
              <ul className="flex flex-col gap-0.5 border-t border-line pt-1.5">
                {f.answered.map((x) => {
                  const fixed = t.commentsHandled?.[`inline-${x.comments[0]?.id}`]?.commits ?? []
                  const waiting = fixed.some((sha) => t.unpushed?.commits.some((c) => c.sha.startsWith(sha) || sha.startsWith(c.sha)))
                  return (
                    <li key={x.id} className="flex min-w-0 items-baseline gap-1.5 text-fg-2">
                      <span className="shrink-0 text-ok">✓</span>
                      <a href={x.comments[0]?.url} target="_blank" rel="noreferrer" className="shrink-0 font-mono text-[11px] text-muted hover:text-fg">
                        {where(x)}
                      </a>
                      <span className="min-w-0 truncate">{x.comments[0]?.body.replace(/\s+/g, ' ').slice(0, 90)}</span>
                      {fixed.length > 0 && (
                        <span className={`shrink-0 ${waiting ? 'text-warn' : 'text-muted'}`}>
                          fixed in <span className="font-mono text-[11px]">{fixed.slice(0, 2).join(', ')}</span>
                          {waiting ? ' · not on GitHub yet' : ''}
                        </span>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )
      })}
      {canTell && (
        <div>
          <Button
            variant="primary"
            disabled={busy}
            title="replies 'Addressed in <sha>' in the threads you dealt with and asks for a re-review once all of a reviewer's threads are answered"
            onClick={run(async () => {
              const r = await actions.tellReviewers(t)
              notice({ id: t.id, title: r.requested.length ? `Asked ${r.requested.join(', ')} to review again` : 'Told the reviewers', detail: [r.replied ? `${r.replied} replies` : '', r.resolved ? `${r.resolved} resolved` : '', r.left ? `${r.left} still to address` : ''].filter(Boolean).join(' · '), tone: 'ok' })
            })}
          >
            Tell reviewers it's addressed
          </Button>
        </div>
      )}
    </div>
  )
}

// Today: your PRs where a reviewer is waiting on you.
export function ChangesRequested({ tickets }: { tickets: readonly Ticket[] }) {
  const list = tickets.filter(changesWaiting).map((t) => ({ t, f: followUps(t).filter((x) => x.next === 'fix' || x.next === 'tell') }))
  if (!list.length) return null
  return (
    <section className="flex flex-col gap-1 rounded-xl border border-line bg-panel px-3 py-3">
      <div className="flex items-center gap-2 px-1 text-xs font-medium text-muted">
        Reviewers waiting on you
        <span className="text-dim">{list.length}</span>
        <a href={`${href.board}?f=changes`} className="ml-auto font-normal hover:text-fg">
          On the board
        </a>
      </div>
      {list.map(({ t, f }) => (
        <a key={t.id} href={href.ticket(t.id)} className="group flex items-center gap-3 rounded-lg px-1 py-1.5 hover:bg-raised">
          <span className="flex shrink-0 -space-x-1.5">
            {f.slice(0, 3).map((x) => (
              <Avatar key={x.login} login={x.login} size={18} className="ring-2 ring-panel" />
            ))}
          </span>
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm text-fg">
              <span className="text-muted">{t.id}</span> {t.title}
            </span>
            <span className="truncate text-[11px] text-dim">
              {f.map((x) => `${x.login}: ${x.next === 'fix' ? `${x.open.length - x.answered.length} to address` : 'addressed, tell them'}`).join(' · ')} · PR #{t.pr?.number}
            </span>
          </span>
          <span className="shrink-0 text-xs text-accent-fg opacity-70 group-hover:opacity-100">{f.some((x) => x.next === 'fix') ? 'Address' : 'Tell'} →</span>
        </a>
      ))}
    </section>
  )
}

// Today: your PRs waiting for review, posted to the team's Slack channel after you read it.
export function ReviewSummary({ tickets }: { tickets: readonly Ticket[] }) {
  const n = tickets.filter((t) => t.pr?.state === 'OPEN' && !t.pr.isDraft && t.pr.reviewDecision !== 'APPROVED' && t.status !== 'done').length
  const [text, setText] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [channel, setChannel] = useState(lastChannel)
  if (!n) return null
  const open = async () => {
    try {
      setText((await slackActions.reviewSummary()).text ?? '')
    } catch (err) {
      failed(err)
    }
  }
  const send = async () => {
    if (!text) return
    setBusy(true)
    try {
      const r = await slackActions.postReviewSummary(text, channel || undefined)
      notice({ title: `Posted to ${r.channel}`, tone: 'ok' })
      setText(null)
    } catch (err) {
      failed(err)
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="flex flex-col gap-2 rounded-xl border border-line bg-panel px-3 py-3 text-xs">
      <div className="flex items-center gap-2 px-1 font-medium text-muted">
        Your PRs waiting for review
        <span className="text-dim">{n}</span>
        {text === null && (
          <Button variant="ghost" className="ml-auto" onClick={() => void open()}>
            Post a summary to Slack…
          </Button>
        )}
      </div>
      {text !== null && (
        <>
          <textarea aria-label="Slack summary" value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(14, text.split('\n').length + 1)} className="rounded-md border border-line-2 bg-bg px-2 py-1.5 font-mono text-[11.5px] text-fg outline-none focus:border-accent" />
          <div className="flex flex-wrap items-center gap-2">
            <ChannelPicker value={channel} onChange={setChannel} />
            <Button variant="primary" disabled={busy || !text.trim()} onClick={() => void send()}>
              Post
            </Button>
            <Button variant="ghost" onClick={() => setText(null)}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </section>
  )
}

const VERDICT: Record<ThreadVerdict, { icon: string; label: string; cls: string }> = {
  addressed: { icon: '✓', label: 'addressed', cls: 'text-ok' },
  partly: { icon: '◐', label: 'partly', cls: 'text-warn' },
  not_addressed: { icon: '✕', label: 'not addressed', cls: 'text-bad' },
  answered: { icon: '💬', label: 'answered', cls: 'text-accent-fg' },
}

// A PR you reviewed: what happened to each of your comments, and what to do about it.
export function ReviewFollowUpCard({ review: r }: { review: PrReview }) {
  const [busy, setBusy] = useState(false)
  const [reply, setReply] = useState<Record<string, string>>({})
  const [ping, setPing] = useState<string | null>(null)
  const [member, setMember] = useState('')
  const [needMember, setNeedMember] = useState(false)
  const fu = r.followUp
  if (!r.posted) return null
  const go = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true)
    try {
      await fn()
      if (ok) notice({ id: r.id, title: ok, tone: 'ok' })
    } catch (err) {
      if (/add their member ID/.test(err instanceof Error ? err.message : '')) setNeedMember(true)
      failed(err, r.id)
    } finally {
      setBusy(false)
    }
  }
  if (!fu) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-line-2 bg-panel px-3 py-2.5 text-xs text-muted">
        Follow your comments: are they resolved, answered, fixed?
        <Button className="ml-auto" disabled={busy} onClick={() => void go(() => reviewActions.followUp(r.id))}>
          Check on GitHub
        </Button>
      </div>
    )
  }
  const open = fu.threads.filter((t) => !t.resolved)
  const notDone = open.filter((t) => t.verdict === 'not_addressed' || t.verdict === 'partly')
  const allGood = open.length > 0 && open.every((t) => t.verdict === 'addressed') && fu.checked?.sha === fu.sha
  const draftPing = () =>
    setPing(
      `hey! following up on my review of ${r.url}\n${(notDone.length ? notDone : open)
        .map((t) => `• ${where(t)}: ${t.note ?? t.comments[0]?.body.replace(/\s+/g, ' ').slice(0, 120) ?? ''}${t.comments[0]?.url ? ` (${t.comments[0].url})` : ''}`)
        .join('\n')}\nlet me know if any of these don't make sense`,
    )
  const s = fu.summary
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line-2 bg-panel px-3 py-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-medium tracking-wide text-muted uppercase">Your comments</span>
        <span className="text-fg-2">
          {s.resolved}/{s.total} resolved{s.replied ? ` · ${s.replied} answered` : ''}{fu.commitsSince ? ` · ${fu.commitsSince} commit(s) since your review` : ' · no new commits'}
        </span>
        <span className="text-dim">read {timeAgo(fu.at)} ago</span>
        <Button variant="ghost" className="ml-auto" disabled={busy || fu.checking} onClick={() => void go(() => reviewActions.followUp(r.id))}>
          Refresh
        </Button>
        {open.length > 0 && (
          <Button disabled={busy || fu.checking} title="a model reads the new commits and replies against each open thread; nothing is posted" onClick={() => void go(() => reviewActions.checkFollowUp(r.id))}>
            {fu.checking ? 'Checking…' : fu.checked?.sha === fu.sha ? 'Check again' : 'Check if they were addressed'}
          </Button>
        )}
      </div>
      {fu.checked && <p className="text-fg-2">{fu.checked.summary}{fu.checked.sha !== fu.sha ? ' (new commits since this check)' : ''}</p>}
      {open.length === 0 && s.total > 0 && <p className="text-ok">Every one of your threads is resolved.</p>}
      <ul className="flex flex-col gap-2">
        {open.map((t) => {
          const v = t.verdict ? VERDICT[t.verdict] : null
          const last = t.comments.at(-1)
          return (
            <li key={t.id} className="flex flex-col gap-1 rounded-md border border-line px-2 py-1.5">
              <span className="flex flex-wrap items-center gap-2">
                {v && <span className={v.cls}>{v.icon} {v.label}</span>}
                <a href={t.comments[0]?.url} target="_blank" rel="noreferrer" className="font-mono text-[11px] text-muted hover:text-fg">
                  {where(t)}
                </a>
                {t.outdated && <span className="text-dim">code changed under it</span>}
                {last && last.author !== t.comments[0]?.author && <span className="text-dim">· {last.author} replied {timeAgo(last.at)} ago</span>}
              </span>
              <span className="text-fg-2">{t.comments[0]?.body.replace(/\s+/g, ' ').slice(0, 220)}</span>
              {last && last.author !== t.comments[0]?.author && <span className="border-l-2 border-line-2 pl-2 text-muted">{last.body.replace(/\s+/g, ' ').slice(0, 260)}</span>}
              {t.note && <span className="text-dim">→ {t.note}</span>}
              <div className="flex flex-wrap items-center gap-2">
                {(t.verdict === 'addressed' || t.verdict === 'answered') && (
                  <Button variant="ghost" disabled={busy} onClick={() => void go(() => reviewActions.resolveThread(r.id, t.id), 'Resolved')}>
                    Resolve
                  </Button>
                )}
                {reply[t.id] === undefined ? (
                  <Button variant="ghost" disabled={busy} onClick={() => setReply((m) => ({ ...m, [t.id]: t.reply ?? '' }))}>
                    Reply…
                  </Button>
                ) : (
                  <span className="flex w-full gap-2">
                    <input aria-label="reply" value={reply[t.id]} onChange={(e) => setReply((m) => ({ ...m, [t.id]: e.target.value }))} className="min-w-0 flex-1 rounded-md border border-line-2 bg-bg px-2 py-1 text-xs text-fg outline-none focus:border-accent" />
                    <Button
                      disabled={busy || !reply[t.id]?.trim()}
                      onClick={() =>
                        void go(async () => {
                          await reviewActions.replyThread(r.id, t.id, reply[t.id] ?? '')
                          setReply(({ [t.id]: _, ...rest }) => rest)
                        }, 'Replied on GitHub')
                      }
                    >
                      Post
                    </Button>
                  </span>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        {allGood && <ConfirmButton label="Approve" confirm={`Approve #${r.number} as it is now`} disabled={busy} onConfirm={() => void go(() => reviewActions.approve(r.id, ''), 'Approved')} />}
        {open.length > 0 && ping === null && (
          <Button variant={notDone.length ? 'primary' : 'default'} disabled={busy} onClick={draftPing}>
            Ping {r.author} on Slack…
          </Button>
        )}
        {fu.pinged && <span className="text-dim">pinged {timeAgo(fu.pinged.at)} ago</span>}
      </div>
      {ping !== null && (
        <div className="flex flex-col gap-2">
          <textarea aria-label="Slack message" value={ping} onChange={(e) => setPing(e.target.value)} rows={Math.min(10, ping.split('\n').length + 1)} className="rounded-md border border-line-2 bg-bg px-2 py-1.5 text-xs text-fg outline-none focus:border-accent" />
          {needMember && (
            <span className="flex items-center gap-2">
              <input aria-label="Slack member ID" placeholder={`${r.author}'s Slack member ID (U0…)`} value={member} onChange={(e) => setMember(e.target.value)} className="w-56 rounded-md border border-line-2 bg-bg px-2 py-1 text-xs text-fg outline-none focus:border-accent" />
              <Button
                disabled={busy || !member.trim()}
                onClick={() =>
                  void go(async () => {
                    await slackActions.setPerson(r.author, member.trim())
                    setNeedMember(false)
                  }, 'Saved')
                }
              >
                Save
              </Button>
            </span>
          )}
          <div className="flex gap-2">
            <Button
              variant="primary"
              disabled={busy || !ping.trim()}
              onClick={() =>
                void go(async () => {
                  await reviewActions.ping(r.id, ping)
                  setPing(null)
                }, `Sent to ${r.author} on Slack`)
              }
            >
              Send as you
            </Button>
            <Button variant="ghost" onClick={() => setPing(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
