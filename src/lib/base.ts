import {Command, Flags} from '@oclif/core'

import {type AgentiaRunner, CliRunner} from './agentia.js'
import type {DiagnoseOptions} from './diagnose.js'

/** Shared plumbing for every `agentia doctor` command. */
export abstract class DoctorCommand extends Command {
  static enableJsonFlag = true

  static contextFlags = {
    'pipeline-id': Flags.string({description: 'Pipeline Id, used to look up metadata dependencies as evidence'}),
    'source-org-id': Flags.string({description: 'Source org Id for dependency evidence'}),
    'target-org-id': Flags.string({description: 'Destination org Id; with it, dependencies are diffed against the destination'}),
    'source-credential-id': Flags.string({description: 'Source credential Id (alternative to --source-org-id)'}),
    ai: Flags.boolean({description: 'Ask a Copado AI agent about errors no rule recognises', default: false}),
    'ai-agent': Flags.string({description: 'Copado AI agent to ask', options: ['release', 'operate', 'build', 'test', 'knowledge', 'plan'], default: 'release'}),
  }

  private _runner?: AgentiaRunner

  /** Tests swap this for a fixture runner. */
  get runner(): AgentiaRunner {
    this._runner ??= new CliRunner({agentiaRoot: this.config.root})
    return this._runner
  }

  set runner(r: AgentiaRunner) {
    this._runner = r
  }

  protected diagnoseOptions(flags: Record<string, unknown>): DiagnoseOptions {
    return {
      pipelineId: flags['pipeline-id'] as string | undefined,
      sourceOrgId: flags['source-org-id'] as string | undefined,
      targetOrgId: flags['target-org-id'] as string | undefined,
      sourceCredentialId: flags['source-credential-id'] as string | undefined,
      promotionId: flags.promotion as string | undefined,
      ai: flags.ai as boolean | undefined,
      aiAgent: flags['ai-agent'] as string | undefined,
    }
  }
}
