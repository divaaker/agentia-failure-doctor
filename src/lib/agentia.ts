import {spawn} from 'node:child_process'
import {existsSync} from 'node:fs'
import {join} from 'node:path'

/**
 * Everything the Doctor knows about Copado comes through the public Agentia CLI
 * surface (`agentia <command> --json`). We never import Agentia internals.
 */
export interface AgentiaRunner {
  run<T = unknown>(args: string[]): Promise<T>
}

export class AgentiaError extends Error {
  constructor(
    message: string,
    readonly command: string,
    readonly transactionId?: string,
  ) {
    super(message)
    this.name = 'AgentiaError'
  }
}

export interface CliRunnerOptions {
  /** Root of the host Agentia install (oclif `config.root`). */
  agentiaRoot?: string
  /** Explicit binary, e.g. from AGENTIA_BIN. Wins over agentiaRoot. */
  bin?: string
  timeoutMs?: number
}

/** Envelope printed by Agentia with --json: `{result}` on success, `{error}` on failure. */
interface Envelope<T> {
  result?: T
  error?: {message?: string; name?: string}
  transactionId?: string
}

export class CliRunner implements AgentiaRunner {
  private readonly command: string
  private readonly prefix: string[]
  private readonly timeoutMs: number

  constructor(opts: CliRunnerOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 120_000
    const bin = opts.bin ?? process.env.AGENTIA_BIN
    const runJs = opts.agentiaRoot ? join(opts.agentiaRoot, 'bin', 'run.js') : undefined
    if (bin) {
      this.command = bin
      this.prefix = []
    } else if (runJs && existsSync(runJs)) {
      // Re-use the Node binary and flags the host CLI is already running under.
      this.command = process.execPath
      this.prefix = [...process.execArgv, runJs]
    } else {
      this.command = 'agentia'
      this.prefix = []
    }
  }

  run<T = unknown>(args: string[]): Promise<T> {
    const argv = [...this.prefix, ...args, '--json']
    const label = args.filter((a) => !a.startsWith('-')).slice(0, 4).join(' ')
    return new Promise<T>((resolve, reject) => {
      const child = spawn(this.command, argv, {env: process.env, stdio: ['ignore', 'pipe', 'pipe']})
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        reject(new AgentiaError(`timed out after ${this.timeoutMs}ms`, label))
      }, this.timeoutMs)
      child.stdout.on('data', (d) => (stdout += d))
      child.stderr.on('data', (d) => (stderr += d))
      child.on('error', (err) => {
        clearTimeout(timer)
        reject(new AgentiaError(`could not start agentia: ${err.message}`, label))
      })
      child.on('close', () => {
        clearTimeout(timer)
        let env: Envelope<T>
        try {
          env = JSON.parse(stdout) as Envelope<T>
        } catch {
          const detail = (stderr || stdout).trim().split('\n').slice(-3).join(' ')
          reject(new AgentiaError(`non-JSON output: ${detail || '(empty)'}`, label))
          return
        }
        if (env.error) {
          reject(new AgentiaError(env.error.message ?? 'unknown error', label, env.transactionId))
          return
        }
        resolve((env.result ?? env) as T)
      })
    })
  }
}
