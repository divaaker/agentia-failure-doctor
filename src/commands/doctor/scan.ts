import {Flags} from '@oclif/core'

import {DoctorCommand} from '../../lib/base.js'
import {scanFailures} from '../../lib/scan.js'

export default class DoctorScan extends DoctorCommand {
  static summary = 'Diagnose recent failed jobs and group them by root cause'
  static description =
    'Lists failed job executions through Agentia, diagnoses each one, and groups them by root-cause fingerprint so recurring failures stand out. Read-only.'
  static examples = ['<%= config.bin %> doctor scan', '<%= config.bin %> doctor scan --type Deploy --limit 50 --json']
  static flags = {
    status: Flags.string({description: 'Copado job status that means failed', default: 'Error'}),
    type: Flags.string({description: 'Contains match on Job Template name, e.g. Deploy or Promotion'}),
    parent: Flags.string({description: 'Only jobs under this parent record (e.g. a Promotion)'}),
    mine: Flags.boolean({description: 'Only jobs owned by the current user', default: false}),
    limit: Flags.integer({description: 'Maximum failed jobs to diagnose', default: 20, min: 1, max: 200}),
  }

  async run() {
    const {flags} = await this.parse(DoctorScan)
    const res = await scanFailures(this.runner, {
      ...flags,
      onProgress: (i, n) => process.stderr.write(`\rdiagnosing ${i}/${n}…`),
    })
    process.stderr.write('\r\x1b[K')
    this.log(`${res.scanned} failed job(s), ${res.groups.length} distinct root cause(s)\n`)
    for (const g of res.groups) {
      this.log(`${String(g.jobs.length).padStart(3)} × ${g.title}  [${g.category}]`)
      this.log(`      ${g.fingerprint}`)
      this.log(`      ${g.jobs.slice(0, 6).join(', ')}${g.jobs.length > 6 ? ', …' : ''}`)
    }
    return res
  }
}
