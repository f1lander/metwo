import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { ContextBlock, SupervisionReport, Ticket } from '@ticketflow/shared'
import { type Config, ctxOn } from '../config.js'
import { stepInstructions } from './brief.js'
import { sh } from './shell.js'
import { repoRules } from '../knowledge.js'

type Gate = SupervisionReport['gates'][number]

// mevo re-runs the gates itself: a lane's "tests pass" is a claim, this is the fact.
export async function runGates(cfg: Config, worktree: string, signal?: AbortSignal): Promise<readonly Gate[]> {
  const gates: [string, string][] = [
    ['typecheck', cfg.repo.commands.typecheck],
    ['lint', cfg.repo.commands.lint],
    ['test', cfg.repo.commands.test],
  ]
  const out: Gate[] = []
  for (const [name, command] of gates) {
    if (!command || signal?.aborted) continue
    try {
      const { stdout, stderr } = await sh('bash', ['-lc', command], worktree, 20 * 60_000, signal)
      out.push({ name, ok: true, tail: tail(`${stdout}\n${stderr}`) })
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; message?: string }
      out.push({ name, ok: false, tail: tail(`${e.stdout ?? ''}\n${e.stderr ?? e.message ?? ''}`) })
    }
  }
  return out
}

const tail = (text: string) => text.trim().split('\n').slice(-15).join('\n')

export function supervisorPrompt(cfg: Config, ticket: Ticket, worktree: string, flowDir: string, gates: readonly Gate[]): string {
  const on = (b: ContextBlock) => ctxOn(cfg, 'supervisor', b)
  return `You are the supervisor for ${ticket.id} (${ticket.title}). Another engine implemented it in ${worktree}; your job is to check that work, not to redo it. Do NOT modify any file and do NOT commit.

Read, in this order:
1. ${path.join(flowDir, 'brief.md')}: the ticket, its Linear discussion and the rules the implementer followed.
2. The diff: git diff origin/${cfg.repo.baseBranch}...HEAD (and git log for the commit messages).
3. ${path.join(worktree, 'ARM-SUMMARY.md')} and ${path.join(flowDir, 'PR-BODY.md')}: what the implementer claims.
4. ${path.join(flowDir, 'VISUAL.json')} and every screenshot it names in ${path.join(flowDir, 'shots')}/ (open them with your file reader).${on('repoRules') ? `\n5. The repo rules at the repo root: ${repoRules(cfg.repo.path).join(', ') || 'none; judge by the code around the change'}.` : ''}

mevo already re-ran the gates, all green:
${gates.map((g) => `- ${g.name}: ok`).join('\n')}

Judge:
- Each acceptance criterion of the ticket (from the description and the Linear comments): met or not, with EVIDENCE you can point to (a test name, a screenshot file, a file:line). No evidence = not met. When the work for a criterion is missing or wrong, also file it as a P1 or P2 finding with proof. When only the evidence is missing and the lane can't produce it on this Mac (a live or test deployment, a real wallet, QA by a person), mark it not met and leave it for the owner as a P3; don't ask for it again in a later round.
- Scope: anything changed that the ticket did not ask for.
- Correctness risks a reviewer or Greptile would flag (the .greptile rules are the bar).
- Whether the visual verdict is honest: look at the screenshots yourself.
${on('figma') ? '- If brief.md has a "Design reference (Figma)" section: open the Figma images and compare them with the after screenshots yourself. A visible difference the summary does not explain is a P2 finding.\n' : ''}${on('principles') ? '- If brief.md has an "Engineering principles" section, whether the diff follows them: the smallest change, a root-cause fix instead of a guard, tests that assert behavior, claims proved by a real run. A miss is a P2 or P3 finding naming the principle.' : ''}${stepInstructions(cfg, 'supervisor')}

Write ${path.join(flowDir, 'SUPERVISE.json')} and nothing else:
{
  "verdict": "pass | concerns | fail",
  "summary": "two sentences: what you checked and your conclusion",
  "criteria": [{ "criterion": "...", "met": true, "evidence": "file:line, test name or screenshot" }],
  "findings": [{ "severity": "P1 | P2 | P3", "file": "path:line", "note": "what is wrong and what to do", "proof": { "command": "the exact command you ran", "output": "what it printed (the relevant lines)" } }]
}
"pass" only when every criterion is met with evidence and no finding is P1. "fail" when a criterion is clearly not met or something is broken.

Prove every P1 and P2 with a run against the real code: a failing test, a small repro script, a Playwright script against the dev server, or a command whose output shows the wrong behavior. Put scripts in ${path.join(flowDir, 'repro')}/, never in the worktree, and leave the worktree as you found it. A P1 or P2 without "proof" is recorded as an unproven P3. Style, naming and risks that need a future change to matter are P3 and need no proof. No findings is a valid result.`
}

