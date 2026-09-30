import {Args, Flags} from '@oclif/core'

import {DoctorCommand} from '../../lib/base.js'
import {type Diagnosis, diagnoseJob, latestJobForParent} from '../../lib/diagnose.js'
import {type FixStep, planFixes} from '../../lib/fix.js'
import {renderDiagnosis} from '../../lib/report.js'

export default class DoctorDiagnose extends DoctorCommand {
  static summary = 'Find the root cause of a failed Copado job or promotion'
  static description =
    'Reads the job steps and logs through Agentia, matches every error against the signature library, ranks root cause over cascading symptoms, gathers evidence (dependencies, conflicts, optionally a Copado AI agent) and prints the next steps. Read-only.'
  static examples = [
    '<%= config.bin %> doctor diagnose a4N5g000000XXXXEAA',
    '<%= config.bin %> doctor diagnose --promotion a0B5g000000XXXXEAA --pipeline-id a1X... --source-org-id 00D... --target-org-id 00D...',
    '<%= config.bin %> doctor diagnose a4N5g000000XXXXEAA --ai --json',
  ]
  static args = {id: Args.string({description: 'JobExecution Id'})}
  static flags = {
    promotion: Flags.string({char: 'p', description: 'Promotion Id; diagnoses its most recent failed execution'}),
    ...DoctorCommand.contextFlags,
  }

  async run(): Promise<{diagnosis: Diagnosis; plan: FixStep[]}> {
    const {args, flags} = await this.parse(DoctorDiagnose)
    let jobId = args.id
    if (!jobId && flags.promotion) {
      jobId = await latestJobForParent(this.runner, flags.promotion)
      if (!jobId) this.error(`No job executions found for promotion ${flags.promotion}`)
    }
    if (!jobId) this.error('Pass a JobExecution Id or --promotion <id>')

    const diagnosis = await diagnoseJob(this.runner, jobId, this.diagnoseOptions(flags))
    const plan = planFixes(diagnosis)
    this.log(renderDiagnosis(diagnosis, plan))
    return {diagnosis, plan}
  }
}
