import {describe, expect, it} from 'vitest'

import {diagnoseJob, latestJobForParent} from '../src/lib/diagnose.js'
import {computeDora} from '../src/lib/dora.js'
import {planFixes} from '../src/lib/fix.js'
import {normalizeJob} from '../src/lib/normalize.js'
import {renderDiagnosis} from '../src/lib/report.js'
import {FakeRunner} from './helpers.js'

const failedDeploy = {
  id: 'a4N000000000001AAA',
  name: 'JE-000101',
  status: 'Error',
  copado__JobTemplate__c: 'SFDX Deploy',
  copado__ParentId__c: 'a0B000000000001AAA',
  steps: [
    {id: 'a4O000000000001AAA', name: 'Validate', copado__Order__c: 1, status: 'Success', resultId: 'a4P1'},
    {id: 'a4O000000000002AAA', name: 'Deploy', copado__Order__c: 2, status: 'Failed', resultId: 'a4P2'},
  ],
}

const deployLog = {
  log: [
    'Deploying 14 components to UAT',
    'Error  ApexClass  InvoiceBatch  Dependent class is invalid and needs recompilation: InvoiceService (1:1)',
    'Error  ApexClass  InvoiceService  Variable does not exist: Tax_Rate__c (42:9)',
    'Error  ApexClass  InvoiceController  Dependent class is invalid and needs recompilation: InvoiceService (3:1)',
    'Average test coverage across all Apex Classes and Triggers is 0%, at least 75% test coverage is required.',
  ].join('\n'),
}

describe('diagnoseJob', () => {
  it('ranks the missing dependency above cascading symptoms', async () => {
    const runner = new FakeRunner({
      'cicd job get a4N000000000001AAA': failedDeploy,
      'cicd job log get a4N000000000001AAA --step a4O000000000002AAA': deployLog,
    })
    const d = await diagnoseJob(runner, 'a4N000000000001AAA')
    expect(d.failedSteps.map((s) => s.name)).toEqual(['Deploy'])
    expect(d.rootCause?.signature.id).toBe('SF-MISSING-APEX-SYMBOL')
    expect(d.rootCause?.entity?.name).toBe('Tax_Rate__c')
    expect(d.rootCause?.components).toEqual(['ApexClass:InvoiceService'])
    expect(d.findings.map((f) => f.signature.id)).toEqual(['SF-MISSING-APEX-SYMBOL', 'SF-COVERAGE', 'SF-DEPENDENT-INVALID'])
    expect(d.notes.join(' ')).toMatch(/--pipeline-id/)
  })

  it('adds dependency evidence when pipeline context is given', async () => {
    const runner = new FakeRunner({
      'cicd job get': failedDeploy,
      'cicd job log get': deployLog,
      'cicd metadata dependency list': {records: [{type: 'CustomField', name: 'Invoice__c.Tax_Rate__c'}, {type: 'ApexClass', name: 'TaxUtil'}]},
    })
    const d = await diagnoseJob(runner, 'a4N000000000001AAA', {pipelineId: 'PIPE', sourceOrgId: 'SRC', targetOrgId: 'TGT'})
    const call = runner.calls.find((c) => c[2] === 'dependency')!
    expect(call).toEqual(expect.arrayContaining(['--metadata-type', 'ApexClass', '--metadata-name', 'InvoiceService', '--retrieve-mode', 'diff_only']))
    expect(d.evidence[0].summary).toMatch(/depends on CustomField:Invoice__c.Tax_Rate__c, which is missing/)
    expect(d.confidence).toBe('high')
  })

  it('resolves conflicts and plans a resume of the same execution', async () => {
    const runner = new FakeRunner({
      'cicd job get': {...failedDeploy, steps: [{id: 'S1', name: 'Merge', status: 'Error'}]},
      'cicd job log get': 'CONFLICT (content): Merge conflict in force-app/main/default/classes/A.cls\nAutomatic merge failed',
      'cicd promotion conflict list -p a0B000000000001AAA': [{id: 'C1', file: 'classes/A.cls', status: 'Open'}],
    })
    const d = await diagnoseJob(runner, 'a4N000000000001AAA')
    expect(d.rootCause?.signature.category).toBe('merge-conflict')
    const plan = planFixes(d)
    expect(plan.map((s) => s.effect)).toEqual(['read', 'write', 'write'])
    expect(plan.at(-1)?.command).toEqual(['cicd', 'promotion', 'run', 'a0B000000000001AAA', '--resume', 'a4N000000000001AAA'])
  })

  it('keeps going and says so when a log cannot be read', async () => {
    const runner = new FakeRunner({'cicd job get': {...failedDeploy, errorMessage: 'Error: invalid_grant: expired access/refresh token'}})
    const d = await diagnoseJob(runner, 'a4N000000000001AAA')
    expect(d.notes[0]).toMatch(/Could not read the log/)
    expect(d.rootCause?.signature.id).toBe('ENV-CREDENTIAL')
    expect(renderDiagnosis(d, planFixes(d))).toMatch(/Environment credential expired/)
  })

  it('asks the AI agent only for unknown errors', async () => {
    const runner = new FakeRunner({
      'cicd job get': failedDeploy,
      'cicd job log get': 'Error: Something nobody has seen before happened',
      'ai agent ask': {answer: 'Likely cause: X. Fix: Y.'},
    })
    const d = await diagnoseJob(runner, 'a4N000000000001AAA', {ai: true})
    const ask = runner.calls.find((c) => c[0] === 'ai')!
    expect(ask.slice(0, 3)).toEqual(['ai', 'agent', 'ask'])
    expect(ask).toEqual(expect.arrayContaining(['--agent', 'release']))
    expect(d.evidence).toEqual([{kind: 'ai', summary: 'Likely cause: X. Fix: Y.'}])
    expect(d.confidence).toBe('medium')
  })

  it('finds the latest failed execution for a promotion', async () => {
    const runner = new FakeRunner({
      'cicd job list --parent P1': {
        records: [
          {id: 'OLD', status: 'Error', createdDate: '2026-10-01T10:00:00Z'},
          {id: 'NEW', status: 'Error', createdDate: '2026-10-02T10:00:00Z'},
          {id: 'OK', status: 'Successful', createdDate: '2026-10-03T10:00:00Z'},
        ],
      },
    })
    expect(await latestJobForParent(runner, 'P1')).toBe('NEW')
  })
})

describe('computeDora', () => {
  const job = (id: string, status: string, at: string, parent = 'P1') =>
    normalizeJob({id, status, type: 'Promotion Deploy', parentId: parent, createdDate: at})

  it('computes failure rate and recovery time per lane', () => {
    const r = computeDora([
      job('1', 'Successful', '2026-10-01T00:00:00Z'),
      job('2', 'Error', '2026-10-02T00:00:00Z'),
      job('3', 'Error', '2026-10-02T02:00:00Z'),
      job('4', 'Successful', '2026-10-02T06:00:00Z'),
      job('5', 'Error', '2026-10-03T00:00:00Z', 'P2'),
    ])
    expect(r.deployments).toBe(5)
    expect(r.changeFailureRate).toBe(0.6)
    expect(r.meanTimeToRecoveryHours).toBe(6)
    expect(r.recoveries).toBe(1)
    expect(r.unrecovered).toBe(1)
  })
})
