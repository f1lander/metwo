import type { Decision, Lane } from '@ticketflow/shared'
import type { Config } from './config.js'
import type { LinearIssue } from './linear.js'

export interface Classification {
  readonly decision: Decision
  readonly lane: Lane
  readonly reason: string
  // a quick fix autopilot may take on its own
  readonly small: boolean
}

// Rules only, on purpose: cheap, explainable, and the operator can read why in Telegram.
// A model-based second opinion can slot in later for the "ask" bucket.
export function classify(issue: LinearIssue, cfg: Config['classifier'], autopilot: boolean): Classification {
  const labels = new Set(issue.labels)
  const text = `${issue.title}\n${issue.description}`.toLowerCase()
  const has = (names: readonly string[]) => names.some((n) => labels.has(n))

  const lane: Lane = has(cfg.fullLaneLabels) ? 'full' : 'lite'

  if (has(cfg.neverAuto)) {
    return { decision: 'ask', lane, small: false, reason: `label ${issue.labels.filter((l) => cfg.neverAuto.includes(l)).join(', ')} never auto-starts` }
  }
  if (issue.priority === 1) {
    return { decision: 'ask', lane, small: false, reason: 'urgent priority: you decide' }
  }

  const uiHint = cfg.uiHints.find((h) => text.includes(h))
  const small = issue.estimate === null || issue.estimate <= 2
  const autoLabel = has(cfg.autoLabels)

  // a label you set to start by itself (support fixes, small tweaks), UI or not
  const startLabel = has(cfg.startLabels ?? [])
  if (startLabel && small) {
    const reason = `small, with label ${issue.labels.filter((l) => (cfg.startLabels ?? []).includes(l)).join(', ')}`
    return { decision: autopilot ? 'auto' : 'ask', lane, small: true, reason: autopilot ? `${reason}; autopilot` : reason }
  }
  if (uiHint && small && (autoLabel || !labels.has('Bug'))) {
    const reason = `looks like a small UI change ("${uiHint}"${autoLabel ? ', low-risk label' : ''})`
    return { decision: autopilot ? 'auto' : 'ask', lane: 'lite', small: true, reason: autopilot ? `${reason}; autopilot` : reason }
  }

  return { decision: 'ask', lane, small: false, reason: lane === 'full' ? 'bug/risk label: suggesting the full flow' : 'no auto rule matched' }
}

// A ticket that changes what people see: triage says UI, a UI or design label, or UI words in the title.
export function looksVisual(t: { readonly title: string; readonly labels: readonly string[] }, uiHints: readonly string[], triage?: { readonly kind: string }): boolean {
  if (triage) return triage.kind === 'ui'
  if (t.labels.some((l) => /\b(ui|ux|design|frontend|visual)\b/i.test(l))) return true
  const title = t.title.toLowerCase()
  return uiHints.some((h) => new RegExp(`\\b${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(title))
}
