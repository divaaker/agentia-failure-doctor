import {Flags} from '@oclif/core'
import {cp, mkdir, stat} from 'node:fs/promises'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

import {DoctorCommand} from '../../lib/base.js'

const ROOTS = {agents: '.agents/skills', cursor: '.cursor/skills', claude: '.claude/skills'} as const
const exists = (p: string) => stat(p).then(() => true, () => false)

export default class DoctorSetup extends DoctorCommand {
  static summary = 'Install the agentia-doctor skill into this project'
  static description =
    'Copies the agentia-doctor SKILL.md into the same skill roots Agentia uses (`agentia setup skills`), so AI agents in this repo know the diagnose → plan → confirm → fix loop.'
  static examples = ['<%= config.bin %> doctor setup', '<%= config.bin %> doctor setup --target claude --target cursor']
  static flags = {
    target: Flags.string({description: 'Skill root to write (repeatable)', options: Object.keys(ROOTS), multiple: true, default: ['agents']}),
    force: Flags.boolean({description: 'Overwrite an existing agentia-doctor skill', default: false}),
  }

  async run() {
    const {flags} = await this.parse(DoctorSetup)
    const source = resolve(dirname(fileURLToPath(import.meta.url)), '../../../skills/agentia-doctor')
    const written: string[] = []
    for (const t of flags.target as Array<keyof typeof ROOTS>) {
      const dest = join(process.cwd(), ROOTS[t], 'agentia-doctor')
      if ((await exists(dest)) && !flags.force) {
        this.warn(`${dest} exists; use --force to replace it`)
        continue
      }
      await mkdir(dirname(dest), {recursive: true})
      await cp(source, dest, {recursive: true, force: true})
      written.push(dest)
      this.log(`✔ ${join(ROOTS[t], 'agentia-doctor', 'SKILL.md')}`)
    }
    if (written.length) this.log('\nFor MCP clients, add: {"command": "agentia", "args": ["doctor", "mcp"]}')
    return {written}
  }
}
