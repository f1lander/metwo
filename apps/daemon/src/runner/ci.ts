import type { CiDiagnosis, CiJob, CiVerdict } from '@ticketflow/shared'
import { git, sh } from './shell.js'

interface Check {
  readonly name: string
  readonly bucket: string
  readonly link: string
  readonly workflow: string
}

// gh exits non-zero when checks fail or are pending; the JSON is still on stdout
async function ghJson<T>(args: readonly string[], cwd: string): Promise<T> {
  try {
    return JSON.parse((await sh('gh', args, cwd, 60_000)).stdout || 'null') as T
  } catch (error) {
    const out = (error as { stdout?: string }).stdout
    if (out?.trim()) return JSON.parse(out) as T
    throw error
  }
}

const INFRA = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|rate limit|HTTP 5\d\d|\b50[234]\b|No space left|runner .* (lost|shutdown)|The operation was canceled|timed? ?out after|exceeded the maximum execution time|npm ERR! network|fetch failed/i

function cleanLog(raw: string): string {
  // gh prints "job<TAB>step<TAB>2026-11-02T10:00:00.0000000Z line"
  return raw
    .split('\n')
    .map((l) => l.replace(/^[^\t]*\t[^\t]*\t/, '').replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s?/, '').replace(/\x1b\[[0-9;]*m/g, ''))
    .filter((l) => l.trim())
    .slice(-120)
    .join('\n')
}

// What failed and whether it is likely this PR's doing. No AI: the base branch's last run of the
// same workflow, the PR's files named in the log, and known infra errors.
export async function diagnoseCi(worktree: string, prNumber: number, baseBranch: string, headSha: string | null): Promise<CiDiagnosis> {
  const at = new Date().toISOString()
  const checks = await ghJson<Check[]>(['pr', 'checks', String(prNumber), '--json', 'name,bucket,link,workflow'], worktree)
  const failing = (checks ?? []).filter((c) => c.bucket === 'fail')
  if (failing.length === 0) return { at, sha: headSha, verdict: 'unclear', why: 'No failing checks right now (they may have been re-run).', jobs: [] }
  const changed = (await git(['diff', '--name-only', `origin/${baseBranch}...HEAD`], worktree).catch(() => '')).split('\n').filter(Boolean)
  const mainRed = new Map<string, boolean>()
  const jobs: CiJob[] = []
  for (const c of failing.slice(0, 6)) {
    const m = /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(c.link)
    const runId = m?.[1] ?? null
    const jobId = m?.[2] ?? null
    let tail = ''
    if (runId) {
      const args = jobId ? ['run', 'view', '--job', jobId, '--log-failed'] : ['run', 'view', runId, '--log-failed']
      tail = cleanLog(await sh('gh', args, worktree, 60_000).then((r) => r.stdout, (e: { stdout?: string }) => e.stdout ?? ''))
    }
    if (c.workflow && !mainRed.has(c.workflow)) {
      const last = await ghJson<{ conclusion: string }[]>(['run', 'list', '--branch', baseBranch, '--workflow', c.workflow, '--limit', '1', '--json', 'conclusion'], worktree).catch(() => [])
      mainRed.set(c.workflow, last?.[0]?.conclusion === 'failure')
    }
    const files = changed.filter((f) => tail.includes(f) || (f.split('/').pop()?.length ?? 0) > 6 && tail.includes(f.split('/').pop() as string))
    jobs.push({ name: c.name, workflow: c.workflow, url: c.link, runId, tail, files, onMain: mainRed.get(c.workflow) === true, infra: INFRA.test(tail) && files.length === 0 })
  }
  return { at, sha: headSha, ...verdictOf(jobs), jobs }
}

export function verdictOf(jobs: readonly CiJob[]): { verdict: CiVerdict; why: string } {
  const ours = jobs.filter((j) => j.files.length > 0)
  if (ours.length) {
    const files = [...new Set(ours.flatMap((j) => j.files))].slice(0, 3)
    return { verdict: 'ours', why: `${ours.map((j) => j.name).join(', ')} fails on files this PR changed: ${files.join(', ')}.` }
  }
  if (jobs.every((j) => j.onMain)) return { verdict: 'main', why: `The same ${jobs.length === 1 ? 'check is' : 'checks are'} red on the base branch too; probably not this PR.` }
  if (jobs.every((j) => j.infra || j.onMain)) return { verdict: 'flaky', why: 'The log looks like infrastructure (network, timeout, runner); re-running is worth a try.' }
  return { verdict: 'unclear', why: `${jobs.map((j) => j.name).join(', ')} failed; the log does not name this PR's files. The lane can check whether it is related.` }
}

export async function rerunFailed(worktree: string, runIds: readonly string[]): Promise<number> {
  let n = 0
  for (const id of new Set(runIds)) {
    await sh('gh', ['run', 'rerun', id, '--failed'], worktree, 60_000)
    n++
  }
  return n
}
