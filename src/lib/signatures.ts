import type {DeployError} from './extract.js'

export type Category =
  | 'missing-dependency'
  | 'compile'
  | 'test-failure'
  | 'coverage'
  | 'access'
  | 'merge-conflict'
  | 'destructive-change'
  | 'org-limit'
  | 'active-version'
  | 'credential'
  | 'transient'
  | 'data'
  | 'unknown'

/** What the Doctor can do about a finding. Maps to concrete Agentia commands in fix.ts. */
export type FixKind =
  | 'add-dependency-to-story'
  | 'resolve-conflict'
  | 'reauth-credential'
  | 'resume-job'
  | 'fix-tests'
  | 'manual'

export interface Signature {
  id: string
  title: string
  category: Category
  /** Lower runs first as root cause. Cascading symptoms get higher numbers. */
  rank: number
  match: RegExp
  /** Pull the missing / offending entity out of the message, if the rule can. */
  entity?: (m: RegExpMatchArray, e: DeployError) => {type?: string; name?: string} | undefined
  explain: string
  fix: FixKind
  /** Worth looking up the entity's dependencies between source and destination. */
  checkDependencies?: boolean
}

const field = (obj: string | undefined, f: string | undefined) => ({
  type: 'CustomField',
  name: obj && f ? `${obj}.${f}` : f,
})

