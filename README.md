# Agentia Failure Doctor

Headless root-cause triage, guided fixes and failure prevention for Copado pipelines, as a plugin for the [Copado Agentia CLI](https://developer.copado.com/).

When a promotion fails, the fix is rarely hard. Finding it is. The Doctor reads the job's steps and logs through Agentia, recognises the failure, separates the root cause from its cascading symptoms, collects evidence, and proposes a fix you confirm before anything changes. Then it stops the same failure from reaching the pipeline again: `preflight` blocks it before promotion, `learn` turns each new fix into a team rule, and `dora` and the Slack digest show whether release health is improving.

Deck: [docs/deck.pdf](docs/deck.pdf).

**Try it in 30 seconds, no Copado org needed:** every command takes `--demo`, which swaps the Copado gateway for a built-in synthetic pipeline (dev → UAT → production, six weeks of history, five open failures).

```sh
agentia doctor demo --reset
agentia doctor scan --demo
agentia doctor diagnose JE-000101 --demo
agentia doctor fix JE-000102 --apply --demo
agentia doctor preflight US-0000105 --demo
agentia doctor dora --demo
```

```
$ agentia doctor diagnose a4N5g000000XXXXEAA --pipeline-id … --source-org-id … --target-org-id …

Job JE-000101 (a4N5g000000XXXXEAA) · Error · SFDX Deploy
Failed step: Deploy

ROOT CAUSE  Apex references a class, method or variable that is missing   [SF-MISSING-APEX-SYMBOL, confidence: high]
            missing/offending: CustomField Tax_Rate__c
            failing component(s): ApexClass:InvoiceService
            …

ALSO SEEN (2), usually symptoms of the root cause:
  - Code coverage below the required 75% ×1
  - Dependent class is invalid (cascade) (ApexClass:InvoiceBatch, ApexClass:InvoiceController) ×2

EVIDENCE
  [dependencies] ApexClass InvoiceService depends on CustomField:Invoice__c.Tax_Rate__c, which is missing from the destination

NEXT STEPS  (🔍 read-only · ✏️  changes Copado, needs confirmation · 👤 you)
  …
```

## Commands

| Command | What it does | Changes Copado? |
| --- | --- | --- |
| `agentia doctor diagnose [JOB_ID] [-p PROMOTION_ID]` | Root cause, evidence, confidence, next steps | No |
| `agentia doctor fix [JOB_ID] [--apply] [--yes]` | Dry-run fix plan; `--apply` runs it, asking before each change | Only with `--apply` + confirmation |
| `agentia doctor scan` | Diagnose recent failures and group them by root cause | No |
| `agentia doctor preflight [US-…] [--from-branch] [-p PROMOTION_ID]` | Before promotion: block when a component needs metadata the destination lacks and the story doesn't bring, or conflicts are open. Exits 1 when blocked (Git hook, CI, Local Quality Gate) | No |
| `agentia doctor preflight --install-hook` | Install a Git pre-push hook for `feature/US-*` branches | Local files only |
| `agentia doctor learn JOB_ID --title … (--explain … \| --from-ai)` | Save a confirmed diagnosis as a team rule in `.agentia-doctor/signatures.json` | Local files only |
| `agentia doctor dora` | Deployment frequency, change failure rate, MTTR by job type | No |
| `agentia doctor digest --webhook URL [--dry-run]` | Post release health and top root causes to Slack (Block Kit) | No |
| `agentia doctor signatures` | List the failure signatures the Doctor recognises, learned ones included | No |
| `agentia doctor mcp` | MCP server exposing `doctor_*` tools over stdio | No (read-only tools) |
| `agentia doctor setup` | Install the `agentia-doctor` agent skill into this project | Local files only |
| `agentia doctor demo [--reset]` | Reset and describe the synthetic demo pipeline | Local temp file only |

All commands support `--json`.

## How it works

1. **Collect.** Only through public Agentia commands: `cicd job get`, `cicd job log get`, `cicd job list`, `cicd promotion conflict list`, `cicd metadata dependency list`, `ai agent ask`. The plugin never imports Agentia internals.
2. **Extract.** Individual errors from Metadata API JSON, `sf` table output, path-prefixed and test-result lines ([src/lib/extract.ts](src/lib/extract.ts)).
3. **Classify.** Against a ranked signature library ([src/lib/signatures.ts](src/lib/signatures.ts)). Rank decides root cause vs symptom: a missing field outranks the "Dependent class is invalid" errors it causes, which outrank the coverage failure after them.
4. **Evidence.** Dependency diff between source and destination for missing-dependency failures; open conflicts for merge failures; a Copado AI agent only for errors no rule recognises (`--ai`).
5. **Plan.** Every step is `read`, `write` or `manual`. `write` steps always need confirmation.
6. **Prevent.** `preflight` runs the dependency and conflict checks before promotion, so the most common failure (a component whose dependency was never promoted) never reaches the pipeline.
7. **Learn.** `learn` turns a confirmed diagnosis, including a Copado AI agent's answer, into a regex rule tried before the built-in ones. The next occurrence is diagnosed instantly, offline, at zero AI cost.
8. **Redact.** Session Ids, OAuth tokens, `force://` auth URLs, webhooks and `password=`/`token=` values are masked in every report, JSON result, MCP response and Slack message.

```
                 ┌──────────── agentia doctor (oclif plugin) ────────────┐
 terminal / CI ─▶│ diagnose · fix · scan · preflight · learn · dora ·    │
 Claude, Cursor ▶│ digest   ── MCP: doctor_diagnose/plan_fix/scan/       │
   (MCP, skill)  │            preflight/dora/signatures                  │
                 └──────┬───────────────────────────────┬────────────────┘
                        │ public `agentia … --json` only│ local files
                        ▼                               ▼
              Copado CICD gateway + AI agents    .agentia-doctor/signatures.json
              (jobs, logs, conflicts, deps,      (team rules, versioned in Git)
               work items, promotions)
```

## Install

```sh
npm install -g @copado/agentia-cli@beta --registry https://registry.npmjs.org --@copado:registry=https://registry.npmjs.org
agentia auth set --cicd <api-key> --region na

git clone <this repo> && cd agentia-failure-doctor
npm install && npm run build
agentia plugins link .
agentia doctor --help
```

MCP client config (Claude, Cursor):

```json
{"mcpServers": {"agentia-doctor": {"command": "agentia", "args": ["doctor", "mcp"]}}}
```

Environment variables: `DOCTOR_PIPELINE_ID`, `DOCTOR_SOURCE_ORG_ID`, `DOCTOR_TARGET_ORG_ID`, `DOCTOR_SOURCE_CREDENTIAL_ID` (defaults for the context flags, used by the pre-push hook), `DOCTOR_SLACK_WEBHOOK`, `AGENTIA_DOCTOR_DEMO=1`, `AGENTIA_DOCTOR_LIBRARY` (path of the learned-rules file).

Tested with `@copado/agentia-cli` 1.0.0-beta.1. Agentia is a product preview, so flags may change.

## Status and limits

- Every command runs end to end against the synthetic pipeline (`--demo`) and through the real Agentia CLI (linked as a plugin). Against a live Copado org it was exercised only up to authentication: no Copado CICD API key was available during the hackathon. `src/lib/normalize.ts` therefore reads gateway payloads defensively (camelCase or `copado__X__c` field names, several list envelopes).
- `preflight` checks dependencies and conflicts. It does not yet compare file content between environments (`cicd metadata content compare`).

## Develop

```sh
npm test        # vitest: 40 tests on synthetic fixtures and the demo pipeline
npm run build
```

On Node 18, Agentia needs `NODE_OPTIONS=--experimental-global-webcrypto`. Node 20+ needs nothing extra.

## Open-source components

Declared per the hackathon Official Rules §11. Runtime dependencies:

| Package | License |
| --- | --- |
| [@oclif/core](https://github.com/oclif/core) | MIT |
| [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk) | MIT |
| [zod](https://github.com/colinhacks/zod) | MIT |

Their transitive dependencies are MIT, ISC, Apache-2.0, BSD-2/3-Clause, BlueOak-1.0.0 and MIT-OR-CC0 licensed. Dev-only: TypeScript (Apache-2.0), Vitest (MIT), @types/node (MIT).

The Copado Agentia CLI is **not** bundled or modified; it is a separately installed prerequisite under Copado's EULA.

## Data

Every Id, class name and log line in this repository and its tests is synthetic.
