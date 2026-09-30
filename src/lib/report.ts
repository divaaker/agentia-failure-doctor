import type {Diagnosis} from './diagnose.js'
import {type FixStep, renderCommand} from './fix.js'

const ICON: Record<FixStep['effect'], string> = {read: '🔍', write: '✏️ ', manual: '👤'}

/** Human report for the terminal and Slack. Plain text + light markdown so it reads in both. */
export function renderDiagnosis(d: Diagnosis, plan: FixStep[]): string {
  const out: string[] = []
  out.push(`Job ${d.job.name} (${d.job.id}) · ${d.job.status}${d.job.type ? ` · ${d.job.type}` : ''}`)
  if (d.failedSteps.length) out.push(`Failed step: ${d.failedSteps.map((s) => s.name).join(', ')}`)
  out.push('')
  if (!d.rootCause) {
    out.push('ROOT CAUSE  not found. No error lines were recognised in the step logs.')
  } else {
    const r = d.rootCause
    out.push(`ROOT CAUSE  ${r.signature.title}   [${r.signature.id}, confidence: ${d.confidence}]`)
    if (r.entity?.name) out.push(`            missing/offending: ${[r.entity.type, r.entity.name].filter(Boolean).join(' ')}`)
    if (r.components.length) out.push(`            failing component(s): ${r.components.join(', ')}`)
    out.push(`            ${r.signature.explain}`)
    out.push(`            log: ${r.sample}`)
  }
  const others = d.findings.slice(1)
  if (others.length) {
    out.push('', `ALSO SEEN (${others.length}), usually symptoms of the root cause:`)
    for (const f of others.slice(0, 8))
      out.push(`  - ${f.signature.title}${f.components.length ? ` (${f.components.slice(0, 3).join(', ')}${f.components.length > 3 ? ', …' : ''})` : ''} ×${f.occurrences}`)
    if (others.length > 8) out.push(`  … and ${others.length - 8} more`)
  }
  if (d.evidence.length) {
    out.push('', 'EVIDENCE')
    for (const e of d.evidence) out.push(`  [${e.kind}] ${e.summary}`)
  }
  if (plan.length) {
    out.push('', 'NEXT STEPS  (🔍 read-only · ✏️  changes Copado, needs confirmation · 👤 you)')
    plan.forEach((s, i) => {
      out.push(`  ${i + 1}. ${ICON[s.effect]} ${s.title}`)
      out.push(`     ${s.why}`)
      if (s.command) out.push(`     $ ${renderCommand(s.command)}`)
    })
  }
  if (d.notes.length) out.push('', ...d.notes.map((n) => `note: ${n}`))
  return out.join('\n')
}
