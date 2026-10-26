import {Flags} from '@oclif/core'

import {DoctorCommand} from '../../lib/base.js'
import {DEMO, DemoRunner, demoStatePath} from '../../lib/demo.js'

export default class DoctorDemo extends DoctorCommand {
  static summary = 'Reset and describe the built-in synthetic Copado pipeline'
  static description =
    'The demo pipeline (dev → UAT → production, six weeks of history, five open failures) answers the same Agentia commands as a real Copado org, so every doctor command can be tried with --demo and no API key. All data is synthetic.'
  static examples = ['<%= config.bin %> doctor demo --reset', '<%= config.bin %> doctor scan --demo']
  static flags = {reset: Flags.boolean({description: 'Start the demo pipeline over', default: false})}

  async run() {
    const {flags} = await this.parse(DoctorDemo)
    if (flags.reset) DemoRunner.reset()
    this.log(`Synthetic pipeline "Acme Sales Cloud": dev → UAT → production   (state: ${demoStatePath()})`)
    this.log(`  --pipeline-id ${DEMO.pipelineId} --source-org-id ${DEMO.devOrgId} --target-org-id ${DEMO.uatOrgId}`)
    this.log('\nOpen failures to try:')
    this.log('  JE-000101  missing dependency + cascade      agentia doctor diagnose JE-000101 --demo')
    this.log('  JE-000102  merge conflict                    agentia doctor fix JE-000102 --apply --demo')
    this.log('  JE-000103  expired credential                agentia doctor diagnose JE-000103 --demo')
    this.log('  JE-000104  failing Apex tests                agentia doctor diagnose JE-000104 --demo')
    this.log('  JE-000106  unrecognised error                agentia doctor diagnose JE-000106 --ai --demo')
    this.log('\nStories for preflight: US-0000105 (blocked), US-0000107 (safe)')
    return {...DEMO, statePath: demoStatePath()}
  }
}
