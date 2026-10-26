/**
 * Strip secrets from anything the Doctor prints, posts to Slack or returns over
 * MCP. Deploy logs routinely echo session Ids, OAuth tokens and auth URLs.
 */
const RULES: Array<[RegExp, string]> = [
  [/force:\/\/[^\s"'<>]+/gi, 'force://<redacted>'],
  [/\b(Bearer|OAuth)\s+[\w.!\-~+/=]{16,}/gi, '$1 <redacted>'],
  // Salesforce session Ids / access tokens: 00D org prefix + "!" + opaque tail.
  [/\b00D[a-zA-Z0-9]{12,15}![\w.\-]{20,}/g, '<redacted-session>'],
  [/\b(access_token|refresh_token|client_secret|password|passwd|api[_-]?key|sessionId|session_id|token)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi, '$1$2<redacted>'],
  [/https:\/\/hooks\.slack\.com\/services\/[\w/]+/gi, 'https://hooks.slack.com/services/<redacted>'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '<redacted-github-token>'],
  [/\bxox[abposr]-[\w-]{10,}/g, '<redacted-slack-token>'],
]

export function redact(text: string): string {
  let out = text
  for (const [re, sub] of RULES) out = out.replace(re, sub)
  return out
}

/** Deep-redact every string in a JSON-able value. */
export function redactDeep<T>(v: T): T {
  if (typeof v === 'string') return redact(v) as T
  if (Array.isArray(v)) return v.map(redactDeep) as T
  if (v && typeof v === 'object' && !(v instanceof Date) && !(v instanceof RegExp))
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)])) as T
  return v
}
