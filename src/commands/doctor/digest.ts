import {Flags} from '@oclif/core'

import {DoctorCommand} from '../../lib/base.js'
import {postToSlack, slackDigest} from '../../lib/digest.js'
import {doraFromHistory, scanFailures} from '../../lib/scan.js'

export default class DoctorDigest extends DoctorCommand {
  static summary = 'Post a release-health digest to Slack'
  static description =
    'Scans recent failures, groups them by root cause and adds DORA metrics, then posts one Block Kit message to a Slack incoming webhook. Secrets are redacted. Use --dry-run to print the payload instead. Schedule it in CI for a daily release-channel digest.'
  static examples = [
    '<%= config.bin %> doctor digest --webhook https://hooks.slack.com/services/…',
    '<%= config.bin %> doctor digest --dry-run --json',
  ]
  static flags = {
    webhook: Flags.string({description: 'Slack incoming webhook URL', env: 'DOCTOR_SLACK_WEBHOOK'}),
    title: Flags.string({description: 'Message title', default: 'Copado release health'}),
    limit: Flags.integer({description: 'Failed jobs to diagnose', default: 20, min: 1, max: 200}),
    'dry-run': Flags.boolean({description: 'Print the Slack payload instead of posting it', default: false}),
  }

  async run() {
    const {flags} = await this.parse(DoctorDigest)
    if (!flags.webhook && !flags['dry-run']) this.error('Pass --webhook (or DOCTOR_SLACK_WEBHOOK), or --dry-run')
    const [scan, dora] = [await scanFailures(this.runner, {limit: flags.limit}), await doraFromHistory(this.runner)]
    const payload = slackDigest(scan, dora, flags.title)
    if (flags['dry-run']) {
      this.log(JSON.stringify(payload, null, 2))
      return {posted: false, payload}
    }
    await postToSlack(flags.webhook!, payload)
    this.log(`✔ Posted: ${payload.text}`)
    return {posted: true, payload}
  }
}
