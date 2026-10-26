import {existsSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {AgentiaError, type AgentiaRunner} from './agentia.js'
import {isResolved} from './normalize.js'

/**
 * A synthetic Copado pipeline (dev → UAT → prod) that answers the same Agentia
 * commands the real gateway does, so the Doctor can be tried and demoed
 * without a Copado org. Every Id, name and log line here is invented.
 *
 * State (resolved conflicts, resumed jobs) persists in a temp file between
 * commands, so `fix --apply` really changes what the next `diagnose` sees.
 * `agentia doctor demo --reset` starts over.
 */

export const DEMO = {
  pipelineId: 'a1PDEMO00000001AAA',
  devOrgId: '00DDEMO00000DEVAAA',
  uatOrgId: '00DDEMO00000UATAAA',
}

const id = (prefix: string, n: number) => `${prefix}${String(n).padStart(12, '0')}AAA`
const jobId = (n: number) => id('a4N', n)
const promoId = (n: number) => id('a0B', n)

interface DemoJob {
  id: string
  name: string
  status: string
  type: string
  parentId: string
  destinationEnvironment: string
  createdDate: string
  endDate: string
  steps: Array<{id: string; name: string; order: number; status: string; resultId?: string}>
  logs?: Record<string, string>
}

interface DemoConflict {
  id: string
  file: string
  status: string
  promotion: string
}

interface State {
  jobs: DemoJob[]
  conflicts: DemoConflict[]
}

const steps = (n: number, failedAt?: 'Validate' | 'Merge' | 'Deploy' | 'Run Tests') =>
  ['Merge', 'Validate', 'Deploy', 'Run Tests'].map((name, i) => {
    const failIdx = failedAt ? ['Merge', 'Validate', 'Deploy', 'Run Tests'].indexOf(failedAt) : 99
    return {
      id: id('a4O', n * 10 + i),
      name,
      order: i + 1,
      status: i < failIdx ? 'Success' : i === failIdx ? 'Failed' : 'Not Started',
      resultId: i <= failIdx ? id('a4P', n * 10 + i) : undefined,
    }
  })

const LOGS = {
  missingDep: [
    'Deploying 14 components to UAT (checkOnly=false, testLevel=RunLocalTests)',
    'Error  ApexClass  InvoiceBatch  Dependent class is invalid and needs recompilation: InvoiceService (1:1)',
    'Error  ApexClass  InvoiceService  Variable does not exist: Tax_Rate__c (42:9)',
    'Error  ApexClass  InvoiceController  Dependent class is invalid and needs recompilation: InvoiceService (3:1)',
    'Average test coverage across all Apex Classes and Triggers is 0%, at least 75% test coverage is required.',
    'Deploy failed: 3 component errors. Auth: access_token=00DDEMO00000UATAAA!AQ8AQFakeSessionTokenForTheDemoOnly0123456789',
  ].join('\n'),
  conflict: [
    'git merge origin/feature/US-0000102 into promotion/P-0000102-uat',
    'Auto-merging force-app/main/default/layouts/Account-Account Layout.layout-meta.xml',
    'CONFLICT (content): Merge conflict in force-app/main/default/layouts/Account-Account Layout.layout-meta.xml',
    'Auto-merging force-app/main/default/permissionsets/Sales_Ops.permissionset-meta.xml',
    'CONFLICT (content): Merge conflict in force-app/main/default/permissionsets/Sales_Ops.permissionset-meta.xml',
    'Automatic merge failed; fix conflicts and then commit the result.',
  ].join('\n'),
  credential: 'Error  Org  UAT  INVALID_SESSION_ID: Session expired or invalid (refresh token revoked for credential "UAT Integration")',
  test: [
    'Running 38 tests in UAT',
    'DiscountServiceTest.appliesTieredDiscount: System.AssertException: Assertion Failed: Expected: 15, Actual: 10',
    'DiscountServiceTest.capsDiscountAtMax: System.NullPointerException: Attempt to de-reference a null object',
    'Run Tests: 36 passed, 2 failed',
  ].join('\n'),
  transient: 'Error  CustomObject  Invoice__c  UNABLE_TO_LOCK_ROW: unable to obtain exclusive access to this record or 200 records',
  unknown: 'Error  CustomApplication  Acme_Service_Console  Console apps require the Service Cloud User feature license on the deploying user (0:0)',
}

/** ~6 weeks of history: mostly green, with the failure patterns a real team sees. */
function seed(): State {
  const jobs: DemoJob[] = []
  const now = Date.UTC(2026, 9, 26, 9, 0)
  const H = 3_600_000
  const lanes = [
    {promo: 200, dest: 'UAT', type: 'Promotion Deploy'},
    {promo: 300, dest: 'Production', type: 'Promotion Deploy'},
    {promo: 400, dest: 'UAT', type: 'SFDX Validate'},
  ]
  const pattern: Array<keyof typeof LOGS | 'ok'> = ['ok', 'ok', 'missingDep', 'ok', 'ok', 'test', 'ok', 'ok', 'transient', 'ok', 'ok', 'missingDep', 'ok', 'credential', 'ok', 'ok']
  let n = 1000
  for (let day = 42; day >= 1; day--) {
    for (const [li, lane] of lanes.entries()) {
      if ((day + li) % 2) continue
      const kind = pattern[(day * 3 + li) % pattern.length]
      const start = now - day * 24 * H + li * 2 * H
      n++
      const failStep = kind === 'ok' ? undefined : kind === 'test' ? 'Run Tests' : 'Deploy'
      jobs.push({
        id: jobId(n),
        name: `JE-${String(n).padStart(6, '0')}`,
        status: kind === 'ok' ? 'Success' : 'Error',
        type: lane.type,
        parentId: promoId(lane.promo + (kind === 'ok' ? 0 : day)),
        destinationEnvironment: lane.dest,
        createdDate: new Date(start).toISOString(),
        endDate: new Date(start + 0.4 * H).toISOString(),
        steps: steps(n, failStep),
        logs: kind === 'ok' ? undefined : {[id('a4O', n * 10 + (failStep === 'Run Tests' ? 3 : 2))]: LOGS[kind]},
      })
      if (kind !== 'ok') {
        // The fix lands a few hours later on the same promotion.
        n++
        jobs.push({
          id: jobId(n),
          name: `JE-${String(n).padStart(6, '0')}`,
          status: 'Success',
          type: lane.type,
          parentId: promoId(lane.promo + day),
          destinationEnvironment: lane.dest,
          createdDate: new Date(start + (3 + (day % 5)) * H).toISOString(),
          endDate: new Date(start + (3.5 + (day % 5)) * H).toISOString(),
          steps: steps(n),
        })
      }
    }
  }

  // Today's open failures, the ones the demo walks through.
  const today = (h: number) => new Date(now + h * H).toISOString()
  const live: Array<[number, string, keyof typeof LOGS, 'Merge' | 'Deploy' | 'Run Tests', string]> = [
    [101, 'Promotion Deploy', 'missingDep', 'Deploy', 'UAT'],
    [102, 'Promotion Deploy', 'conflict', 'Merge', 'UAT'],
    [103, 'Promotion Deploy', 'credential', 'Deploy', 'UAT'],
    [104, 'Promotion Deploy', 'test', 'Run Tests', 'UAT'],
    [106, 'Promotion Deploy', 'unknown', 'Deploy', 'UAT'],
  ]
  for (const [k, type, kind, failStep, dest] of live) {
    const s = steps(k, failStep)
    jobs.push({
      id: jobId(k),
      name: `JE-${String(k).padStart(6, '0')}`,
      status: 'Error',
      type,
      parentId: promoId(k),
      destinationEnvironment: dest,
      createdDate: today(k - 100),
      endDate: today(k - 100 + 0.3),
      steps: s,
      logs: {[s.find((x) => x.status === 'Failed')!.id]: LOGS[kind]},
    })
  }
  const conflicts: DemoConflict[] = [
    {id: 'a0CDEMO0000000001AA', file: 'force-app/main/default/layouts/Account-Account Layout.layout-meta.xml', status: 'Unresolved', promotion: promoId(102)},
    {id: 'a0CDEMO0000000002AA', file: 'force-app/main/default/permissionsets/Sales_Ops.permissionset-meta.xml', status: 'Unresolved', promotion: promoId(102)},
  ]
  return {jobs, conflicts}
}

/** What each user story commits, and what each component needs. */
const STORIES: Record<string, {id: string; title: string; metadata: Array<{type: string; name: string}>}> = {
  'US-0000101': {id: id('a0U', 101), title: 'Invoice tax rates', metadata: [{type: 'ApexClass', name: 'InvoiceService'}, {type: 'ApexClass', name: 'InvoiceBatch'}]},
  'US-0000105': {
    id: id('a0U', 105),
    title: 'Discount approvals',
    metadata: [
      {type: 'Flow', name: 'Discount_Approval'},
      {type: 'ApexClass', name: 'DiscountService'},
      {type: 'CustomField', name: 'Opportunity.Approval_Status__c'},
    ],
  },
  'US-0000107': {id: id('a0U', 107), title: 'Case escalation email', metadata: [{type: 'EmailTemplate', name: 'Support/Case_Escalated'}, {type: 'Flow', name: 'Case_Escalation'}]},
}

/** Dependencies of each component that are NOT in the UAT org (diff_only). */
const MISSING_IN_UAT: Record<string, Array<{type: string; name: string}>> = {
  'ApexClass:InvoiceService': [{type: 'CustomField', name: 'Invoice__c.Tax_Rate__c'}],
  'Flow:Discount_Approval': [
    {type: 'CustomField', name: 'Opportunity.Discount_Pct__c'},
    {type: 'CustomField', name: 'Opportunity.Approval_Status__c'},
  ],
  'ApexClass:DiscountService': [{type: 'CustomMetadata', name: 'Discount_Tier__mdt.Gold'}],
  'Flow:Case_Escalation': [{type: 'EmailTemplate', name: 'Support/Case_Escalated'}],
}

export const demoStatePath = () => join(tmpdir(), 'agentia-doctor-demo-state.json')

export class DemoRunner implements AgentiaRunner {
  private state: State

  constructor(private readonly path = demoStatePath()) {
    this.state = existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as State) : seed()
  }

  static reset(path = demoStatePath()) {
    writeFileSync(path, JSON.stringify(seed()))
  }

  private save() {
    writeFileSync(this.path, JSON.stringify(this.state))
  }

  private job(jid: string) {
    const j = this.state.jobs.find((x) => x.id === jid || x.name === jid)
    if (!j) throw new AgentiaError(`Job execution ${jid} not found`, 'cicd job get')
    return j
  }

  async run<T>(args: string[]): Promise<T> {
    const flag = (f: string) => {
      const i = args.indexOf(f)
      return i >= 0 ? args[i + 1] : undefined
    }
    const cmd = args.filter((a, i) => !a.startsWith('-') && !(i > 0 && args[i - 1].startsWith('-'))).slice(0, 4).join(' ')
    const pos = (i: number) => args.filter((a, k) => !a.startsWith('-') && !(k > 0 && args[k - 1].startsWith('-')))[i]
    const out = (v: unknown) => v as T

    if (cmd.startsWith('cicd job get')) {
      const {logs: _logs, ...j} = this.job(pos(3))
      return out(j)
    }
    if (cmd.startsWith('cicd job log get')) {
      const j = this.job(pos(4))
      const step = flag('--step') ?? j.steps.find((s) => s.resultId)?.id
      return out({log: (step && j.logs?.[step]) ?? `Step ${step} completed.`})
    }
    if (cmd.startsWith('cicd job list')) {
      let jobs = [...this.state.jobs].sort((a, b) => b.createdDate.localeCompare(a.createdDate))
      const status = flag('--status')
      if (status) jobs = jobs.filter((j) => j.status === status)
      const type = flag('--type')
      if (type) jobs = jobs.filter((j) => j.type.toLowerCase().includes(type.toLowerCase()))
      const parent = flag('--parent')
      if (parent) jobs = jobs.filter((j) => j.parentId === parent)
      const size = Number(flag('--page-size') ?? 50)
      const from = Number(flag('--cursor') ?? 0)
      const page = jobs.slice(from, from + size).map(({logs: _l, steps: _s, ...j}) => j)
      return out({records: page, nextCursor: from + size < jobs.length ? String(from + size) : undefined})
    }
    if (cmd.startsWith('cicd job resume')) {
      const j = this.job(pos(3))
      if (j.name === 'JE-000103') throw new AgentiaError('INVALID_SESSION_ID: re-authenticate the UAT credential first', 'cicd job resume')
      this.finish(j)
      return out({id: j.id, status: j.status})
    }
    if (cmd.startsWith('cicd promotion conflict list')) {
      return out({records: this.state.conflicts.filter((c) => c.promotion === flag('-p'))})
    }
    if (cmd.startsWith('cicd promotion conflict get')) {
      const c = this.state.conflicts.find((x) => x.id === pos(4))
      return out({...c, content: '<<<<<<< ours\n    <field>Score__c</field>\n=======\n    <field>Tier__c</field>\n>>>>>>> theirs'})
    }
    if (cmd.startsWith('cicd promotion conflict resolve')) {
      const c = this.state.conflicts.find((x) => x.id === pos(4))
      if (!c) throw new AgentiaError(`Conflict ${pos(4)} not found`, 'cicd promotion conflict resolve')
      c.status = 'Resolved (auto)'
      this.save()
      return out(c)
    }
    if (cmd.startsWith('cicd promotion run')) {
      const promo = pos(3)
      const open = this.state.conflicts.filter((c) => c.promotion === promo && !isResolved(c.status))
      if (open.length) throw new AgentiaError(`${open.length} unresolved conflict(s) on promotion ${promo}`, 'cicd promotion run')
      const j = this.job(flag('--resume') ?? '')
      this.finish(j)
      return out({promotionId: promo, jobExecutionId: j.id, status: j.status})
    }
    if (cmd.startsWith('cicd metadata dependency list')) {
      const key = `${flag('--metadata-type')}:${flag('--metadata-name')}`
      return out({records: MISSING_IN_UAT[key] ?? []})
    }
    if (cmd.startsWith('cicd credential list')) {
      return out({records: [{id: 'a0JDEMO0000000UATAA', name: 'UAT Integration', status: 'Expired'}, {id: 'a0JDEMO0000000PRDAA', name: 'Production', status: 'Valid'}]})
    }
    if (cmd.startsWith('cicd work list')) {
      const name = flag('--name') ?? ''
      const s = STORIES[name.toUpperCase()]
      return out({records: s ? [{id: s.id, name: name.toUpperCase(), title: s.title}] : []})
    }
    if (cmd.startsWith('cicd work status')) {
      const s = Object.values(STORIES).find((x) => x.id === pos(3))
      if (!s) throw new AgentiaError(`User story ${pos(3)} not found`, 'cicd work status')
      return out({metadata: s.metadata})
    }
    if (cmd.startsWith('ai agent ask')) {
      return out({
        answer:
          'Root cause: the deploying user has no Service Cloud User feature licence, so Salesforce rejects console apps (CustomApplication with a console navigation). ' +
          'Fix: tick "Service Cloud User" on the integration user the UAT credential logs in as (Setup → Users), then resume the job. No metadata change is needed.',
      })
    }
    throw new AgentiaError(`demo pipeline has no answer for: agentia ${args.join(' ')}`, cmd)
  }

  private finish(j: DemoJob) {
    j.status = 'Success'
    j.endDate = new Date().toISOString()
    for (const s of j.steps) s.status = 'Success'
    j.logs = undefined
    this.save()
  }
}
