import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { DescChange } from '@ticketflow/shared'

// Sections an agent may edit: the checks and what was verified. Human testing, AI assistance
// and the rest of the description stay as the author wrote them.
const EDITABLE = /^(verification|regression|screenshots \/ video|visual & interaction testing|automated checks)\b/i
const NEVER = /human verified|tested by:\s*human|^\s*ref:/i

// The `## ` / `### ` heading each line sits under.
function sections(body: string): string[] {
  let h2 = ''
  let h3 = ''
  return body.split('\n').map((line) => {
    const m2 = /^##\s+(.+)/.exec(line)
    const m3 = /^###\s+(.+)/.exec(line)
    if (m2 && !line.startsWith('###')) {
      h2 = m2[1]?.trim() ?? ''
      h3 = ''
    } else if (m3) h3 = m3[1]?.trim() ?? ''
    return h3 && EDITABLE.test(h3) ? h3 : h2
  })
}

function editable(body: string, line: string): boolean {
  if (NEVER.test(line)) return false
  const lines = body.split('\n')
  const at = lines.indexOf(line)
  if (at < 0 || lines.indexOf(line, at + 1) >= 0) return false
  return EDITABLE.test(sections(body)[at] ?? '')
}

// Unticked boxes the agent could resolve, to suggest updating the description over a comment.
export function openChecks(body: string): number {
  const where = sections(body)
  return body.split('\n').filter((l, i) => /^\s*- \[ \]/.test(l) && EDITABLE.test(where[i] ?? '') && !NEVER.test(l)).length
}

// What the agent wrote, kept only where the line exists once in the live description, sits in an
// editable section and actually changes. A tick needs the box to stay the same item.
export function readPatch(file: string, body: string): { changes: DescChange[]; log: string; comment: string } {
  if (!existsSync(file)) throw new Error('the agent wrote no DESC-PATCH.json')
  const raw = JSON.parse(readFileSync(file, 'utf8')) as { changes?: { from?: string; to?: string; why?: string }[]; log?: string; comment?: string }
  const changes: DescChange[] = []
  for (const c of raw.changes ?? []) {
    const from = (c.from ?? '').replace(/\r/g, '')
    const to = (c.to ?? '').replace(/\r/g, '')
    if (!from || from === to || to.includes('\n') || !editable(body, from)) continue
    const box = /^(\s*- )\[[ x]\](.*)$/i
    const a = box.exec(from)
    const b = box.exec(to)
    if (a && b && a[2]?.split(/\s+[—–-]\s+/)[0]?.trim() !== b[2]?.split(/\s+[—–-]\s+/)[0]?.trim()) continue
    changes.push({ id: `c${changes.length + 1}`, from, to, why: (c.why ?? '').slice(0, 300) })
  }
  return { changes, log: (raw.log ?? '').split('\n')[0]?.slice(0, 200) ?? '', comment: (raw.comment ?? '').slice(0, 600) }
}

// Applies the approved changes to the description as it is now; lines someone edited meanwhile are skipped.
export function applyChanges(body: string, changes: readonly DescChange[]): { body: string; applied: DescChange[]; skipped: DescChange[] } {
  let out = body
  const applied: DescChange[] = []
  const skipped: DescChange[] = []
  for (const c of changes) {
    if (editable(out, c.from)) {
      const lines = out.split('\n')
      lines[lines.indexOf(c.from)] = c.to
      out = lines.join('\n')
      applied.push(c)
    } else skipped.push(c)
  }
  return { body: out, applied, skipped }
}

export function descPrompt(flowDir: string, worktree: string, base: string, trigger: 'visual' | 'manual'): string {
  const live = path.join(flowDir, 'PR-LIVE.md')
  return `You keep a pull request's description true to the work. Do not change code, commit, push or post anything.

Read:
1. ${live}: the PR description as it is on GitHub right now.
2. ${path.join(flowDir, 'VISUAL.json')}${trigger === 'visual' ? ' (a visual check that just ran again)' : ''} and the screenshots it names in ${path.join(flowDir, 'shots')}/.
3. ${path.join(flowDir, 'QA.json')} if it exists: a QA round on the PR's preview deploy. Its passes can tick "Preview tested against this PR's latest commit" and the Human Testing steps it covered are evidence for Known gaps, but Human Testing items stay unticked.
4. ${path.join(worktree, 'ARM-SUMMARY.md')} and git log origin/${base}..HEAD in ${worktree}: what was fixed since the description was written.

Then write ${path.join(flowDir, 'DESC-PATCH.json')}:
{
  "changes": [{ "from": "<a line copied exactly from PR-LIVE.md>", "to": "<the same line updated>", "why": "<the evidence, one sentence>" }],
  "log": "<one line for the description's Updates log, e.g. Visual check re-run: verified; ticked mobile layout and loading states>",
  "comment": "<two short sentences for a PR comment saying what was updated in the description>"
}

Rules:
- Only lines under Verification (and its ### subsections), Regression and Screenshots / Video. Never Human Testing Required, AI Assistance, Human verified or Ref.
- Tick a box ("- [ ]" to "- [x]") only when the evidence above shows it was done; you may append the result after the item ("— 390x844, verified"). Untick one whose claim is no longer true.
- Update "**Known gaps:**" and Regression lines when the new work closes or opens a gap.
- One line in, one line out; copy "from" character for character. No new sections.
- If nothing needs to change, write "changes": [] and say so in "log".`
}