export const SIGNATURES: Signature[] = [
  {
    id: 'SF-MISSING-REFERENCE',
    title: 'Referenced metadata is missing in the destination',
    category: 'missing-dependency',
    rank: 10,
    match: /In field: (\w+) - no (\w+) named ([\w.\-_]+) found/i,
    entity: (m) => ({type: m[2], name: m[3]}),
    explain:
      'A component points at another component that does not exist in the destination org. Usually the referenced item lives in a different user story that has not been promoted yet, or was never committed.',
    fix: 'add-dependency-to-story',
    checkDependencies: true,
  },
  {
    id: 'SF-MISSING-FIELD',
    title: 'Field does not exist in the destination',
    category: 'missing-dependency',
    rank: 10,
    match:
      /No such column '(\w+)' on entity '(\w+)'|Invalid field (\w+) for (?:SObject )?(\w+)|Field (\w+(?:__c)?) does not exist\. Check spelling|Invalid field: '?(\w+)\.(\w+)'?/i,
    entity: (m) =>
      m[1] ? field(m[2], m[1]) : m[3] ? field(m[4], m[3]) : m[5] ? field(undefined, m[5]) : field(m[6], m[7]),
    explain:
      'Code or configuration references a field that is not in the destination. The field is probably in another story, or its deploy was skipped.',
    fix: 'add-dependency-to-story',
    checkDependencies: true,
  },
  {
    id: 'SF-MISSING-OBJECT',
    title: 'Object is not available in the destination',
    category: 'missing-dependency',
    rank: 10,
    match: /sObject type '(\w+)' is not supported|Entity is not org-accessible|Invalid sObject type[: ]+'?(\w+)|Cannot find entity '?(\w+)/i,
    entity: (m) => ({type: 'CustomObject', name: m[1] ?? m[2] ?? m[3]}),
    explain: 'An object is referenced that the destination org does not have, or the deploying user cannot see.',
    fix: 'add-dependency-to-story',
    checkDependencies: true,
  },
  {
    id: 'SF-MISSING-APEX-SYMBOL',
    title: 'Apex references a class, method or variable that is missing',
    category: 'missing-dependency',
    rank: 20,
    match: /Invalid type: ([\w.]+)|Variable does not exist: ([\w.]+)|Method does not exist or incorrect signature: (?:void )?([\w.]+)|Class ([\w.]+) must implement/i,
    entity: (m) => {
      if (m[1] || m[4]) return {type: 'ApexClass', name: m[1] ?? m[4]}
      const name = m[2] ?? m[3]
      // `Foo__c` is a field; a bare identifier could be a variable, method or field, so leave the type open.
      return {type: /__c$/i.test(name) ? 'CustomField' : undefined, name}
    },
    explain:
      'Apex compiled against something the destination does not have. Either a class in another story, or a field/variable change that did not travel with this story.',
    fix: 'add-dependency-to-story',
    checkDependencies: true,
  },
  {
    id: 'SF-DEPENDENT-INVALID',
    title: 'Dependent class is invalid (cascade)',
    category: 'compile',
    rank: 60,
    match: /Dependent class is invalid and needs recompilation:?\s*([\w.]*)/i,
    entity: (m) => (m[1] ? {type: 'ApexClass', name: m[1].split('.')[0]} : undefined),
    explain:
      'A symptom, not a cause: another class in the same deploy failed to compile and everything that depends on it now fails too. Fix the first compile error and these clear.',
    fix: 'manual',
  },
  {
    id: 'SF-APEX-COMPILE',
    title: 'Apex compile error',
    category: 'compile',
    rank: 30,
    match: /Compile Error|unexpected token|Missing ';'|Illegal assignment|Unexpected token|expecting a/i,
    explain: 'The code itself does not compile. Fix it in the feature branch and recommit.',
    fix: 'manual',
  },
  {
    id: 'SF-TEST-ASSERT',
    title: 'Apex test assertion failed',
    category: 'test-failure',
    rank: 40,
    match: /System\.AssertException|Assertion ?Failed/i,
    explain:
      'A test ran and its assertion failed. Either the change broke behaviour, or the test depends on data or configuration that differs in this environment.',
    fix: 'fix-tests',
  },
  {
    id: 'SF-TEST-EXCEPTION',
    title: 'Apex test threw an unhandled exception',
    category: 'test-failure',
    rank: 40,
    match: /System\.(NullPointerException|DmlException|QueryException|ListException|LimitException|TypeException)/i,
    explain:
      'A test crashed. DmlException in tests usually means a validation rule, required field or trigger in the destination rejects the test data.',
    fix: 'fix-tests',
  },
  {
    id: 'SF-COVERAGE',
    title: 'Code coverage below the required 75%',
    category: 'coverage',
    rank: 50,
    match: /at least 75% test coverage|Code coverage is insufficient|code coverage (?:of|is) (\d+)%|Average test coverage .* is (\d+)%/i,
    explain:
      'Coverage is below the org threshold. If tests also failed, fix those first: failed tests contribute no coverage.',
    fix: 'fix-tests',
  },
  {
    id: 'SF-ACCESS',
    title: 'Insufficient access for the deploying user or test data',
    category: 'access',
    rank: 25,
    match: /insufficient access rights|INSUFFICIENT_ACCESS|You do not have access to|FIELD_INTEGRITY_EXCEPTION.*(?:permission|access)/i,
    explain:
      'The deploying credential or running user cannot touch a record, field or setting. Check the Copado environment credential and the permission sets it carries.',
    fix: 'manual',
  },
  {
    id: 'GIT-MERGE-CONFLICT',
    title: 'Git merge conflict on the promotion branch',
    category: 'merge-conflict',
    rank: 5,
    match: /CONFLICT \((content|modify\/delete|add\/add)\)|merge conflict|Automatic merge failed/i,
    explain:
      'Two stories changed the same file. Copado stops the promotion until each conflict is resolved, then the same execution can resume.',
    fix: 'resolve-conflict',
  },
  {
    id: 'SF-DESTRUCTIVE-REFERENCED',
    title: 'Deletion blocked: component is still referenced',
    category: 'destructive-change',
    rank: 15,
    match: /is referenced elsewhere in salesforce\.com|cannot be deleted|Cannot delete .* (?:referenced|in use)|This (\w+) is referenced/i,
    explain:
      'A destructive change tries to remove something that other metadata still uses. Remove the references first (or deploy them in the same promotion), then delete.',
    fix: 'manual',
  },
  {
    id: 'SF-PICKLIST-LIMIT',
    title: 'Picklist value limit reached',
    category: 'org-limit',
    rank: 15,
    match: /maximum number of (?:picklist )?values|Picklist .* (?:1000|limit)/i,
    explain:
      'The 1,000-value limit counts inactive values too, and the failing number is the combined set from the branch and the destination. Remove unused values only after checking who added them.',
    fix: 'manual',
  },
  {
    id: 'SF-FLOW-ACTIVE-VERSION',
    title: 'Active Flow version cannot be overwritten',
    category: 'active-version',
    rank: 15,
    match: /version of the flow .*(?:active|can'?t be overwritten)|cannot (?:overwrite|modify) (?:an )?active (?:flow )?version/i,
    explain:
      'The destination has this Flow version active. Deploy as a new version, or deactivate in the destination first (with approval).',
    fix: 'manual',
  },
  {
    id: 'SF-API-VERSION',
    title: 'Metadata not supported at this API version',
    category: 'compile',
    rank: 15,
    match: /not available in API version|Not available for deploy for this API version|Unknown type name/i,
    explain: 'Component or field is newer than the API version used for the deploy. Align sourceApiVersion with the destination org.',
    fix: 'manual',
  },
  {
    id: 'SF-DUPLICATE-VALUE',
    title: 'Duplicate value in the destination',
    category: 'data',
    rank: 35,
    match: /DUPLICATE_VALUE|duplicate value found|DUPLICATE_DEVELOPER_NAME/i,
    explain: 'A record or developer name that must be unique already exists in the destination.',
    fix: 'manual',
  },
  {
    id: 'ENV-CREDENTIAL',
    title: 'Environment credential expired or invalid',
    category: 'credential',
    rank: 1,
    match: /INVALID_SESSION_ID|invalid_grant|expired access\/refresh token|Authentication failed|INVALID_LOGIN|Session expired/i,
    explain:
      'Copado could not log into the environment. Nothing in the story is wrong: re-authenticate the credential, then resume the job.',
    fix: 'reauth-credential',
  },
  {
    id: 'SF-TRANSIENT',
    title: 'Transient platform error',
    category: 'transient',
    rank: 70,
    match: /UNABLE_TO_LOCK_ROW|Request timed out|ECONNRESET|503 Service Unavailable|Deployment queued too long|server was unavailable/i,
    explain: 'Locking or platform availability, not the change itself. Resume the job; if it repeats, look for a long-running process in the destination.',
    fix: 'resume-job',
  },
]

export interface Classified {
  signature: Signature
  error: DeployError
  entity?: {type?: string; name?: string}
}

export const UNKNOWN: Signature = {
  id: 'UNKNOWN',
  title: 'Unrecognised error',
  category: 'unknown',
  rank: 80,
  match: /.^/,
  explain: 'No rule matched this error. Run with --ai to ask a Copado AI agent, then record the answer with `doctor learn`.',
  fix: 'manual',
}

export function classify(e: DeployError, rules: Signature[] = SIGNATURES): Classified {
  for (const s of rules) {
    const m = e.message.match(s.match) ?? e.raw.match(s.match)
    if (m) return {signature: s, error: e, entity: s.entity?.(m, e)}
  }
  return {signature: UNKNOWN, error: e}
}

/**
 * Stable fingerprint for "the same failure" across runs: rule + entity, with
 * Salesforce Ids, numbers and quoted literals masked for unknown errors.
 */
export function fingerprint(c: Classified): string {
  if (c.signature !== UNKNOWN) return `${c.signature.id}:${c.entity?.name ?? c.error.component ?? '*'}`
  const masked = c.error.message
    .replace(/\b[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?\b/g, (s) => (/\d/.test(s) && /[a-z]/i.test(s) ? '<ID>' : s))
    .replace(/'[^']*'|"[^"]*"/g, '<STR>')
    .replace(/\d+/g, '<N>')
    .slice(0, 120)
  return `UNKNOWN:${masked}`
}
