import {Flags} from '@oclif/core'

import {DoctorCommand} from '../../lib/base.js'
import type {DoraReport} from '../../lib/dora.js'
import {doraFromHistory} from '../../lib/scan.js'

export default class DoctorDora extends DoctorCommand {
  static summary = 'DORA metrics from Copado job history'
  static description =
    'Pages through job executions via Agentia and reports deployment frequency, change failure rate and mean time to recovery, broken down by job type. Read-only.'
  static examples = ['<%= config.bin %> doctor dora', '<%= config.bin %> doctor dora --type Promotion --max-jobs 1000 --json']
  static flags = {
    type: Flags.string({description: 'Contains match on Job Template name'}),
    'max-jobs': Flags.integer({description: 'Stop after this many jobs', default: 600, min: 1}),
  }

  async run(): Promise<DoraReport> {
    const {flags} = await this.parse(DoctorDora)
    const r = await doraFromHistory(this.runner, {type: flags.type, maxJobs: flags['max-jobs']})
    const pct = (n: number) => `${Math.round(n * 100)}%`
    this.log(`Window: ${r.window.from?.slice(0, 10) ?? '?'} → ${r.window.to?.slice(0, 10) ?? '?'} (${r.window.days} days, ${r.deployments} deployment jobs)`)
    this.log(`Deployment frequency   ${r.deploymentsPerDay} successful / day`)
    this.log(`Change failure rate    ${pct(r.changeFailureRate)}`)
    this.log(
      `Mean time to recovery  ${r.meanTimeToRecoveryHours === undefined ? 'n/a' : `${r.meanTimeToRecoveryHours} h`}  (${r.recoveries} recovered, ${r.unrecovered} still failing)`,
    )
    if (r.byType.length) {
      this.log('\nBy job type:')
      for (const t of r.byType) this.log(`  ${t.type.padEnd(32)} ${String(t.failed).padStart(4)} failed / ${t.total}  (${pct(t.failed / t.total)})`)
    }
    return r
  }
}
