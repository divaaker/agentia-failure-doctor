import {isFailed, isSuccess, type Job} from './normalize.js'

export interface DoraReport {
  window: {from?: string; to?: string; days: number}
  jobs: number
  deployments: number
  deploymentsPerDay: number
  /** Failed deployment jobs / all finished deployment jobs. */
  changeFailureRate: number
  /** Mean hours from a failed job to the next successful job for the same parent / destination. */
  meanTimeToRecoveryHours?: number
  recoveries: number
  unrecovered: number
  byType: Array<{type: string; total: number; failed: number}>
}

const DEPLOYISH = /deploy|promot|release/i

/** Group key for "the same change pipeline": same parent record, else same destination + type. */
const lane = (j: Job) => j.parentId ?? `${j.destination ?? '?'}|${j.type ?? '?'}`

export function computeDora(jobs: Job[], deployTypeFilter: RegExp = DEPLOYISH): DoraReport {
  const finished = jobs.filter((j) => (isFailed(j.status) || isSuccess(j.status)) && j.createdAt)
  const deploys = finished.filter((j) => !j.type || deployTypeFilter.test(j.type) || deployTypeFilter.test(j.name))
  deploys.sort((a, b) => a.createdAt!.getTime() - b.createdAt!.getTime())

  const first = deploys[0]?.createdAt
  const last = deploys.at(-1)?.createdAt
  const days = first && last ? Math.max(1, (last.getTime() - first.getTime()) / 86_400_000) : 1
  const failed = deploys.filter((j) => isFailed(j.status))

  const recoveries: number[] = []
  let unrecovered = 0
  const lanes = new Map<string, Job[]>()
  for (const j of deploys) lanes.set(lane(j), [...(lanes.get(lane(j)) ?? []), j])
  for (const seq of lanes.values()) {
    for (let i = 0; i < seq.length; i++) {
      if (!isFailed(seq[i].status) || (i > 0 && isFailed(seq[i - 1].status))) continue // count each failure streak once
      const fix = seq.slice(i + 1).find((j) => isSuccess(j.status))
      if (fix) recoveries.push(((fix.finishedAt ?? fix.createdAt)!.getTime() - seq[i].createdAt!.getTime()) / 3_600_000)
      else unrecovered++
    }
  }

  const types = new Map<string, {total: number; failed: number}>()
  for (const j of deploys) {
    const t = types.get(j.type ?? 'unknown') ?? {total: 0, failed: 0}
    t.total++
    if (isFailed(j.status)) t.failed++
    types.set(j.type ?? 'unknown', t)
  }

  const round = (n: number) => Math.round(n * 100) / 100
  return {
    window: {from: first?.toISOString(), to: last?.toISOString(), days: round(days)},
    jobs: jobs.length,
    deployments: deploys.length,
    deploymentsPerDay: round(deploys.filter((j) => isSuccess(j.status)).length / days),
    changeFailureRate: deploys.length ? round(failed.length / deploys.length) : 0,
    meanTimeToRecoveryHours: recoveries.length ? round(recoveries.reduce((a, b) => a + b, 0) / recoveries.length) : undefined,
    recoveries: recoveries.length,
    unrecovered,
    byType: [...types].map(([type, v]) => ({type, ...v})).sort((a, b) => b.failed - a.failed),
  }
}
