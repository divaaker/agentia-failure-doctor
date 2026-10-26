import type {AgentiaRunner} from './agentia.js'
import {isResolved, list, pick, str} from './normalize.js'

/**
 * Catch the most common promotion failure before it happens: a story's
 * component depends on something the destination does not have, and the
 * story does not bring it either.
 */
export interface PreflightOptions {
  pipelineId: string
  sourceOrgId?: string
  sourceCredentialId?: string
  targetOrgId: string
  /** Also block on unresolved conflicts of this promotion. */
  promotionId?: string
}

export interface PreflightIssue {
  severity: 'block' | 'warn'
  check: 'dependency' | 'conflict' | 'error'
  component?: string
  missing?: string
  message: string
  fix?: string
}

export interface PreflightResult {
  work: string
  components: string[]
  checked: number
  ok: boolean
  issues: PreflightIssue[]
}

const name = (r: unknown) =>
  [str(pick(r, 'type', 'metadataType', 'componentType')), str(pick(r, 'name', 'apiName', 'fullName', 'metadataName'))].filter(Boolean).join(':')

/** Copado feature branches are named after the story: feature/US-0001234. */
export const workFromBranch = (branch: string): string | undefined => branch.match(/\b(US-\d{3,})\b/i)?.[1].toUpperCase()

export async function resolveWork(runner: AgentiaRunner, idOrName: string): Promise<{id: string; name: string}> {
  if (!/^US-\d+$/i.test(idOrName)) return {id: idOrName, name: idOrName}
  const hit = list(await runner.run(['cicd', 'work', 'list', '--name', idOrName, '--page-size', '5']))[0]
  const id = str(pick(hit, 'id'))
  if (!id) throw new Error(`No user story named ${idOrName}`)
  return {id, name: str(pick(hit, 'name')) ?? idOrName}
}

export async function preflight(runner: AgentiaRunner, work: {id: string; name: string}, o: PreflightOptions): Promise<PreflightResult> {
  const status = await runner.run(['cicd', 'work', 'status', work.id, '--metadata-list-only'])
  const raw = pick(status, 'metadata', 'metadataList', 'components', 'selections')
  const components = (Array.isArray(raw) ? raw : list(status)).map(name).filter(Boolean)
  const inStory = new Set(components.map((c) => c.toLowerCase()))
  const issues: PreflightIssue[] = []

  for (const comp of components) {
    const [type, cname] = comp.split(':')
    const args = ['cicd', 'metadata', 'dependency', 'list', '--pipeline-id', o.pipelineId, '--metadata-type', type, '--metadata-name', cname]
    if (o.sourceOrgId) args.push('--source-org-id', o.sourceOrgId)
    if (o.sourceCredentialId) args.push('--source-credential-id', o.sourceCredentialId)
    args.push('--target-org-id', o.targetOrgId, '--retrieve-mode', 'diff_only')
    try {
      for (const dep of list(await runner.run(args)).map(name)) {
        if (inStory.has(dep.toLowerCase())) continue
        issues.push({
          severity: 'block',
          check: 'dependency',
          component: comp,
          missing: dep,
          message: `${comp} needs ${dep}, which is not in the destination and not in ${work.name}`,
          fix: `Add ${dep} to ${work.name}, or promote the story that owns it first`,
        })
      }
    } catch (err) {
      issues.push({severity: 'warn', check: 'error', component: comp, message: `Dependency check failed: ${(err as Error).message}`})
    }
  }

  if (o.promotionId) {
    try {
      const open = list(await runner.run(['cicd', 'promotion', 'conflict', 'list', '-p', o.promotionId])).filter(
        (c) => !isResolved(str(pick(c, 'status', 'resolution'))),
      )
      for (const c of open)
        issues.push({
          severity: 'block',
          check: 'conflict',
          component: str(pick(c, 'file', 'path', 'fileName')),
          message: `Unresolved conflict ${str(pick(c, 'id'))} on promotion ${o.promotionId}`,
          fix: `agentia cicd promotion conflict get ${str(pick(c, 'id'))} -p ${o.promotionId}`,
        })
    } catch (err) {
      issues.push({severity: 'warn', check: 'error', message: `Conflict check failed: ${(err as Error).message}`})
    }
  }

  return {work: work.name, components, checked: components.length, ok: !issues.some((i) => i.severity === 'block'), issues}
}

export function renderPreflight(r: PreflightResult): string {
  const out = [`Preflight ${r.work}: ${r.checked} component(s) checked against the destination`]
  for (const i of r.issues) {
    out.push(`  ${i.severity === 'block' ? '✖ BLOCK' : '! WARN '}  ${i.message}`)
    if (i.fix) out.push(`           fix: ${i.fix}`)
  }
  out.push(r.ok ? '✔ Safe to promote.' : `✖ ${r.issues.filter((i) => i.severity === 'block').length} blocker(s). This promotion would fail; fix them first.`)
  return out.join('\n')
}

export const PRE_PUSH_HOOK = `#!/bin/sh
# Installed by \`agentia doctor preflight --install-hook\`.
# Blocks a push when the story's components depend on metadata the next environment lacks.
# Set DOCTOR_PIPELINE_ID, DOCTOR_SOURCE_ORG_ID and DOCTOR_TARGET_ORG_ID (or pass flags).
branch=$(git rev-parse --abbrev-ref HEAD)
case "$branch" in
  feature/US-*) exec agentia doctor preflight --from-branch "$branch" ;;
  *) exit 0 ;;
esac
`
