import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { VisualReport, VisualVerdict } from '@ticketflow/shared'

const VERDICTS: readonly VisualVerdict[] = ['verified', 'partial', 'not_verified', 'not_applicable']
const RESULTS = ['pass', 'fail', 'not_checked'] as const

// VISUAL.json is written by the lane; anything malformed is reported as not verified rather
// than trusted, so a broken file never reads as a pass.
export function readVisual(flowDir: string): VisualReport | undefined {
  const file = path.join(flowDir, 'VISUAL.json')
  if (!existsSync(file)) return undefined
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<VisualReport>
    const verdict = VERDICTS.includes(raw.verdict as VisualVerdict) ? (raw.verdict as VisualVerdict) : 'not_verified'
    const checks = Array.isArray(raw.checks)
      ? raw.checks
          .filter((c) => c && typeof c.what === 'string')
          .map((c) => ({
            what: c.what,
            result: RESULTS.includes(c.result as (typeof RESULTS)[number]) ? c.result : ('not_checked' as const),
            ...(typeof c.shot === 'string' ? { shot: path.basename(c.shot) } : {}),
            ...(typeof c.note === 'string' ? { note: c.note } : {}),
          }))
      : []
    // a "verified" with a failed or unchecked item is only partial
    const honest = verdict === 'verified' && checks.some((c) => c.result !== 'pass') ? 'partial' : verdict
    return {
      verdict: honest,
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      checks,
      ...(Array.isArray(raw.viewports) ? { viewports: raw.viewports.filter((v): v is string => typeof v === 'string') } : {}),
    }
  } catch {
    return { verdict: 'not_verified', summary: 'VISUAL.json could not be read', checks: [] }
  }
}
