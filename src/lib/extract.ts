/**
 * Pull individual Salesforce deploy / test errors out of raw job log text.
 *
 * Copado logs mix several formats, depending on the job template and engine:
 *   1. Metadata API JSON:   {"componentFailures":[{"componentType":"ApexClass","fullName":"X","problem":"..."}]}
 *   2. sf CLI table rows:   Error  ApexClass  X  Variable does not exist: y (12:5)
 *   3. Colon-prefixed:      ApexClass X: line 12, column 5: Variable does not exist: y
 *   4. Path-prefixed:       force-app/main/default/classes/X.cls:12:5 - Variable does not exist: y
 *   5. Test results:        XTest.itWorks: System.AssertException: Assertion Failed ...
 *   6. Free text:           any line containing a known error marker
 */

export interface DeployError {
  componentType?: string
  component?: string
  message: string
  line?: number
  /** True when the error came from a test run rather than compile/deploy. */
  test?: boolean
  raw: string
}

const TYPE_BY_DIR: Record<string, string> = {
  classes: 'ApexClass',
  triggers: 'ApexTrigger',
  objects: 'CustomObject',
  fields: 'CustomField',
  flows: 'Flow',
  lwc: 'LightningComponentBundle',
  aura: 'AuraDefinitionBundle',
  layouts: 'Layout',
  permissionsets: 'PermissionSet',
  profiles: 'Profile',
  pages: 'ApexPage',
  components: 'ApexComponent',
  flexipages: 'FlexiPage',
  validationRules: 'ValidationRule',
  recordTypes: 'RecordType',
  customMetadata: 'CustomMetadata',
  labels: 'CustomLabels',
}

const METADATA_TYPES =
  'ApexClass|ApexTrigger|ApexPage|ApexComponent|CustomObject|CustomField|Flow|FlowDefinition|Layout|PermissionSet|Profile|' +
  'LightningComponentBundle|AuraDefinitionBundle|FlexiPage|ValidationRule|RecordType|CustomMetadata|CustomLabels|' +
  'CustomTab|Workflow|EmailTemplate|Report|Dashboard|StaticResource|QuickAction|ListView|CompactLayout|Queue|Group|' +
  'CustomApplication|PermissionSetGroup|GlobalValueSet|StandardValueSet|SharingRules|AssignmentRules|NamedCredential'

const ERROR_MARKERS =
  /(does not exist|Invalid type|Invalid field|No such column|not found|is invalid|Dependent class|Compile Error|Assertion ?Failed|System\.\w+Exception|coverage|INVALID_|FIELD_INTEGRITY|DUPLICATE_VALUE|UNABLE_TO_LOCK_ROW|insufficient access|CONFLICT \(|merge conflict|invalid_grant|expired access|Authentication failed|is referenced|cannot be deleted|can't be overwritten|not available in API version|maximum number of|Cannot find|Unknown user|Error:)/i

const clean = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '').trim()

function fromJson(text: string, out: DeployError[]) {
  const re = /\{[^{}]*"(?:problem|componentFailures)"[\s\S]*?\}(?:\s*\]\s*\})?/g
  for (const m of text.matchAll(re)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(m[0])
    } catch {
      continue
    }
    const rows = (parsed as {componentFailures?: unknown}).componentFailures
    const items = Array.isArray(rows) ? rows : [parsed]
    for (const r of items as Record<string, unknown>[]) {
      if (typeof r?.problem !== 'string') continue
      out.push({
        componentType: typeof r.componentType === 'string' ? r.componentType : undefined,
        component: typeof r.fullName === 'string' ? r.fullName : undefined,
        message: r.problem,
        line: typeof r.lineNumber === 'number' ? r.lineNumber : Number(r.lineNumber) || undefined,
        raw: JSON.stringify(r),
      })
    }
  }
}

const PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => Omit<DeployError, 'raw'>]> = [
  // Error  ApexClass  Foo  Variable does not exist: bar (12:5)
  [
    new RegExp(`^(?:│\\s*)?Error\\s+(${METADATA_TYPES})\\s+(\\S+)\\s+(.+?)(?:\\s*\\((\\d+):\\d+\\))?\\s*(?:│)?$`),
    (m) => ({componentType: m[1], component: m[2], message: m[3], line: m[4] ? Number(m[4]) : undefined}),
  ],
  // ApexClass Foo: line 12, column 5: Variable does not exist: bar
  [
    new RegExp(`(${METADATA_TYPES})\\s+([\\w.\\-/]+):\\s*(?:line (\\d+), column \\d+:\\s*)?(.+)$`),
    (m) => ({componentType: m[1], component: m[2], line: m[3] ? Number(m[3]) : undefined, message: m[4]}),
  ],
  // force-app/main/default/classes/Foo.cls:12:5 - message   |   classes/Foo.cls-meta.xml: message
  [
    /(?:^|\s)(?:[\w.-]+\/)*?(classes|triggers|objects|flows|lwc|aura|layouts|permissionsets|profiles|pages|components|flexipages|customMetadata|labels)\/([\w.-]+?)(?:\.[\w-]+)*(?::(\d+))?(?::\d+)?\s*[-:]\s*(.+)$/,
    (m) => ({componentType: TYPE_BY_DIR[m[1]], component: m[2], line: m[3] ? Number(m[3]) : undefined, message: m[4]}),
  ],
  // FooTest.itWorks: System.AssertException: Assertion Failed
  [
    /^(?:Test failure,?\s*(?:method:)?\s*)?(\w+Test\w*)\.(\w+)\s*(?:--|:)\s*(.+)$/,
    (m) => ({componentType: 'ApexClass', component: m[1], message: `${m[2]}: ${m[3]}`, test: true}),
  ],
]

export function extractErrors(text: string): DeployError[] {
  const out: DeployError[] = []
  fromJson(text, out)
  for (const rawLine of text.split(/\r?\n/)) {
    const line = clean(rawLine)
    if (!line || line.startsWith('{') || !ERROR_MARKERS.test(line)) continue
    let hit: DeployError | undefined
    for (const [re, build] of PATTERNS) {
      const m = line.match(re)
      if (m) {
        hit = {...build(m), raw: line}
        break
      }
    }
    hit ??= {message: line.replace(/^(?:\[?error\]?:?\s*)/i, ''), raw: line}
    if (hit.test === undefined && /Assert(?:ion)? ?Failed|AssertException|Test failure/i.test(hit.raw)) hit.test = true
    out.push(hit)
  }
  // Same error often appears in both the JSON payload and the human log.
  const seen = new Set<string>()
  return out.filter((e) => {
    const k = `${e.componentType ?? ''}|${e.component ?? ''}|${e.message.toLowerCase()}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
