import {Args, Flags} from '@oclif/core'
import {execSync} from 'node:child_process'
import {chmod, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import {DoctorCommand} from '../../lib/base.js'
import {PRE_PUSH_HOOK, preflight, type PreflightResult, renderPreflight, resolveWork, workFromBranch} from '../../lib/preflight.js'

export default class DoctorPreflight extends DoctorCommand {
  static summary = 'Check a user story before promotion, so known failures never reach the pipeline'
  static description =
    "Reads the story's committed metadata, asks Copado for each component's dependencies that the destination is missing, and blocks when the story does not bring them. With --promotion it also blocks on unresolved conflicts. Exits 1 when blocked, so it works as a Git pre-push hook, a CI step or a Local Quality Gate. Read-only."
  static examples = [
    '<%= config.bin %> doctor preflight US-0001234 --pipeline-id a1P... --source-org-id 00D... --target-org-id 00D...',
    '<%= config.bin %> doctor preflight --from-branch feature/US-0001234',
    '<%= config.bin %> doctor preflight --install-hook',
  ]
  static args = {work: Args.string({description: 'User story Id or name (US-0001234)'})}
  static flags = {
    'from-branch': Flags.string({description: 'Take the story from a Copado feature branch name (feature/US-0001234)'}),
    promotion: Flags.string({char: 'p', description: 'Also block on unresolved conflicts of this promotion'}),
    'install-hook': Flags.boolean({description: 'Install a Git pre-push hook that runs preflight on feature/US-* branches', default: false}),
    ...DoctorCommand.contextFlags,
  }

  async run(): Promise<PreflightResult | {hook: string}> {
    const {args, flags} = await this.parse(DoctorPreflight)
    if (flags['install-hook']) {
      const gitDir = execSync('git rev-parse --git-dir', {encoding: 'utf8'}).trim()
      const hook = join(gitDir, 'hooks', 'pre-push')
      await writeFile(hook, PRE_PUSH_HOOK)
      await chmod(hook, 0o755)
      this.log(`✔ ${hook}\nSet DOCTOR_PIPELINE_ID, DOCTOR_SOURCE_ORG_ID and DOCTOR_TARGET_ORG_ID for it.`)
      return {hook}
    }

    const ref = args.work ?? (flags['from-branch'] ? workFromBranch(flags['from-branch']) : undefined)
    if (!ref) this.error('Pass a user story (US-0001234) or --from-branch feature/US-0001234')
    const o = this.diagnoseOptions(flags)
    if (!o.pipelineId || !o.targetOrgId || !(o.sourceOrgId || o.sourceCredentialId))
      this.error('preflight needs --pipeline-id, --source-org-id (or --source-credential-id) and --target-org-id (or DOCTOR_* env vars)')

    const work = await resolveWork(this.runner, ref)
    const result = await preflight(this.runner, work, {
      pipelineId: o.pipelineId,
      sourceOrgId: o.sourceOrgId,
      sourceCredentialId: o.sourceCredentialId,
      targetOrgId: o.targetOrgId,
      promotionId: flags.promotion,
    })
    this.log(renderPreflight(result))
    if (!result.ok) process.exitCode = 1
    return result
  }
}
