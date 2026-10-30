import path from 'node:path'
import type { Ticket } from '@ticketflow/shared'
import type { Config } from '../config.js'

// What metwo tells a lane in each kind of follow-up round. The first turn's brief is in brief.ts.

// Every follow-up round (your instruction, teammates' comments, Greptile findings) ends the same
// way, so the PR gets a clear "what changed, in which commit, how it looks now" on the next push.
function roundTail(flowDir: string): string {
  return `When you are done, write ${path.join(flowDir, 'UPDATE.md')}: two or three plain lines for the PR, what was wrong and what you changed (no headings, no emojis, no AI attribution). If any commit in this round changes something rendered (components, styles, copy), retake the screenshots of every affected state at 1440x900 and 390x844 into ${path.join(flowDir, 'shots')}/ as NN-after-<state>.png (overwrite the old after shot of the same state, keep its name), plus NN-before-<state>.png when you reproduced a bug, and update VISUAL.json with what you checked.`
}

// A visual check on demand: no code changes, the changed states shot again and compared.
export function visualCheckPrompt(cfg: Config, ticket: Ticket, flowDir: string, port: number): string {
  const known = ticket.visual?.checks.map((c) => `- ${c.what}${c.shot ? ` (${c.shot})` : ''}`).join('\n') ?? ''
  return `Visual check only for ${ticket.id} (${ticket.title}) in ${ticket.worktree ?? ''}. Do NOT change any code and make no commits.
Start the dev server: ${cfg.repo.commands.dev} ${port} (and Storybook with ${cfg.repo.commands.storybook} ${port + 1000} if the change has stories). Use the Playwright MCP and the e2e headless wallet fixtures as the brief describes (${path.join(flowDir, 'brief.md')}).
1. Work out every state this branch changes on screen: read git diff origin/${cfg.repo.baseBranch}...HEAD, ARM-SUMMARY.md, PR-BODY.md${known ? ` and the checks from the last visual run:\n${known}` : ''}.
2. Shoot each state at 1440x900 and 390x844 into ${path.join(flowDir, 'shots')}/, overwriting the after shot of the same state (same file name) so the PR's images can be swapped; new states get new numbered names.
3. Compare each new shot with the same name in ${path.join(flowDir, 'shots-prev')}/ and note any difference.
4. Write ${path.join(flowDir, 'VISUAL.json')} with your verdict (verified only if every check passed and you saw it), one check per state with its shot, and in "summary" what you saw and what changed since the previous run.
Stop the servers when done. If you cannot reach a state, say so in the check (not_checked) instead of guessing.`
}

export function commentsPrompt(id: string, prUrl: string, flowDir: string, comments: string): string {
  return `Teammates reviewed the PR for ${id} (${prUrl}) and left these comments. Address each one in this worktree: change the code where they are right; where you disagree, do not change code and write the reply you would give under a "## Review replies" section in ARM-SUMMARY.md, one per comment, quoting it (do NOT post to GitHub). If a comment is about something visible, reproduce it in the browser and take before/after screenshots into ${path.join(flowDir, 'shots')}/, and update VISUAL.json. Small local commits, short messages, no AI attribution, no push. Re-run typecheck, lint and the tests you touched.\n${roundTail(flowDir)}\nComments:\n${comments}`
}

export function instructPrompt(id: string, prUrl: string | undefined, text: string, saved: readonly string[], visual: boolean, flowDir: string): string {
  return `The ticket owner reviewed your work on ${id}${prUrl ? ` (PR ${prUrl})` : ''} and asks for this change:

${text.trim()}
${saved.length ? `\nThey attached ${saved.length} screenshot(s) showing the problem. Open each with the Read tool before anything else:\n${saved.map((f) => `- ${f}`).join('\n')}\n` : ''}
Do it in this worktree. If you are not sure what they mean, look at the screenshots and the code; if it is still ambiguous, write ARM-BLOCKED.md with your question and stop.
Small local commits, short messages, no AI attribution, no push. Re-run typecheck, lint and the tests you touched.${visual ? `
This is a visual issue: reproduce it in the browser first (same page, same state, same viewport as the screenshot), then fix it and take an after screenshot of exactly that state into ${path.join(flowDir, 'shots')}/ (name it NN-after-<what>.png, and NN-before-<what>.png for the reproduction). Check it at 1440x900 and 390x844. Update VISUAL.json: add a check for this issue with its screenshot, and only call it pass if you saw it fixed.` : ''}
If the change affects what PR-BODY.md says, update it. Add a "## Owner feedback" section to ARM-SUMMARY.md: what was asked, what you changed, and the commit.
${roundTail(flowDir)}`
}

