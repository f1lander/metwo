import { markdownSection, type Ticket } from '@ticketflow/shared'

// What the Night Shift bot may say, and what it must never post. The bot only informs: it has no
// tools, reads nothing but the facts below, and every reply passes guardReply before Slack.

const PRIORITY = ['no priority', 'Urgent', 'High', 'Medium', 'Low'] as const
// tickets whose details stay out of Slack
export const CONFIDENTIAL = /security|confidential|private|embargo|vulnerab|incident/i

const ci = (c: string) => (c === 'success' ? 'CI green' : c === 'failure' ? 'CI failing' : c === 'pending' ? 'CI running' : 'no CI yet')
const review = (d: string) => (d === 'APPROVED' ? 'approved' : d === 'CHANGES_REQUESTED' ? 'changes requested' : 'waiting for review')
const days = (iso: string | undefined, now: number) => {
  if (!iso) return ''
  const d = Math.floor((now - Date.parse(iso)) / 86_400_000)
  return d <= 0 ? 'today' : d === 1 ? '1 day' : `${d} days`
}

// owner/repo of a GitHub PR url
const slugOf = (url: string) => /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url)?.[1]?.toLowerCase() ?? null

// The project's repo: the configured one, or the one most of your PRs are in
export function projectRepo(tickets: readonly Ticket[], configured?: string | null): string | null {
  if (configured) return configured.toLowerCase()
  const n = new Map<string, number>()
  for (const t of tickets) {
    const s = t.pr && slugOf(t.pr.url)
    if (s) n.set(s, (n.get(s) ?? 0) + 1)
  }
  return [...n].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
}

// What the work changed, from what mevo saved: the summary's "What changed", commit subjects, files
function codeFacts(t: Ticket): string {
  const changed = markdownSection(t.summary, /^what changed/i).replace(/\s+/g, ' ').slice(0, 500)
  const commits = (t.commits ?? '')
    .split('\n')
    .map((l) => l.trim().replace(/^[0-9a-f]{7,40}\s+/, ''))
    .filter((l) => l && !/^Merge (remote-tracking )?branch/.test(l))
    .slice(0, 5)
  const files = (t.diffStat ?? '')
    .split('\n')
    .map((l) => l.split('|')[0]?.trim() ?? '')
    .filter((f) => f && !/files? changed/.test(f))
    .slice(0, 8)
  return [changed ? `what changed: ${changed}` : '', commits.length ? `commits: ${commits.join('; ')}` : '', files.length ? `files: ${files.join(', ')}` : ''].filter(Boolean).join(' · ')
}

// The bot's whole knowledge: your open work in the project, with what ranks it (Linear priority,
// estimate, how long it waited, CI, reviews, conflicts) and what it changed. Nothing from other
// repos. urls: the only links a reply may contain.
export function workFacts(tickets: readonly Ticket[], now = Date.now(), repo?: string | null): { text: string; urls: Set<string> } {
  const urls = new Set<string>()
  const lines: string[] = []
  let withheld = 0
  const home = projectRepo(tickets, repo)
  let detailed = 0
  for (const t0 of tickets) {
    // a PR in another repo is not this project's work
    const t: Ticket = t0.pr && home && slugOf(t0.pr.url) !== home ? (({ pr: _, ...rest }) => rest)(t0) : t0
    if (!(t.pr ? t.pr.state === 'OPEN' || t.pr.state === 'MERGED' : ['review_ready', 'running', 'pr_draft', 'needs_input'].includes(t.status))) continue
    if ((t.labels ?? []).some((l) => CONFIDENTIAL.test(l)) || CONFIDENTIAL.test(t.title)) {
      withheld += 1
      continue
    }
    const pr = t.pr
    const preview = pr?.comments?.map((c) => /https:\/\/[a-z0-9-]+\.[a-z0-9.-]+pages\.dev\S*/i.exec(c.body)?.[0]).find(Boolean)?.replace(/[)>\]]+$/, '')
    const asked = t.conversation?.reviewers.filter((r) => r.requested && !/\[bot\]$/i.test(r.login)).map((r) => (r.state === 'NONE' ? r.login : `${r.login} (re-review)`)) ?? []
    if (pr) urls.add(pr.url)
    urls.add(t.url)
    if (preview) urls.add(preview)
    lines.push(
      [
        `${t.id} "${t.title}"`,
        `Linear ${PRIORITY[t.priority] ?? 'no priority'}${t.estimate ? `, estimate ${t.estimate}` : ''}, ${t.linearState}${t.labels?.length ? `, labels ${t.labels.join('/')}` : ''} ${t.url}`,
        pr
          ? `PR #${pr.number} ${pr.url} ${pr.state === 'MERGED' ? 'merged' : pr.isDraft ? 'draft' : 'ready for review'} · ${ci(pr.ci)} · ${review(pr.reviewDecision)}${asked.length ? ` · asked: ${asked.join(', ')}` : ''}${pr.greptile?.score ? ` · Greptile ${pr.greptile.score}/5` : ''}${pr.mergeable === 'CONFLICTING' ? ' · conflicts with main' : ''}`
          : `no PR yet (mevo: ${t.status.replace('_', ' ')})`,
        t.lastPushAt && pr?.state === 'OPEN' ? `waiting ${days(t.lastPushAt, now)} since the last push` : '',
        preview ? `preview ${preview}` : '',
        detailed++ < 15 ? codeFacts(t) : '',
      ]
        .filter(Boolean)
        .join(' · '),
    )
  }
  if (withheld) lines.push(`(${withheld} more ticket${withheld === 1 ? ' is' : 's are'} not listed on purpose: if asked about it, say the person will answer when back)`)
  let text = lines.slice(0, 40).join('\n')
  if (text.length > 20_000) text = `${text.slice(0, 20_000)}…`
  return { text, urls }
}

