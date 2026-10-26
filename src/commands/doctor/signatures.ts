import {DoctorCommand} from '../../lib/base.js'
import {allRules} from '../../lib/library.js'

export default class DoctorSignatures extends DoctorCommand {
  static summary = 'List the failure signatures the Doctor recognises'
  static examples = ['<%= config.bin %> doctor signatures', '<%= config.bin %> doctor signatures --json']

  async run() {
    await this.parse(DoctorSignatures)
    const rows = (await allRules()).map((s) => ({id: s.id, category: s.category, rank: s.rank, title: s.title, fix: s.fix}))
    for (const r of rows) this.log(`${r.id.padEnd(28)} ${r.category.padEnd(20)} ${r.title}`)
    return rows
  }
}
