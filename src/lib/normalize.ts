/**
 * Defensive readers for Agentia JSON payloads.
 *
 * The gateway may return camelCase keys (`resultId`) or raw Copado field names
 * (`copado__Result__c`). `keyOf` folds both to one form so the rest of the code
 * never cares which it got.
 */

export type Json = null | boolean | number | string | Json[] | {[k: string]: Json}
type Obj = Record<string, unknown>

export const keyOf = (k: string): string =>
  k
    .toLowerCase()
    .replace(/^copado__/, '')
    .replace(/__c$|__r$/, '')
    .replace(/[_\s-]/g, '')

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/** First value whose folded key matches any of `names`. */
export function pick(obj: unknown, ...names: string[]): unknown {
  if (!isObj(obj)) return undefined
  const wanted = new Set(names.map(keyOf))
  for (const [k, v] of Object.entries(obj)) if (wanted.has(keyOf(k)) && v !== null && v !== undefined) return v
  return undefined
}

export const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined

export const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : Number.NaN
  return Number.isFinite(n) ? n : undefined
}

/** Unwrap list envelopes: `[...]`, `{records: [...]}`, `{items: [...]}`, `{data: [...]}`. */
export function list(v: unknown): Obj[] {
  if (Array.isArray(v)) return v.filter(isObj)
  const inner = pick(v, 'records', 'items', 'data', 'results', 'jobs', 'promotions')
  return Array.isArray(inner) ? inner.filter(isObj) : []
}

export interface JobStep {
  id: string
  name: string
  order: number
  status: string
  resultId?: string
  type?: string
  errorMessage?: string
}

export interface Job {
  id: string
  name: string
  status: string
  type?: string
  parentId?: string
  destination?: string
  errorMessage?: string
  createdAt?: Date
  finishedAt?: Date
  steps: JobStep[]
}

const date = (v: unknown): Date | undefined => {
  const s = str(v)
  if (!s) return undefined
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? undefined : d
}

export function normalizeStep(raw: unknown, index: number): JobStep {
  const result = pick(raw, 'result')
  return {
    id: str(pick(raw, 'id', 'stepId')) ?? `step-${index + 1}`,
    name: str(pick(raw, 'name', 'stepName', 'label')) ?? `Step ${index + 1}`,
    order: num(pick(raw, 'order', 'sequence', 'position')) ?? index + 1,
    status: str(pick(raw, 'status', 'resultStatus')) ?? str(pick(result, 'status')) ?? 'Unknown',
    resultId: str(pick(raw, 'resultId', 'lastResultId')) ?? str(isObj(result) ? pick(result, 'id') : result),
    type: str(pick(raw, 'type', 'stepType')),
    errorMessage:
      str(pick(raw, 'errorMessage', 'error', 'message')) ?? str(pick(result, 'errorMessage', 'errorCode')),
  }
}

export function normalizeJob(raw: unknown): Job {
  const job = isObj(pick(raw, 'job', 'jobExecution')) ? pick(raw, 'job', 'jobExecution') : raw
  const stepsRaw = pick(raw, 'steps', 'jobSteps', 'orderedSteps') ?? pick(job, 'steps', 'jobSteps')
  const steps = (Array.isArray(stepsRaw) ? stepsRaw : list(stepsRaw)).map(normalizeStep)
  steps.sort((a, b) => a.order - b.order)
  return {
    id: str(pick(job, 'id', 'jobExecutionId')) ?? 'unknown',
    name: str(pick(job, 'name')) ?? str(pick(job, 'id')) ?? 'unknown',
    status: str(pick(job, 'status')) ?? 'Unknown',
    type: str(pick(job, 'type', 'jobTemplateName', 'template', 'jobTemplate')),
    parentId: str(pick(job, 'parentId', 'parentRecordId', 'parent', 'promotion', 'deployment')),
    destination: str(pick(job, 'destinationEnvironment', 'destination', 'environment', 'destinationName')),
    errorMessage: str(pick(job, 'errorMessage', 'error')),
    createdAt: date(pick(job, 'createdDate', 'createdAt', 'startDate', 'startedAt')),
    finishedAt: date(pick(job, 'endDate', 'finishedAt', 'completedDate', 'lastModifiedDate')),
    steps,
  }
}

const FAILED = /fail|error|cancel|abort/i
export const isFailed = (status: string | undefined): boolean => !!status && FAILED.test(status)
/** Conflict status: "Resolved (auto)" yes, "Unresolved" no. */
export const isResolved = (status: string | undefined): boolean => !!status && /\bresolved/i.test(status)
export const isSuccess = (status: string | undefined): boolean => !!status && /success|complete|done/i.test(status)

/**
 * Flatten any log payload to text. Log endpoints may return a bare string, `{log}`,
 * `{content}`, or nested objects with the deploy result embedded; we keep every
 * string leaf so no error line is lost, and keep JSON blobs parseable.
 */
export function logText(raw: unknown): string {
  if (typeof raw === 'string') return raw
  const direct = str(pick(raw, 'log', 'content', 'body', 'output', 'text'))
  if (direct) return direct
  const out: string[] = []
  const walk = (v: unknown, depth: number) => {
    if (depth > 8) return
    if (typeof v === 'string') out.push(v)
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1))
    else if (isObj(v)) {
      // Structured deploy failures are worth keeping as JSON for the extractor.
      if (pick(v, 'componentFailures', 'problem', 'problemType')) out.push(JSON.stringify(v))
      else Object.values(v).forEach((x) => walk(x, depth + 1))
    }
  }
  walk(raw, 0)
  return out.join('\n')
}
