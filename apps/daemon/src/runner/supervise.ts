import { existsSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { SupervisionReport, Ticket } from '@ticketflow/shared'
import type { Config } from '../config.js'
import { sh } from './shell.js'
import { repoRules } from '../knowledge.js'

type Gate = SupervisionReport['gates'][number]

// metwo re-runs the gates itself: a lane's "tests pass" is a claim, this is the fact.
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
  return `You are the supervisor for ${ticket.id} (${ticket.title}). Another engine implemented it in ${worktree}; your job is to check that work, not to redo it. Do NOT modify any file and do NOT commit.

Read, in this order:
1. ${path.join(flowDir, 'brief.md')}: the ticket, its Linear discussion and the rules the implementer followed.
2. The diff: git diff origin/${cfg.repo.baseBranch}...HEAD (and git log for the commit messages).
3. ${path.join(worktree, 'ARM-SUMMARY.md')} and ${path.join(flowDir, 'PR-BODY.md')}: what the implementer claims.
4. ${path.join(flowDir, 'VISUAL.json')} and every screenshot it names in ${path.join(flowDir, 'shots')}/ (open them with your file reader).
5. The repo rules at the repo root: ${repoRules(cfg.repo.path).join(', ') || 'none; judge by the code around the change'}.

metwo already re-ran the gates, all green:
${gates.map((g) => `- ${g.name}: ok`).join('\n')}

Judge:
- Each acceptance criterion of the ticket (from the description and the Linear comments): met or not, with EVIDENCE you can point to (a test name, a screenshot file, a file:line). No evidence = not met.
- Scope: anything changed that the ticket did not ask for.
- Correctness risks a reviewer or Greptile would flag (the .greptile rules are the bar).
- Whether the visual verdict is honest: look at the screenshots yourself.

Write ${path.join(flowDir, 'SUPERVISE.json')} and nothing else:
{
  "verdict": "pass | concerns | fail",
  "summary": "two sentences: what you checked and your conclusion",
  "criteria": [{ "criterion": "...", "met": true, "evidence": "file:line, test name or screenshot" }],
  "findings": [{ "severity": "P1 | P2 | P3", "file": "path:line", "note": "what is wrong and what to do" }]
}
"pass" only when every criterion is met with evidence and no finding is P1. "fail" when a criterion is clearly not met or something is broken.`
}

export function fixPrompt(report: SupervisionReport): string {
  const gatesRed = report.gates.filter((g) => !g.ok)
  return `A supervisor (${report.engine}) checked your work and sent it back (${report.verdict}).
${report.summary}
${gatesRed.length ? `\nGates that failed when metwo re-ran them:\n${gatesRed.map((g) => `### ${g.name}\n${g.tail}`).join('\n\n')}\n` : ''}${
    report.criteria.filter((c) => !c.met).length
      ? `\nCriteria not met:\n${report.criteria
          .filter((c) => !c.met)
          .map((c) => `- ${c.criterion}${c.evidence ? ` (${c.evidence})` : ''}`)
          .join('\n')}\n`
      : ''
  }${report.findings.length ? `\nFindings:\n${report.findings.map((f) => `- [${f.severity}] ${f.file ? `${f.file}: ` : ''}${f.note}`).join('\n')}\n` : ''}
Fix what is right with small local commits (short messages, no AI attribution, no push) and re-run typecheck, lint and the tests you touched. Where you disagree, write why under "## Supervisor replies" in ARM-SUMMARY.md. Update VISUAL.json and the screenshots if anything visible changed.`
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
      .map((f) => ({ severity: typeof f.severity === 'string' ? f.severity : 'P3', note: f.note, ...(typeof f.file === 'string' ? { file: f.file } : {}) }))
    let verdict: SupervisionReport['verdict'] = raw.verdict === 'pass' || raw.verdict === 'fail' ? raw.verdict : 'concerns'
    const unproven = criteria.some((c) => !c.met || !c.evidence.trim())
    if (verdict === 'pass' && (unproven || criteria.length === 0 || findings.some((f) => f.severity === 'P1'))) verdict = 'concerns'
    return { ...base, verdict, summary: typeof raw.summary === 'string' ? raw.summary : '', criteria, findings }
  } catch {
    return { ...base, verdict: 'concerns', summary: 'SUPERVISE.json could not be read.', criteria: [], findings: [] }
  }
}

export function gatesFailed(engine: string, gates: readonly Gate[], round: number): SupervisionReport {
  const red = gates.filter((g) => !g.ok).map((g) => g.name)
  return { engine: `metwo gates (before ${engine})`, gates, round, at: new Date().toISOString(), verdict: 'fail', summary: `${red.join(', ')} failed when metwo re-ran them.`, criteria: [], findings: [] }
}
