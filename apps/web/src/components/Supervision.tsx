import type { SupervisionReport } from '@ticketflow/shared'
import { motion } from 'motion/react'
import { Pill, rise, Section } from './ui.js'

const TONE = { pass: 'ok', concerns: 'warn', fail: 'bad' } as const

// The second engine's check: verdict, criteria with their evidence, findings, and the gates metwo re-ran.
export function Supervision({ report: r }: { report: SupervisionReport }) {
  const met = r.criteria.filter((c) => c.met).length
  return (
    <Section title="Supervisor">
      <motion.div variants={rise} className="flex flex-col gap-2.5 rounded-lg border border-line bg-panel px-4 py-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Pill tone={TONE[r.verdict]}>{r.verdict}</Pill>
          <span className="text-muted">{r.engine}</span>
          {r.round > 0 && <span className="text-dim">after {r.round} round{r.round === 1 ? '' : 's'}</span>}
          {r.criteria.length > 0 && (
            <span className="ml-auto text-muted">
              {met}/{r.criteria.length} criteria met
            </span>
          )}
        </div>
        {r.summary && <p className="text-[13px] leading-relaxed text-fg-2">{r.summary}</p>}
        {r.criteria.length > 0 && (
          <ul className="flex flex-col gap-1">
            {r.criteria.map((c, i) => (
              <li key={`${c.criterion}-${i}`} className="flex items-start gap-2 text-xs">
                <span className={`w-3 shrink-0 font-semibold ${c.met ? 'text-ok' : 'text-bad'}`}>{c.met ? '✓' : '✕'}</span>
                <span className="flex-1 text-fg-2">
                  {c.criterion}
                  {c.evidence && <span className="font-mono text-[11px] text-dim"> · {c.evidence}</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
        {r.findings.length > 0 && (
          <ul className="flex flex-col gap-1 border-t border-line pt-2">
            {r.findings.map((f, i) => (
              <li key={`${f.note}-${i}`} className="text-xs text-fg-2">
                <span className={`font-mono text-[11px] font-semibold ${f.severity === 'P1' ? 'text-bad' : 'text-warn'}`}>{f.severity}</span> {f.file && <span className="font-mono text-[11px] text-muted">{f.file} </span>}
                {f.note}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-1.5 border-t border-line pt-2">
          {r.gates.map((g) => (
            <span key={g.name} title={g.tail} className={`rounded px-1.5 py-0.5 font-mono text-[11px] ${g.ok ? 'bg-raised text-muted' : 'bg-[#26161a] text-bad'}`}>
              {g.ok ? '✓' : '✕'} {g.name}
            </span>
          ))}
          <span className="text-[11px] text-dim">re-run by metwo</span>
        </div>
      </motion.div>
    </Section>
  )
}
