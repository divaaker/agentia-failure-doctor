import {AgentiaError, type AgentiaRunner} from './agentia.js'
import {extractErrors} from './extract.js'
import {allRules} from './library.js'
import {redactDeep} from './redact.js'
import {isFailed, isResolved, type Job, type JobStep, list, logText, normalizeJob, pick, str} from './normalize.js'
import {type Category, type Classified, classify, fingerprint, type Signature, SIGNATURES} from './signatures.js'

export interface Finding {
  fingerprint: string
  signature: Pick<Signature, 'id' | 'title' | 'category' | 'rank' | 'explain' | 'fix'>
  entity?: {type?: string; name?: string}
  /** Components in this job that failed with this signature. */
  components: string[]
  step: string
  occurrences: number
  sample: string
}

export interface Evidence {
  kind: 'dependencies' | 'conflicts' | 'ai'
  summary: string
  detail?: unknown
}

export interface Diagnosis {
  job: Pick<Job, 'id' | 'name' | 'status' | 'type' | 'parentId' | 'destination'>
  failedSteps: Array<Pick<JobStep, 'id' | 'name' | 'status'>>
  rootCause?: Finding
  findings: Finding[]
  /** How sure we are the root cause is right: high = specific rule + evidence, low = unknown / no errors found. */
  confidence: 'high' | 'medium' | 'low'
  evidence: Evidence[]
  notes: string[]
}

export interface DiagnoseOptions {
  /** Needed for `cicd metadata dependency list`. Without it we skip that evidence and say so. */
  pipelineId?: string
  sourceOrgId?: string
  targetOrgId?: string
  sourceCredentialId?: string
  promotionId?: string
  rules?: Signature[]
  /** Ask a Copado AI agent about findings no rule recognised. */
  ai?: boolean
  /** Agentia agent: plan|build|test|release|operate|knowledge. Defaults to release. */
  aiAgent?: string
}

const brief = (s: Signature): Finding['signature'] => ({
  id: s.id,
  title: s.title,
  category: s.category,
  rank: s.rank,
  explain: s.explain,
  fix: s.fix,
})

/** Resolve a Promotion to its most recent job execution via `job list --parent`. */
export async function latestJobForParent(runner: AgentiaRunner, parentId: string): Promise<string | undefined> {
  const jobs = list(await runner.run(['cicd', 'job', 'list', '--parent', parentId, '--page-size', '50'])).map(normalizeJob)
  jobs.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0))
  return (jobs.find((j) => isFailed(j.status)) ?? jobs[0])?.id
}

export function rankFindings(classified: Array<Classified & {step: string}>): Finding[] {
  const byPrint = new Map<string, Finding>()
  for (const c of classified) {
    const fp = fingerprint(c)
    const comp = [c.error.componentType, c.error.component].filter(Boolean).join(':')
    const f = byPrint.get(fp)
    if (f) {
      f.occurrences++
      if (comp && !f.components.includes(comp)) f.components.push(comp)
    } else {
      byPrint.set(fp, {
        fingerprint: fp,
        signature: brief(c.signature),
        entity: c.entity,
        components: comp ? [comp] : [],
        step: c.step,
        occurrences: 1,
        sample: c.error.raw.slice(0, 400),
      })
    }
  }
  return [...byPrint.values()].sort((a, b) => a.signature.rank - b.signature.rank || b.occurrences - a.occurrences)
}

export async function diagnoseJob(runner: AgentiaRunner, jobId: string, opts: DiagnoseOptions = {}): Promise<Diagnosis> {
  const job = normalizeJob(await runner.run(['cicd', 'job', 'get', jobId]))
  const notes: string[] = []
  const evidence: Evidence[] = []
  const rules = opts.rules ?? (await allRules())

  let failed = job.steps.filter((s) => isFailed(s.status))
  if (failed.length === 0) {
    if (!isFailed(job.status)) notes.push(`Job status is "${job.status}": nothing failed. Diagnosing its logs anyway.`)
    // No step marked failed: inspect the last step that produced a result.
    const last = [...job.steps].reverse().find((s) => s.resultId) ?? job.steps.at(-1)
    failed = last ? [last] : []
  }

  const classified: Array<Classified & {step: string}> = []
  for (const step of failed) {
    let text = step.errorMessage ?? ''
    try {
      const args = ['cicd', 'job', 'log', 'get', job.id]
      if (!step.id.startsWith('step-')) args.push('--step', step.id)
      text += '\n' + logText(await runner.run(args))
    } catch (err) {
      notes.push(`Could not read the log for step "${step.name}": ${(err as Error).message}`)
    }
    for (const e of extractErrors(text)) classified.push({...classify(e, rules), step: step.name})
  }
  if (job.errorMessage && classified.length === 0)
    for (const e of extractErrors(job.errorMessage)) classified.push({...classify(e, rules), step: 'job'})

  const findings = rankFindings(classified)
  const rootCause = findings[0]

  if (rootCause?.signature.category === 'merge-conflict' || opts.promotionId) {
    const promo = opts.promotionId ?? job.parentId
    if (promo) await collectConflicts(runner, promo, evidence, notes)
  }
  if (rootCause && SIGNATURES.find((s) => s.id === rootCause.signature.id)?.checkDependencies)
    await collectDependencies(runner, rootCause, opts, evidence, notes)
  if (opts.ai) await askAi(runner, job, findings, opts, evidence, notes)

  return redactDeep({
    job: {id: job.id, name: job.name, status: job.status, type: job.type, parentId: job.parentId, destination: job.destination},
    failedSteps: failed.map((s) => ({id: s.id, name: s.name, status: s.status})),
    rootCause,
    findings,
    confidence: confidenceOf(rootCause, evidence),
    evidence,
    notes,
  })
}

