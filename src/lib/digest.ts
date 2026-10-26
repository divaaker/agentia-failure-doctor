import type {DoraReport} from './dora.js'
import {redactDeep} from './redact.js'
import type {ScanGroup} from './scan.js'

/** Slack Block Kit message summarising release health and recurring failures. */
export function slackDigest(scan: {scanned: number; groups: ScanGroup[]}, dora: DoraReport, title = 'Copado release health'): {text: string; blocks: unknown[]} {
  const pct = (n: number) => `${Math.round(n * 100)}%`
  const mttr = dora.meanTimeToRecoveryHours === undefined ? 'n/a' : `${dora.meanTimeToRecoveryHours} h`
  const top = scan.groups.slice(0, 5)
  const blocks: unknown[] = [
    {type: 'header', text: {type: 'plain_text', text: `🩺 ${title}`}},
    {
      type: 'section',
      fields: [
        {type: 'mrkdwn', text: `*Change failure rate*\n${pct(dora.changeFailureRate)}`},
        {type: 'mrkdwn', text: `*Mean time to recovery*\n${mttr}`},
        {type: 'mrkdwn', text: `*Deployments / day*\n${dora.deploymentsPerDay}`},
        {type: 'mrkdwn', text: `*Still failing*\n${dora.unrecovered} lane(s)`},
      ],
    },
    {type: 'context', elements: [{type: 'mrkdwn', text: `${dora.deployments} deployment jobs, ${dora.window.from?.slice(0, 10) ?? '?'} → ${dora.window.to?.slice(0, 10) ?? '?'}`}]},
    {type: 'divider'},
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: top.length
          ? `*Top root causes* (${scan.scanned} failed jobs, ${scan.groups.length} distinct)\n` +
            top.map((g) => `• *${g.jobs.length}×* ${g.title} \`${g.category}\`\n    _${g.jobs.slice(0, 4).join(', ')}${g.jobs.length > 4 ? ', …' : ''}_`).join('\n')
          : '*No failed jobs* in this window. 🎉',
      },
    },
    {type: 'context', elements: [{type: 'mrkdwn', text: 'Run `agentia doctor diagnose <job>` for root cause, evidence and a fix plan.'}]},
  ]
  const text = `${title}: CFR ${pct(dora.changeFailureRate)}, MTTR ${mttr}, ${scan.scanned} failed jobs`
  return redactDeep({text, blocks})
}

export async function postToSlack(webhook: string, payload: unknown): Promise<void> {
  const res = await fetch(webhook, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(payload)})
  if (!res.ok) throw new Error(`Slack returned ${res.status}: ${(await res.text()).slice(0, 200)}`)
}
