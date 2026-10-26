import {Command, Flags} from '@oclif/core'

import {type AgentiaRunner, CliRunner} from './agentia.js'
import {DEMO, DemoRunner} from './demo.js'
import type {DiagnoseOptions} from './diagnose.js'

/** Shared plumbing for every `agentia doctor` command. */
export abstract class DoctorCommand extends Command {
  static enableJsonFlag = true

  static baseFlags = {
    demo: Flags.boolean({description: 'Run against the built-in synthetic Copado pipeline (no org or API key needed)', env: 'AGENTIA_DOCTOR_DEMO', default: false}),
  }

  static contextFlags = {
    'pipeline-id': Flags.string({description: 'Pipeline Id, used to look up metadata dependencies as evidence', env: 'DOCTOR_PIPELINE_ID'}),
    'source-org-id': Flags.string({description: 'Source org Id for dependency evidence', env: 'DOCTOR_SOURCE_ORG_ID'}),
    'target-org-id': Flags.string({description: 'Destination org Id; with it, dependencies are diffed against the destination', env: 'DOCTOR_TARGET_ORG_ID'}),
    'source-credential-id': Flags.string({description: 'Source credential Id (alternative to --source-org-id)', env: 'DOCTOR_SOURCE_CREDENTIAL_ID'}),
    ai: Flags.boolean({description: 'Ask a Copado AI agent about errors no rule recognises', default: false}),
    'ai-agent': Flags.string({description: 'Copado AI agent to ask', options: ['release', 'operate', 'build', 'test', 'knowledge', 'plan'], default: 'release'}),
  }

  private _runner?: AgentiaRunner

  /** Tests swap this for a fixture runner. */
  get runner(): AgentiaRunner {
    this._runner ??= this.demo ? new DemoRunner() : new CliRunner({agentiaRoot: this.config.root})
    return this._runner
  }

  set runner(r: AgentiaRunner) {
    this._runner = r
  }

  /** `--demo` or AGENTIA_DOCTOR_DEMO=1 swaps the real gateway for the synthetic pipeline. */
  protected get demo(): boolean {
    return this.argv.includes('--demo') || /^(1|true)$/i.test(process.env.AGENTIA_DOCTOR_DEMO ?? '')
  }

  protected diagnoseOptions(flags: Record<string, unknown>): DiagnoseOptions {
    const demo = this.demo ? DEMO : undefined
    return {
      pipelineId: (flags['pipeline-id'] as string | undefined) ?? demo?.pipelineId,
      sourceOrgId: (flags['source-org-id'] as string | undefined) ?? demo?.devOrgId,
      targetOrgId: (flags['target-org-id'] as string | undefined) ?? demo?.uatOrgId,
      sourceCredentialId: flags['source-credential-id'] as string | undefined,
      promotionId: flags.promotion as string | undefined,
      ai: flags.ai as boolean | undefined,
      aiAgent: flags['ai-agent'] as string | undefined,
    }
  }
}
