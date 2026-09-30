import type {AgentiaRunner} from './agentia.js'
import {diagnoseJob} from './diagnose.js'
import {computeDora, type DoraReport} from './dora.js'
import {type Job, list, normalizeJob, pick, str} from './normalize.js'

export interface ScanGroup {
  fingerprint: string
  title: string
  category: string
  jobs: string[]
}

export interface ScanOptions {
  status?: string
  type?: string
  parent?: string
  mine?: boolean
  limit?: number
  onProgress?: (done: number, total: number) => void
}

/** Diagnose recent failed jobs and group them by root-cause fingerprint, most frequent first. */
export async function scanFailures(runner: AgentiaRunner, o: ScanOptions = {}): Promise<{scanned: number; groups: ScanGroup[]}> {
  const limit = o.limit ?? 20
  const args = ['cicd', 'job', 'list', '--status', o.status ?? 'Error', '--page-size', String(limit)]
  if (o.type) args.push('--type', o.type)
  if (o.parent) args.push('--parent', o.parent)
  if (o.mine) args.push('--mine')
  const jobs = list(await runner.run(args)).map(normalizeJob).slice(0, limit)

  const groups = new Map<string, ScanGroup>()
  for (const [i, job] of jobs.entries()) {
    o.onProgress?.(i + 1, jobs.length)
    const d = await diagnoseJob(runner, job.id).catch(() => undefined)
    const key = d?.rootCause?.fingerprint ?? 'NO-DIAGNOSIS'
    const g = groups.get(key) ?? {
      fingerprint: key,
      title: d?.rootCause?.signature.title ?? 'Could not diagnose (no recognisable errors or log unavailable)',
      category: d?.rootCause?.signature.category ?? 'unknown',
      jobs: [],
    }
    g.jobs.push(job.name === 'unknown' ? job.id : job.name)
    groups.set(key, g)
  }
  return {scanned: jobs.length, groups: [...groups.values()].sort((a, b) => b.jobs.length - a.jobs.length)}
}

/** Page through job history (cursor-based) and compute DORA metrics. */
export async function doraFromHistory(runner: AgentiaRunner, o: {type?: string; maxJobs?: number} = {}): Promise<DoraReport> {
  const max = o.maxJobs ?? 600
  const jobs: Job[] = []
  let cursor: string | undefined
  do {
    const args = ['cicd', 'job', 'list', '--page-size', '200']
    if (o.type) args.push('--type', o.type)
    if (cursor) args.push('--cursor', cursor)
    const page = await runner.run(args)
    jobs.push(...list(page).map(normalizeJob))
    cursor = str(pick(page, 'nextCursor', 'cursor'))
  } while (cursor && jobs.length < max)
  return computeDora(jobs.slice(0, max))
}
