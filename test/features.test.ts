import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {DEMO, DemoRunner} from '../src/lib/demo.js'
import {diagnoseJob} from '../src/lib/diagnose.js'
import {slackDigest} from '../src/lib/digest.js'
import {extractErrors} from '../src/lib/extract.js'
import {planFixes} from '../src/lib/fix.js'
import {allRules, learn, patternFrom} from '../src/lib/library.js'
import {preflight, resolveWork, workFromBranch} from '../src/lib/preflight.js'
import {redact} from '../src/lib/redact.js'
import {doraFromHistory, scanFailures} from '../src/lib/scan.js'
import {FakeRunner} from './helpers.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'doctor-test-'))
const demo = () => {
  const path = join(tmp(), 'state.json')
  DemoRunner.reset(path)
  return new DemoRunner(path)
}
const ctx = {pipelineId: DEMO.pipelineId, sourceOrgId: DEMO.devOrgId, targetOrgId: DEMO.uatOrgId}

describe('redact', () => {
  it('masks session ids, tokens, auth urls and webhooks', () => {
    const out = redact(
      'access_token=00DDEMO00000UATAAA!AQ8AQabcdefghijklmnopqrstuvwxyz force://PlatformCLI::5Aep861abc@acme.my.salesforce.com ' +
        'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123 https://hooks.slack.com/services/T000/B000/XXXX',
    )
    expect(out).not.toMatch(/AQ8AQ|5Aep861|abcdefghijklmnopqrstuvwxyz0123|T000\/B000/)
    expect(out).toMatch(/access_token=<redacted>/)
  })

  it('keeps secrets out of a diagnosis', async () => {
    const d = await diagnoseJob(demo(), 'JE-000101', {rules: undefined})
    expect(JSON.stringify(d)).not.toMatch(/FakeSessionToken/)
  })
})

describe('extract', () => {
  it('treats any sf table error row as an error, even with an unfamiliar message', () => {
    const [e] = extractErrors('Error  CustomApplication  Acme_Console  Console apps require a licence (0:0)\nDeploying 3 components')
    expect(e).toMatchObject({componentType: 'CustomApplication', component: 'Acme_Console'})
  })
})

describe('demo pipeline', () => {
  it('scans recurring failures and computes DORA', async () => {
    const r = demo()
    const scan = await scanFailures(r, {limit: 20})
    expect(scan.groups[0].jobs.length).toBeGreaterThan(1)
    const dora = await doraFromHistory(r)
    expect(dora.deployments).toBeGreaterThan(40)
    expect(dora.changeFailureRate).toBeGreaterThan(0)
    expect(dora.meanTimeToRecoveryHours).toBeGreaterThan(0)
  })

  it('fixes a merge conflict end to end: resolve both, resume, job succeeds', async () => {
    const r = demo()
    const before = await diagnoseJob(r, 'JE-000102', ctx)
    expect(before.rootCause?.signature.id).toBe('GIT-MERGE-CONFLICT')
    expect(before.evidence[0].summary).toMatch(/^2 unresolved of 2/)
    for (const s of planFixes(before)) if (s.command) await r.run(s.command)
    const after = await diagnoseJob(r, 'JE-000102', ctx)
    expect(after.job.status).toBe('Success')
  })

  it('refuses to resume a promotion with open conflicts', async () => {
    const r = demo()
    await expect(r.run(['cicd', 'promotion', 'run', 'a0B000000000102AAA', '--resume', 'a4N000000000102AAA'])).rejects.toThrow(/unresolved/)
  })
})

describe('preflight', () => {
  it('blocks a story whose components need metadata the destination lacks', async () => {
    const r = demo()
    const res = await preflight(r, await resolveWork(r, 'US-0000105'), ctx)
    expect(res.ok).toBe(false)
    expect(res.issues.map((i) => i.missing)).toEqual(['CustomField:Opportunity.Discount_Pct__c', 'CustomMetadata:Discount_Tier__mdt.Gold'])
  })

  it('does not block on dependencies the story brings itself', async () => {
    const r = demo()
    const res = await preflight(r, await resolveWork(r, 'US-0000107'), ctx)
    expect(res).toMatchObject({ok: true, issues: []})
  })

  it('blocks on unresolved promotion conflicts', async () => {
    const r = new FakeRunner({
      'cicd work status': {metadata: []},
      'cicd promotion conflict list': {records: [{id: 'C1', status: 'Unresolved', file: 'a.xml'}, {id: 'C2', status: 'Resolved (auto)'}]},
    })
    const res = await preflight(r, {id: 'W', name: 'US-1'}, {...ctx, promotionId: 'P'})
    expect(res.issues).toHaveLength(1)
    expect(res.issues[0]).toMatchObject({check: 'conflict', severity: 'block'})
  })

  it('reads the story from a Copado feature branch', () => {
    expect(workFromBranch('feature/US-0001234')).toBe('US-0001234')
    expect(workFromBranch('main')).toBeUndefined()
  })
})

describe('learn', () => {
  it('turns an unrecognised failure into a team rule that matches next time', async () => {
    const lib = join(tmp(), 'signatures.json')
    const r = demo()
    const before = await diagnoseJob(r, 'JE-000106', {rules: await allRules(lib)})
    expect(before.rootCause?.signature.id).toBe('UNKNOWN')
    const sig = await learn(before, {title: 'Console app needs Service Cloud licence', explain: 'Give the user the licence.', category: 'access'}, lib)
    const after = await diagnoseJob(r, 'JE-000106', {rules: await allRules(lib)})
    expect(after.rootCause?.signature.id).toBe(sig.id)
    expect(after.confidence).toBe('high')
  })

  it('generalises ids, numbers and quoted literals', () => {
    const re = new RegExp(patternFrom("Record a4N000000000101AAA failed after 3 tries on 'Foo'"))
    expect(re.test("Record a4N000000000999BBB failed after 12 tries on 'Bar'")).toBe(true)
  })
})

describe('slack digest', () => {
  it('builds Block Kit with DORA numbers and top root causes', async () => {
    const r = demo()
    const p = slackDigest(await scanFailures(r), await doraFromHistory(r))
    expect(p.text).toMatch(/CFR \d+%/)
    expect(JSON.stringify(p.blocks)).toMatch(/Top root causes/)
  })
})