// Only red gates or a proven P1/P2 send the work back to the implementer. Unmet criteria and P3
// notes alone go to you with the work: another paid round rarely closes evidence gaps.
export function needsAnotherRound(report: SupervisionReport): boolean {
  return report.gates.some((g) => !g.ok) || report.findings.some((f) => /^P[12]$/.test(f.severity) && !f.unproven)
}

export function fixPrompt(report: SupervisionReport): string {
  const gatesRed = report.gates.filter((g) => !g.ok)
  return `A supervisor (${report.engine}) checked your work and sent it back (${report.verdict}).
${report.summary}
${gatesRed.length ? `\nGates that failed when mevo re-ran them:\n${gatesRed.map((g) => `### ${g.name}\n${g.tail}`).join('\n\n')}\n` : ''}${
    report.criteria.filter((c) => !c.met).length
      ? `\nCriteria not met:\n${report.criteria
          .filter((c) => !c.met)
          .map((c) => `- ${c.criterion}${c.evidence ? ` (${c.evidence})` : ''}`)
          .join('\n')}\n`
      : ''
  }${report.findings.length ? `\nFindings:\n${report.findings.map((f) => `- [${f.severity}${f.unproven ? ', unproven' : ''}] ${f.file ? `${f.file}: ` : ''}${f.note}${f.proof ? `\n  Reproduce with: ${f.proof.command}` : ''}`).join('\n')}\n` : ''}
Fix the P1 and P2 findings. The P3 notes and unmet criteria are for the owner: fix one only if it is quick and clearly right, otherwise leave it for the PR body. Re-run each "Reproduce with" command first: fix the ones that still fail, and treat unproven ones as suggestions to check, not facts. Fix what is right with small local commits (short messages, no AI attribution, no push) and re-run typecheck, lint and the tests you touched. Where you disagree, write why under "## Supervisor replies" in ARM-SUMMARY.md. Update VISUAL.json and the screenshots if anything visible changed.`
}

// SUPERVISE.json from the supervisor; a pass without evidence counts as concerns.
export function readSupervision(flowDir: string, engine: string, gates: readonly Gate[], round: number): SupervisionReport {
  const file = path.join(flowDir, 'SUPERVISE.json')
  const base = { engine, gates, round, at: new Date().toISOString() }
  if (!existsSync(file)) return { ...base, verdict: 'concerns', summary: 'The supervisor did not write SUPERVISE.json.', criteria: [], findings: [] }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<SupervisionReport>
    rmSync(file, { force: true })
    const criteria = (Array.isArray(raw.criteria) ? raw.criteria : [])
      .filter((c) => c && typeof c.criterion === 'string')
      .map((c) => ({ criterion: c.criterion, met: c.met === true, evidence: typeof c.evidence === 'string' ? c.evidence : '' }))
    const findings = (Array.isArray(raw.findings) ? raw.findings : [])
      .filter((f) => f && typeof f.note === 'string')
      .map((f) => {
        const severity = typeof f.severity === 'string' ? f.severity : 'P3'
        const proof = f.proof && typeof f.proof.command === 'string' && f.proof.command.trim() && typeof f.proof.output === 'string' && f.proof.output.trim() ? { command: f.proof.command.slice(0, 500), output: f.proof.output.slice(0, 2000) } : null
        const unproven = /^P[12]$/.test(severity) && !proof
        return { severity: unproven ? 'P3' : severity, note: f.note, ...(typeof f.file === 'string' ? { file: f.file } : {}), ...(proof ? { proof } : {}), ...(unproven ? { unproven: true } : {}) }
      })
    let verdict: SupervisionReport['verdict'] = raw.verdict === 'pass' || raw.verdict === 'fail' ? raw.verdict : 'concerns'
    // a fail that rested only on findings it could not prove is a concern, not a send-back
    if (verdict === 'fail' && criteria.every((c) => c.met) && !findings.some((f) => /^P[12]$/.test(f.severity))) verdict = 'concerns'
    const unproven = criteria.some((c) => !c.met || !c.evidence.trim())
    if (verdict === 'pass' && (unproven || criteria.length === 0 || findings.some((f) => f.severity === 'P1'))) verdict = 'concerns'
    return { ...base, verdict, summary: typeof raw.summary === 'string' ? raw.summary : '', criteria, findings }
  } catch {
    return { ...base, verdict: 'concerns', summary: 'SUPERVISE.json could not be read.', criteria: [], findings: [] }
  }
}

export function gatesFailed(engine: string, gates: readonly Gate[], round: number): SupervisionReport {
  const red = gates.filter((g) => !g.ok).map((g) => g.name)
  return { engine: `mevo gates (before ${engine})`, gates, round, at: new Date().toISOString(), verdict: 'fail', summary: `${red.join(', ')} failed when mevo re-ran them.`, criteria: [], findings: [] }
}
