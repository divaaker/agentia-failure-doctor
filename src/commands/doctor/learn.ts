import {Args, Flags} from '@oclif/core'
import {relative} from 'node:path'

import {DoctorCommand} from '../../lib/base.js'
import {diagnoseJob} from '../../lib/diagnose.js'
import {learn, libraryPath} from '../../lib/library.js'
import type {Category, FixKind} from '../../lib/signatures.js'

const CATEGORIES: Category[] = ['missing-dependency', 'compile', 'test-failure', 'coverage', 'access', 'merge-conflict', 'destructive-change', 'org-limit', 'active-version', 'credential', 'transient', 'data', 'unknown']
const FIXES: FixKind[] = ['add-dependency-to-story', 'resolve-conflict', 'reauth-credential', 'resume-job', 'fix-tests', 'manual']

export default class DoctorLearn extends DoctorCommand {
  static summary = "Save a confirmed diagnosis to the team's signature library"
  static description =
    "Turns the unrecognised error of a failed job into a new local rule in .agentia-doctor/signatures.json (commit it to share with the team). Next time the same failure appears anywhere, diagnose recognises it instantly, without AI. With --from-ai the explanation is the Copado AI agent's answer."
  static examples = [
    '<%= config.bin %> doctor learn a4N... --title "Console app needs Service Cloud licence" --explain "Give the deploying user the Service Cloud User licence, then resume."',
    '<%= config.bin %> doctor learn a4N... --title "Console app needs Service Cloud licence" --from-ai --category access',
  ]
  static args = {id: Args.string({description: 'JobExecution Id of the failure to learn from', required: true})}
  static flags = {
    title: Flags.string({description: 'Short name of the failure', required: true}),
    explain: Flags.string({description: 'Cause and fix, as the team agreed it'}),
    'from-ai': Flags.boolean({description: "Use a Copado AI agent's diagnosis as the explanation", default: false}),
    category: Flags.string({description: 'Failure category', options: CATEGORIES, default: 'data'}),
    fix: Flags.string({description: 'Fix kind the plan should use', options: FIXES, default: 'manual'}),
    match: Flags.string({description: 'Regex to match instead of the generalised error text'}),
    'ai-agent': Flags.string({description: 'Copado AI agent to ask', options: ['release', 'operate', 'build', 'test', 'knowledge', 'plan'], default: 'release'}),
  }

  async run() {
    const {args, flags} = await this.parse(DoctorLearn)
    if (!flags.explain && !flags['from-ai']) this.error('Pass --explain "<cause and fix>" or --from-ai')
    const d = await diagnoseJob(this.runner, args.id, {ai: flags['from-ai'], aiAgent: flags['ai-agent']})
    const explain = flags.explain ?? d.evidence.find((e) => e.kind === 'ai')?.summary
    if (!explain) this.error('The AI agent gave no answer; pass --explain instead')
    const sig = await learn(d, {title: flags.title, explain, category: flags.category as Category, fix: flags.fix as FixKind, match: flags.match})
    this.log(`✔ Learned ${sig.id}: ${sig.title}\n  match: /${sig.match}/${sig.flags}\n  saved: ${relative(process.cwd(), libraryPath()) || libraryPath()}\nCommit it so the whole team gets the rule.`)
    return sig
  }
}
