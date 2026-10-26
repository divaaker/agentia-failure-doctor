import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {dirname, join} from 'node:path'

import type {Diagnosis} from './diagnose.js'
import {type Category, type FixKind, type Signature, SIGNATURES} from './signatures.js'

/**
 * The team's local signature library: confirmed diagnoses saved with `doctor learn`.
 * Lives in the repo (`.agentia-doctor/signatures.json`) so it is versioned and
 * shared like any other code. Local rules are tried before the built-in ones.
 */
export interface LearnedSignature {
  id: string
  title: string
  category: Category
  rank: number
  match: string
  flags: string
  explain: string
  fix: FixKind
  learnedFrom?: string
  learnedAt: string
}

export const libraryPath = (cwd = process.cwd()) => process.env.AGENTIA_DOCTOR_LIBRARY ?? join(cwd, '.agentia-doctor', 'signatures.json')

export async function loadLearned(path = libraryPath()): Promise<LearnedSignature[]> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as {signatures?: LearnedSignature[]}
    return raw.signatures ?? []
  } catch {
    return []
  }
}

export const toSignature = (l: LearnedSignature): Signature => ({
  id: l.id,
  title: l.title,
  category: l.category,
  rank: l.rank,
  match: new RegExp(l.match, l.flags),
  explain: l.explain,
  fix: l.fix,
})

/** Built-in rules plus the team's learned ones, learned first. */
export async function allRules(path = libraryPath()): Promise<Signature[]> {
  return [...(await loadLearned(path)).map(toSignature), ...SIGNATURES]
}

/**
 * Turn a concrete error message into a reusable pattern: escape it, then let
 * Salesforce Ids, numbers and quoted literals vary.
 */
export function patternFrom(message: string): string {
  // Mask with placeholders first, so masking digits can't corrupt the inserted patterns.
  return message
    .trim()
    .slice(0, 160)
    .replace(/\b[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?\b/g, (s) => (/\d/.test(s) && /[a-z]/i.test(s) ? '\u0001' : s))
    .replace(/'[^']*'/g, '\u0002')
    .replace(/\d+/g, '\u0003')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\u0001/g, '[a-zA-Z0-9]{15,18}')
    .replace(/\u0002/g, "'[^']*'")
    .replace(/\u0003/g, '\\d+')
}

export interface LearnInput {
  title: string
  explain: string
  category?: Category
  fix?: FixKind
  match?: string
}

export async function learn(d: Diagnosis, input: LearnInput, path = libraryPath()): Promise<LearnedSignature> {
  const target = d.findings.find((f) => f.signature.category === 'unknown') ?? d.rootCause
  if (!input.match && !target) throw new Error('The job has no error to learn from; pass --match <regex>')
  const existing = await loadLearned(path)
  const sig: LearnedSignature = {
    id: `LOCAL-${String(existing.length + 1).padStart(3, '0')}`,
    title: input.title,
    category: input.category ?? 'data',
    rank: 12,
    match: input.match ?? patternFrom(messageOf(target!.sample)),
    flags: 'i',
    explain: input.explain,
    fix: input.fix ?? 'manual',
    learnedFrom: d.job.name,
    learnedAt: new Date().toISOString(),
  }
  new RegExp(sig.match, sig.flags) // throws on a bad --match before we write anything
  await mkdir(dirname(path), {recursive: true})
  await writeFile(path, JSON.stringify({signatures: [...existing, sig]}, null, 2) + '\n')
  return sig
}

/** Drop the "Error  Type  Name" table prefix and the "(line:col)" suffix from a log line. */
const messageOf = (sample: string) =>
  sample.replace(/^\s*Error\s{2,}\S+\s{2,}\S+\s{2,}/, '').replace(/\s*\(\d+:\d+\)\s*$/, '')
