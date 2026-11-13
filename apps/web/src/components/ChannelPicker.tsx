import type { SlackChannel } from '@ticketflow/shared'
import { useEffect, useState } from 'react'
import { slackActions } from '../lib/api.js'

const KEY = 'mevo.slack.channel'
export const lastChannel = (): string => {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}
const remember = (id: string) => {
  try {
    localStorage.setItem(KEY, id)
  } catch {
    // not remembered
  }
}

let cache: Promise<SlackChannel[]> | null = null

// Where to post, chosen right here. The bot can only post in channels it was invited to; the
// others you are in show greyed out with how to fix it. Empty: the channel from Settings.
export function ChannelPicker({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [list, setList] = useState<SlackChannel[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = (fresh = false) => {
    if (fresh || !cache) cache = slackActions.channels(fresh).then((r) => r.channels)
    cache.then(
      (l) => (setList(l), setError(null)),
      (e: unknown) => ((cache = null), setError(e instanceof Error ? e.message : String(e))),
    )
  }
  useEffect(() => load(), [])
  const pick = (id: string) => {
    remember(id)
    onChange(id)
  }
  const field = 'max-w-56 rounded-md border border-line-2 bg-bg px-2 py-1 text-xs text-fg outline-none focus:border-accent'
  if (error)
    return (
      <span className="flex min-w-0 items-center gap-1.5" title={error}>
        <input aria-label="Slack channel" value={value} placeholder="#channel or C0123…" onChange={(e) => pick(e.target.value)} className={`${field} w-40`} />
        <span className="truncate text-[11px] text-warn">couldn't list channels</span>
      </span>
    )
  const outside = list?.filter((c) => !c.bot) ?? []
  return (
    <span className="flex items-center gap-1">
      <select aria-label="Slack channel" value={value} onChange={(e) => pick(e.target.value)} className={field}>
        <option value="">Channel from Settings</option>
        {list?.filter((c) => c.bot).map((c) => (
          <option key={c.id} value={c.id}>
            {c.private ? '🔒 ' : '#'}
            {c.name}
          </option>
        ))}
        {outside.length > 0 && (
          <optgroup label="Invite the bot first (/invite @bot)">
            {outside.map((c) => (
              <option key={c.id} value={c.id} disabled>
                {c.private ? '🔒 ' : '#'}
                {c.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <button type="button" aria-label="Reload the channels" title="Reload (after inviting the bot)" className="px-1 text-muted hover:text-fg" onClick={() => load(true)}>
        ↻
      </button>
    </span>
  )
}
