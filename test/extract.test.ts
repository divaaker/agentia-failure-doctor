import {describe, expect, it} from 'vitest'

import {extractErrors} from '../src/lib/extract.js'
import {classify, fingerprint} from '../src/lib/signatures.js'

const one = (line: string) => {
  const [e] = extractErrors(line)
  return {e, c: classify(e)}
}

describe('extractErrors', () => {
  it('reads Metadata API componentFailures JSON', () => {
    const log = `deploy result: {"componentFailures":[{"componentType":"ApexClass","fullName":"InvoiceService","problem":"Variable does not exist: Tax_Rate__c","lineNumber":42}]}`
    const [e] = extractErrors(log)
    expect(e).toMatchObject({componentType: 'ApexClass', component: 'InvoiceService', line: 42, message: 'Variable does not exist: Tax_Rate__c'})
  })

  it('reads sf CLI table rows', () => {
    const {e} = one('Error  ApexClass  InvoiceService  Variable does not exist: Tax_Rate__c (42:9)')
    expect(e).toMatchObject({componentType: 'ApexClass', component: 'InvoiceService', line: 42})
  })

  it('reads source-path errors', () => {
    const {e} = one('force-app/main/default/classes/InvoiceService.cls:42:9 - Invalid type: TaxCalculator')
    expect(e).toMatchObject({componentType: 'ApexClass', component: 'InvoiceService', line: 42, message: 'Invalid type: TaxCalculator'})
  })

  it('reads "Type Name: line n" errors', () => {
    const {e} = one('ApexTrigger OrderTrigger: line 7, column 3: Method does not exist or incorrect signature: void sync(Id)')
    expect(e).toMatchObject({componentType: 'ApexTrigger', component: 'OrderTrigger', line: 7})
  })

  it('flags test failures', () => {
    const {e, c} = one('InvoiceServiceTest.calculatesTax: System.AssertException: Assertion Failed: Expected: 10, Actual: 0')
    expect(e.test).toBe(true)
    expect(e.component).toBe('InvoiceServiceTest')
    expect(c.signature.id).toBe('SF-TEST-ASSERT')
  })

  it('dedupes the same error seen as JSON and as text', () => {
    const log = [
      `{"componentFailures":[{"componentType":"ApexClass","fullName":"A","problem":"Invalid type: B"}]}`,
      'ApexClass A: Invalid type: B',
    ].join('\n')
    expect(extractErrors(log)).toHaveLength(1)
  })

  it('ignores ordinary log lines', () => {
    expect(extractErrors('Deploying 12 components\nRetrieving metadata\nDone in 3s')).toEqual([])
  })
})

describe('classify', () => {
  it.each([
    ["In field: field - no CustomField named Invoice__c.Tax_Rate__c found", 'SF-MISSING-REFERENCE', 'Invoice__c.Tax_Rate__c'],
    ["No such column 'Tax_Rate__c' on entity 'Invoice__c'", 'SF-MISSING-FIELD', 'Invoice__c.Tax_Rate__c'],
    ["sObject type 'Shipment__c' is not supported.", 'SF-MISSING-OBJECT', 'Shipment__c'],
    ['Invalid type: TaxCalculator', 'SF-MISSING-APEX-SYMBOL', 'TaxCalculator'],
    ['Dependent class is invalid and needs recompilation: InvoiceBatch', 'SF-DEPENDENT-INVALID', 'InvoiceBatch'],
    ['Average test coverage across all Apex Classes and Triggers is 61%, at least 75% test coverage is required.', 'SF-COVERAGE', undefined],
    ['CONFLICT (content): Merge conflict in force-app/main/default/classes/A.cls', 'GIT-MERGE-CONFLICT', undefined],
    ['Error: invalid_grant: expired access/refresh token', 'ENV-CREDENTIAL', undefined],
    ['UNABLE_TO_LOCK_ROW: unable to obtain exclusive access to this record', 'SF-TRANSIENT', undefined],
    ['This Custom Field is referenced elsewhere in salesforce.com.', 'SF-DESTRUCTIVE-REFERENCED', undefined],
  ])('%s → %s', (message, id, entity) => {
    const c = classify({message, raw: message})
    expect(c.signature.id).toBe(id)
    if (entity) expect(c.entity?.name).toBe(entity)
  })

  it('prefers the real cause inside a cascade message', () => {
    const msg = 'Dependent class is invalid and needs recompilation: Class InvoiceService : Variable does not exist: Tax_Rate__c'
    expect(classify({message: msg, raw: msg}).signature.id).toBe('SF-MISSING-APEX-SYMBOL')
  })

  it('fingerprints unknown errors with ids and numbers masked', () => {
    const a = classify({message: "Weird failure on a0B5g00000ABCDEFGH at 12", raw: ''})
    const b = classify({message: "Weird failure on a0B5g00000ZYXWVUTS at 99", raw: ''})
    expect(fingerprint(a)).toBe(fingerprint(b))
  })
})