export function greptilePrompt(id: string, url: string, score: number | null, list: string, flowDir: string): string {
  return `Greptile reviewed the draft PR for ${id} (${url}), confidence ${score ?? '?'}/5. Its findings:

${list}

For each finding: check it against the code and the repo rules (.greptile/config.json, .greptile/rules.md, CLAUDE.md). Fix the valid ones in this worktree with small local commits (short messages, no AI attribution, no push). For any you judge wrong, do not change code; write the reply you would give. Re-run typecheck, lint and the tests you touched. If a fix changes behaviour the PR body describes, update ${path.join(flowDir, 'PR-BODY.md')} too. Finish by adding a "## Greptile" section to ARM-SUMMARY.md: one line per finding, fixed (with commit) or declined (with the reason).
${roundTail(flowDir)}`
}

export function mergeConflictPrompt(base: string, baseBranch: string, behind: number, conflicts: readonly string[], flowDir: string): string {
  return `Merging ${base} into this branch (${behind} new commits on ${baseBranch}) stopped on conflicts in:\n${conflicts.map((f) => `- ${f}`).join('\n')}\n\nResolve each one keeping what this branch does and what ${baseBranch} changed, then finish the merge with git add and git commit --no-edit. Do not rebase and do not push. Re-run typecheck, lint and the tests around the files you touched.\n${roundTail(flowDir)}`
}

export function mergeGatesPrompt(base: string, red: readonly { name: string; tail: string }[], flowDir: string): string {
  return `${base} was merged into this branch and these checks now fail:\n\n${red.map((g) => `### ${g.name}\n${g.tail}`).join('\n\n')}\n\nFix them with small local commits (short messages, no AI attribution, no push).\n${roundTail(flowDir)}`
}

export function resumePrompt(reason: string, note: string): string {
  return `You were stopped in the middle of this work (${reason}). Read ${note} for where you were, then check git status and git log. Carry on from there; do not redo finished steps. If a dev server or Storybook was running, start it again.`
}

export function previewQaPrompt(ticket: Ticket, flowDir: string, url: string, prBody: string): string {
  const out = path.join(flowDir, 'qa')
  return `QA round for ${ticket.id} (${ticket.title}) on its deployed preview: ${url}
Do NOT change code, commit, push or post anything. Test the deployed app only, not localhost.

What to test (read all of it first):
1. The ticket and its discussion: ${path.join(flowDir, 'brief.md')} (the "Ticket" section and the acceptance criteria in ${ticket.worktree ?? ''}/ARM-SUMMARY.md).
2. The PR description below: its Changes, Verification checklist and Human Testing Required steps.

Use the Playwright MCP against ${url}. For each acceptance criterion and each testing step, drive the preview to that state and check it at 1440x900 and 390x844. Save screenshots as PNG into ${out}/ named NN-<state>-<viewport>.png. Steps that need a connected wallet, a signature or a transaction cannot be done here: mark them not_checked with the reason, never pass.

Write ${path.join(flowDir, 'QA.json')}:
{ "verdict": "pass" | "partial" | "fail", "summary": "<two sentences: what you tested on the preview and what you found>",
  "checks": [{ "what": "<criterion or step>", "result": "pass" | "fail" | "not_checked", "shot": "<file name>", "note": "<what you saw>" }] }
"pass" only if every check passed; "partial" when some could not be checked; "fail" when anything failed.

PR description:
${prBody.slice(0, 8000)}`
}
