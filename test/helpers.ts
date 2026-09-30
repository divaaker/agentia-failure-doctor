import {AgentiaError, type AgentiaRunner} from '../src/lib/agentia.js'

/**
 * Answers Agentia calls from an in-memory table keyed by the command words,
 * e.g. "cicd job get JOB1". Records every call so tests can assert on them.
 * All data is synthetic.
 */
export class FakeRunner implements AgentiaRunner {
  calls: string[][] = []
  constructor(private readonly table: Record<string, unknown>) {}

  async run<T>(args: string[]): Promise<T> {
    this.calls.push(args)
    const key = Object.keys(this.table)
      .sort((a, b) => b.length - a.length)
      .find((k) => args.join(' ').startsWith(k))
    if (!key) throw new AgentiaError(`no fixture for: ${args.join(' ')}`, args.slice(0, 4).join(' '))
    const v = this.table[key]
    if (v instanceof Error) throw v
    return v as T
  }
}