function confidenceOf(root: Finding | undefined, evidence: Evidence[]): Diagnosis['confidence'] {
  if (root?.signature.id.startsWith('LOCAL-')) return 'high' // confirmed by the team with `doctor learn`
  if (!root || root.signature.category === 'unknown') return evidence.some((e) => e.kind === 'ai') ? 'medium' : 'low'
  const strong: Category[] = ['credential', 'merge-conflict', 'coverage', 'test-failure', 'org-limit', 'active-version']
  if (strong.includes(root.signature.category) || evidence.some((e) => e.kind !== 'ai')) return 'high'
  return 'medium'
}

async function collectConflicts(runner: AgentiaRunner, promotionId: string, evidence: Evidence[], notes: string[]) {
  try {
    const conflicts = list(await runner.run(['cicd', 'promotion', 'conflict', 'list', '-p', promotionId]))
    const open = conflicts.filter((c) => !isResolved(str(pick(c, 'status', 'resolution'))))
    evidence.push({
      kind: 'conflicts',
      summary: `${open.length} unresolved of ${conflicts.length} conflict(s) on promotion ${promotionId}`,
      detail: conflicts.map((c) => ({id: str(pick(c, 'id')), file: str(pick(c, 'file', 'path', 'fileName')), status: str(pick(c, 'status'))})),
    })
  } catch (err) {
    notes.push(`Conflict check skipped: ${(err as Error).message}`)
  }
}

async function collectDependencies(
  runner: AgentiaRunner,
  root: Finding,
  opts: DiagnoseOptions,
  evidence: Evidence[],
  notes: string[],
) {
  const [compType, compName] = (root.components[0] ?? '').split(':')
  if (!opts.pipelineId || !(opts.sourceOrgId || opts.sourceCredentialId)) {
    notes.push('Dependency evidence skipped: pass --pipeline-id and --source-org-id (or set project defaults) to check what the failing component needs.')
    return
  }
  if (!compType || !compName) {
    notes.push('Dependency evidence skipped: the log did not name the failing component.')
    return
  }
  const args = ['cicd', 'metadata', 'dependency', 'list', '--pipeline-id', opts.pipelineId, '--metadata-type', compType, '--metadata-name', compName]
  if (opts.sourceOrgId) args.push('--source-org-id', opts.sourceOrgId)
  if (opts.sourceCredentialId) args.push('--source-credential-id', opts.sourceCredentialId)
  if (opts.targetOrgId) args.push('--target-org-id', opts.targetOrgId, '--retrieve-mode', 'diff_only')
  try {
    const deps = list(await runner.run(args))
    const names = deps.map((d) => [str(pick(d, 'type', 'metadataType')), str(pick(d, 'name', 'fullName', 'metadataName'))].filter(Boolean).join(':'))
    const wanted = root.entity?.name?.toLowerCase()
    const hit = wanted ? names.find((n) => n.toLowerCase().endsWith(wanted) || n.toLowerCase().includes(`:${wanted}`)) : undefined
    evidence.push({
      kind: 'dependencies',
      summary: hit
        ? `${compType} ${compName} depends on ${hit}, which is missing from the destination${opts.targetOrgId ? '' : ' (target not compared)'}`
        : `${compType} ${compName} has ${names.length} dependenc${names.length === 1 ? 'y' : 'ies'}${opts.targetOrgId ? ' not in the destination' : ''}`,
      detail: names.slice(0, 50),
    })
  } catch (err) {
    notes.push(`Dependency check failed: ${(err as Error).message}`)
  }
}

async function askAi(runner: AgentiaRunner, job: Job, findings: Finding[], opts: DiagnoseOptions, evidence: Evidence[], notes: string[]) {
  const unknown = findings.filter((f) => f.signature.category === 'unknown')
  if (unknown.length === 0) return
  const prompt = [
    `A Copado job "${job.name}" (${job.type ?? 'deployment'}) failed. No known rule matched these Salesforce errors:`,
    ...unknown.slice(0, 5).map((f) => `- ${f.sample}`),
    'For each: the most likely root cause in one sentence, and the concrete fix. Do not guess beyond the evidence.',
  ].join('\n')
  const args = ['ai', 'agent', 'ask', '-p', prompt, '--agent', opts.aiAgent ?? 'release', '--no-credential-sync']
  try {
    const res = await runner.run(args)
    const answer = str(pick(res, 'answer', 'response', 'text', 'message', 'content')) ?? logText(res)
    evidence.push({kind: 'ai', summary: answer.trim().slice(0, 1500)})
  } catch (err) {
    notes.push(`AI analysis skipped: ${err instanceof AgentiaError ? err.message : String(err)}`)
  }
}
