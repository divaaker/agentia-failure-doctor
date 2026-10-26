import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js'
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js'
import {z} from 'zod'

import {DoctorCommand} from '../../lib/base.js'
import {diagnoseJob, latestJobForParent} from '../../lib/diagnose.js'
import {planFixes} from '../../lib/fix.js'
import {renderDiagnosis} from '../../lib/report.js'
import {doraFromHistory, scanFailures} from '../../lib/scan.js'
import {allRules} from '../../lib/library.js'
import {preflight, renderPreflight, resolveWork} from '../../lib/preflight.js'

const context = {
  jobId: z.string().optional().describe('Copado JobExecution Id'),
  promotionId: z.string().optional().describe('Promotion Id; its latest failed execution is used when jobId is omitted'),
  pipelineId: z.string().optional().describe('Pipeline Id, enables dependency evidence'),
  sourceOrgId: z.string().optional(),
  targetOrgId: z.string().optional(),
  ai: z.boolean().optional().describe('Ask a Copado AI agent about errors no rule recognises'),
}

const text = (t: string, data: unknown) => ({
  content: [
    {type: 'text' as const, text: t},
    {type: 'text' as const, text: JSON.stringify(data, null, 2)},
  ],
})

export default class DoctorMcp extends DoctorCommand {
  static summary = 'Start the Failure Doctor MCP server over stdio'
  static description =
    'Exposes diagnose, plan-fix, scan, dora and signatures as read-only MCP tools. The Doctor never changes Copado over MCP: the fix plan names the Agentia commands (or Agentia MCP tools) to run after the user confirms.'
  static enableJsonFlag = false

  async run(): Promise<void> {
    const runner = this.runner
    const server = new McpServer({name: 'agentia-doctor', version: this.config.plugins.get('agentia-plugin-doctor')?.version ?? '0.1.0'})

    const resolveJob = async (a: {jobId?: string; promotionId?: string}) => {
      const id = a.jobId ?? (a.promotionId ? await latestJobForParent(runner, a.promotionId) : undefined)
      if (!id) throw new Error('Provide jobId, or a promotionId that has job executions')
      return id
    }

    server.registerTool(
      'doctor_diagnose',
      {
        title: 'Diagnose a failed Copado job',
        description:
          'Root cause, evidence, confidence and next steps for a failed Copado job execution or promotion. Read-only. Call this first whenever a user asks why a deployment/promotion failed.',
        inputSchema: context,
        annotations: {readOnlyHint: true},
      },
      async (a) => {
        const d = await diagnoseJob(runner, await resolveJob(a), {...a, promotionId: a.promotionId})
        const plan = planFixes(d)
        return text(renderDiagnosis(d, plan), {diagnosis: d, plan})
      },
    )

    server.registerTool(
      'doctor_plan_fix',
      {
        title: 'Plan the fix for a failed Copado job',
        description:
          'Ordered fix plan. Each step is read (safe), write (changes Copado: show it to the user and get explicit confirmation before running it with the matching Agentia command or Agentia MCP tool) or manual. Never run write steps without confirmation.',
        inputSchema: context,
        annotations: {readOnlyHint: true},
      },
      async (a) => {
        const plan = planFixes(await diagnoseJob(runner, await resolveJob(a), a))
        return text(plan.map((s, i) => `${i + 1}. [${s.effect}] ${s.title}${s.command ? `\n   agentia ${s.command.join(' ')}` : ''}`).join('\n'), plan)
      },
    )

    server.registerTool(
      'doctor_scan',
      {
        title: 'Group recent Copado failures by root cause',
        description: 'Diagnoses recent failed job executions and groups them by root-cause fingerprint, most frequent first. Read-only.',
        inputSchema: {
          status: z.string().optional().describe('Job status meaning failed (default Error)'),
          type: z.string().optional().describe('Contains match on Job Template name'),
          limit: z.number().int().min(1).max(200).optional(),
        },
        annotations: {readOnlyHint: true},
      },
      async (a) => {
        const r = await scanFailures(runner, a)
        return text(r.groups.map((g) => `${g.jobs.length} × ${g.title} [${g.category}]`).join('\n') || 'No failed jobs found.', r)
      },
    )

    server.registerTool(
      'doctor_dora',
      {
        title: 'DORA metrics from Copado job history',
        description: 'Deployment frequency, change failure rate and mean time to recovery computed from Copado job executions. Read-only.',
        inputSchema: {type: z.string().optional(), maxJobs: z.number().int().min(1).optional()},
        annotations: {readOnlyHint: true},
      },
      async (a) => {
        const r = await doraFromHistory(runner, a)
        return text(`CFR ${Math.round(r.changeFailureRate * 100)}%, MTTR ${r.meanTimeToRecoveryHours ?? 'n/a'} h, ${r.deploymentsPerDay}/day`, r)
      },
    )

    server.registerTool(
      'doctor_signatures',
      {
        title: 'List known failure signatures',
        description: 'The rules the Doctor uses to recognise Salesforce/Copado failures.',
        inputSchema: {},
        annotations: {readOnlyHint: true},
      },
      async () => {
        const rows = (await allRules()).map((s) => ({id: s.id, category: s.category, title: s.title, fix: s.fix}))
        return text(rows.map((r) => `${r.id}: ${r.title}`).join('\n'), rows)
      },
    )

    server.registerTool(
      'doctor_preflight',
      {
        title: 'Preflight a user story before promotion',
        description:
          "Checks that everything the story's components depend on is already in the destination or in the story itself, and (with promotionId) that no conflicts are open. Returns ok=false with the blockers when the promotion would fail. Read-only.",
        inputSchema: {
          work: z.string().describe('User story Id or name, e.g. US-0001234'),
          pipelineId: z.string(),
          sourceOrgId: z.string(),
          targetOrgId: z.string(),
          promotionId: z.string().optional(),
        },
        annotations: {readOnlyHint: true},
      },
      async (a) => {
        const r = await preflight(runner, await resolveWork(runner, a.work), a)
        return text(renderPreflight(r), r)
      },
    )

    await server.connect(new StdioServerTransport())
    // Stay alive until the client disconnects.
    await new Promise<void>((resolve) => process.stdin.on('close', resolve))
  }
}
