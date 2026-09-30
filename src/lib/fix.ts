import type {Diagnosis} from './diagnose.js'

export interface FixStep {
  title: string
  why: string
  /** Agentia argv (without the `agentia` prefix and `--json`). */
  command?: string[]
  /** `read` never changes anything; `write` changes Copado state and needs confirmation. */
  effect: 'read' | 'write' | 'manual'
}

const q = (s: string) => (/[\s"'$]/.test(s) ? JSON.stringify(s) : s)
export const renderCommand = (argv: string[]) => ['agentia', ...argv.map(q)].join(' ')

/**
 * Turn a diagnosis into an ordered, reviewable plan. The Doctor never runs a
 * `write` step without explicit confirmation (see `doctor fix --apply`).
 */
export function planFixes(d: Diagnosis): FixStep[] {
  const root = d.rootCause
  if (!root) {
    return [
      {
        title: 'Read the full job log',
        why: 'No error lines were recognised in the failed step logs.',
        command: ['cicd', 'job', 'log', 'get', d.job.id],
        effect: 'read',
      },
    ]
  }
  const steps: FixStep[] = []
  const promotion = d.job.parentId
  const entity = [root.entity?.type, root.entity?.name].filter(Boolean).join(' ')

  switch (root.signature.fix) {
    case 'add-dependency-to-story': {
      steps.push({
        title: `Find where ${entity || 'the missing component'} lives`,
        why:
          'The destination is missing something this story depends on. Locate the story that committed it ' +
          `(e.g. \`agentia cicd metadata list --filter-type ${root.entity?.type ?? '<type>'} --source PreviouslyCommitted --pipeline-id <id> --source-org-id <id>\`), or confirm nobody committed it.`,
        effect: 'manual',
      })
      steps.push({
        title: 'Promote the owning story first, or add the component to this story',
        why: 'Either order the stories so the dependency lands first, or commit it alongside this change (then re-promote).',
        effect: 'manual',
      })
      break
    }
    case 'resolve-conflict': {
      const conflicts = (d.evidence.find((e) => e.kind === 'conflicts')?.detail as Array<{id?: string; status?: string}>) ?? []
      const open = conflicts.filter((c) => c.id && !/resolved/i.test(c.status ?? ''))
      for (const c of open) {
        steps.push({title: `Review conflict ${c.id}`, why: 'Read the conflicting content before choosing a resolution.', command: ['cicd', 'promotion', 'conflict', 'get', c.id!, '-p', promotion!], effect: 'read'})
        steps.push({title: `Auto-resolve conflict ${c.id}`, why: 'Let Copado apply its automatic resolution. Use --mode manual --file <path> instead for reviewed content.', command: ['cicd', 'promotion', 'conflict', 'resolve', c.id!, '-p', promotion!, '--mode', 'auto'], effect: 'write'})
      }
      if (promotion)
        steps.push({title: 'Resume the same promotion execution', why: 'After conflicts are resolved, resume rather than start a new run.', command: ['cicd', 'promotion', 'run', promotion, '--resume', d.job.id], effect: 'write'})
      break
    }
    case 'reauth-credential':
      steps.push({title: 'Find the failing environment credential', why: 'The job could not log into the org; the change itself is fine.', command: ['cicd', 'credential', 'list'], effect: 'read'})
      steps.push({title: 'Re-authenticate it in the browser', why: 'Run `agentia cicd environment auth web login <environment-id>` for the environment above (browser-only).', effect: 'manual'})
      steps.push({title: 'Resume the job', why: 'Outstanding steps pick up from where they stopped.', command: ['cicd', 'job', 'resume', d.job.id], effect: 'write'})
      break
    case 'resume-job':
      steps.push({title: 'Resume the job', why: 'The failure was transient. Resuming re-runs only the outstanding steps.', command: ['cicd', 'job', 'resume', d.job.id], effect: 'write'})
      break
    case 'fix-tests': {
      const classes = [...new Set(d.findings.filter((f) => f.signature.category === 'test-failure').flatMap((f) => f.components.map((c) => c.split(':')[1])))]
      steps.push({
        title: 'Reproduce the failing tests locally',
        why: 'Run exactly the failing classes against your org before recommitting.',
        command: classes.length ? ['cicd', 'work', 'test', 'apex', '-t', classes.join(',')] : undefined,
        effect: classes.length ? 'read' : 'manual',
      })
      steps.push({title: 'Fix, recommit and re-validate', why: 'Then `agentia cicd work submit` re-runs the quality gates on the story.', effect: 'manual'})
      break
    }
    default:
      steps.push({title: root.signature.title, why: root.signature.explain, effect: 'manual'})
  }
  return steps
}
