import {expect, it} from 'vitest'

import {diagnoseJob} from '../src/lib/diagnose.js'
import {planFixes} from '../src/lib/fix.js'
import {renderDiagnosis} from '../src/lib/report.js'
import {FakeRunner} from './helpers.js'

it('renders the README example', async () => {
  const runner = new FakeRunner({
    'cicd job get': {
      id: 'a4N5g000000XXXXEAA', name: 'JE-000101', status: 'Error', type: 'SFDX Deploy', parentId: 'a0B5g000000XXXXEAA',
      steps: [{id: 'S1', name: 'Validate', order: 1, status: 'Success'}, {id: 'S2', name: 'Deploy', order: 2, status: 'Failed'}],
    },
    'cicd job log get': [
      'Error  ApexClass  InvoiceBatch  Dependent class is invalid and needs recompilation: InvoiceService (1:1)',
      'Error  ApexClass  InvoiceService  Variable does not exist: Tax_Rate__c (42:9)',
      'Error  ApexClass  InvoiceController  Dependent class is invalid and needs recompilation: InvoiceService (3:1)',
      'Average test coverage across all Apex Classes and Triggers is 0%, at least 75% test coverage is required.',
    ].join('\n'),
    'cicd metadata dependency list': [{type: 'CustomField', name: 'Invoice__c.Tax_Rate__c'}],
  })
  const d = await diagnoseJob(runner, 'a4N5g000000XXXXEAA', {pipelineId: 'P', sourceOrgId: 'S', targetOrgId: 'T'})
  const out = renderDiagnosis(d, planFixes(d))
  if (process.env.PRINT) console.log(out)
  expect(out).toMatch(/missing\/offending: CustomField Tax_Rate__c/)
  expect(out).toMatch(/depends on CustomField:Invoice__c.Tax_Rate__c, which is missing from the destination/)
})
