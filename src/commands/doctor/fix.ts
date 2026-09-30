import {Args, Flags} from '@oclif/core'
import {createInterface} from 'node:readline/promises'

import {DoctorCommand} from '../../lib/base.js'
import {diagnoseJob, latestJobForParent} from '../../lib/diagnose.js'
import {type FixStep, planFixes, renderCommand} from '../../lib/fix.js'
import {renderDiagnosis} from '../../lib/report.js'

interface StepResult {
  step: FixStep
  status: 'ran' | 'skipped' | 'failed' | 'planned'
  output?: unknown
  error?: string
}

export default class DoctorFix extends DoctorCommand {
  static summary = 'Propose, and with --apply run, the fix for a failed job'
  static description =
    'Diagnoses the job, then walks the fix plan. Without --apply it is a dry run that only prints the plan. With --apply it runs read-only steps and asks before every step that changes Copado (unless --yes). Manual steps are never automated.'
  static examples = [
    '<%= config.bin %> doctor fix a4N5g000000XXXXEAA',
    '<%= config.bin %> doctor fix --promotion a0B5g000000XXXXEAA --apply',
  ]
  static args = {id: Args.string({description: 'JobExecution Id'})}
  static flags = {
    promotion: Flags.string({char: 'p', description: 'Promotion Id; fixes its most recent failed execution'}),
    apply: Flags.boolean({description: 'Run the plan (asks before each change)', default: false}),
    yes: Flags.boolean({char: 'y', description: 'With --apply, do not ask before changes', default: false}),
    ...DoctorCommand.contextFlags,
  }

  async run(): Promise<{applied: boolean; steps: StepResult[]}> {
    const {args, flags} = await this.parse(DoctorFix)
    const jobId = args.id ?? (flags.promotion ? await latestJobForParent(this.runner, flags.promotion) : undefined)
    if (!jobId) this.error('Pass a JobExecution Id or --promotion <id>')

    const diagnosis = await diagnoseJob(this.runner, jobId, this.diagnoseOptions(flags))
    const plan = planFixes(diagnosis)
    this.log(renderDiagnosis(diagnosis, plan))

    if (!flags.apply) {
      this.log('\nDry run. Re-run with --apply to execute the 🔍/✏️  steps above.')
      return {applied: false, steps: plan.map((step) => ({step, status: 'planned'}))}
    }
    if (flags.json && !flags.yes && plan.some((s) => s.effect === 'write'))
      this.error('--apply with --json cannot prompt; add --yes to confirm changes non-interactively')

    const rl = flags.yes ? undefined : createInterface({input: process.stdin, output: process.stdout})
    const results: StepResult[] = []
    try {
      for (const step of plan) {
        if (!step.command || step.effect === 'manual') {
          results.push({step, status: 'skipped'})
          continue
        }
        if (step.effect === 'write' && rl) {
          const answer = await rl.question(`\n${step.title}\n  $ ${renderCommand(step.command)}\nRun this? [y/N] `)
          if (!/^y(es)?$/i.test(answer.trim())) {
            results.push({step, status: 'skipped'})
            this.log('Stopped: later steps depend on this one.')
            break
          }
        }
        try {
          const output = await this.runner.run(step.command)
          results.push({step, status: 'ran', output})
          this.log(`✔ ${step.title}`)
        } catch (err) {
          results.push({step, status: 'failed', error: (err as Error).message})
          this.log(`✖ ${step.title}: ${(err as Error).message}`)
          break
        }
      }
    } finally {
      rl?.close()
    }
    return {applied: true, steps: results}
  }
}