// Asked to do something rather than to tell something: the bot can't, whatever the model thinks.
const ACT = /(^|[\s,.!?])(please|pls|can you|could you|would you|go ahead and|you should|just|can mevo|mevo,?)\s+(\w+\s+){0,2}?(merge|delete|remove|deploy|release|revert|roll ?back|push|force[- ]push|close|approve|reopen|rebase|drop|wipe|restart|run|execute|cancel)\b|^\s*(merge|delete|deploy|revert|push|close|approve|reopen|rebase|drop|wipe|restart|run|execute)\b/i
export const asksToAct = (text: string): boolean => ACT.test(text.replace(/<@[A-Z0-9]+>/g, ''))

// Fishing, not asking about work: secrets, the computer mevo runs on, its files and commands, its
// own rules. Never sent to the model, never answered.
const PROBE =
  /private[ _-]?keys?|seed phrase|mnemonic|recovery phrase|passwords?\b|passphrase|\.env\b|env(ironment)? var|api[ _-]?keys?|access[ _-]?tokens?|bot[ _-]?token|(slack|github|gh|linear|openai|anthropic|aws)\s+(token|key|secret)|\bsecrets?\b|credentials?|ssh[ -]?(keys?|into|access|config)|id_rsa|id_ed25519|keychain|wallet (file|key)|(your|his|her|their|the|this) (computer|laptop|mac|machine|hard ?drive|disk|desktop|home folder|file ?system)|what('?s| is) (on|in) (your|his|her) (computer|laptop|mac|machine|disk)|(list|show|read|cat|open|print|dump) (me )?(the |all |your )?(files|folders|directory|directories|logs|config)|\/etc\/|~\/\.|\b(sudo|rm -rf|chmod|powershell|cmd\.exe)\b|system prompt|your (instructions|prompt|rules)|ignore (all |the |your |any )?(previous|prior|above|earlier)? ?(instructions|rules|prompt)|jailbreak|developer mode|\bDAN\b|pretend (you are|to be)/i
export const probes = (text: string): boolean => PROBE.test(text.replace(/<@[A-Z0-9]+>/g, ''))

const SECRET =
  /(xox[abposr]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|lin_api_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|(?<![0-9a-fA-F])0x[0-9a-fA-F]{64}(?![0-9a-fA-F])|\b[A-Z0-9_]*(SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|MNEMONIC)[A-Z0-9_]*\s*[=:]\s*\S{6,})/

// What reaches Slack. Never a secret; never @channel/@here or a ping; with links: only links to your
// own work (strict, for what the bot posts by itself).
export function guardReply(text: string, allowed: ReadonlySet<string> | null): { text: string; blocked: string | null } {
  if (SECRET.test(text)) return { text: '', blocked: 'it looks like it contains a secret' }
  const out = text
    .replace(/<!(channel|here|everyone)[^>]*>/gi, '')
    .replace(/<!subteam\^[^>]*>/gi, '')
    .replace(/(^|\s)@(channel|here|everyone)\b/gi, '$1')
    .replace(/<@[UW][A-Z0-9]+(\|[^>]*)?>/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
  if (!out) return { text: '', blocked: 'nothing left to post' }
  if (allowed) {
    const links = [...out.matchAll(/https?:\/\/[^\s|>)]+/g)].map((m) => m[0].replace(/[.,;:!?]+$/, ''))
    const strange = links.filter((u) => ![...allowed].some((a) => u === a || u.startsWith(`${a}#`) || u.startsWith(`${a}/`)))
    if (strange.length) return { text: out, blocked: `it links somewhere outside your work (${strange[0]})` }
  }
  return { text: out, blocked: null }
}
