# Agentia Failure Doctor

Headless root-cause triage and guided fixes for failed Copado promotions, as a plugin for the [Copado Agentia CLI](https://developer.copado.com/).

When a promotion fails, the fix is rarely hard. Finding it is. The Doctor reads the job's steps and logs through Agentia, recognises the failure, separates the root cause from its cascading symptoms, collects evidence, and proposes a fix you confirm before anything changes.

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
| `agentia doctor dora` | Deployment frequency, change failure rate, MTTR by job type | No |
| `agentia doctor signatures` | List the failure signatures the Doctor recognises | No |
| `agentia doctor mcp` | MCP server exposing `doctor_*` tools over stdio | No (read-only tools) |
| `agentia doctor setup` | Install the `agentia-doctor` agent skill into this project | Local files only |

All commands support `--json`.

## How it works

1. **Collect.** Only through public Agentia commands: `cicd job get`, `cicd job log get`, `cicd job list`, `cicd promotion conflict list`, `cicd metadata dependency list`, `ai agent ask`. The plugin never imports Agentia internals.
2. **Extract.** Individual errors from Metadata API JSON, `sf` table output, path-prefixed and test-result lines ([src/lib/extract.ts](src/lib/extract.ts)).
3. **Classify.** Against a ranked signature library ([src/lib/signatures.ts](src/lib/signatures.ts)). Rank decides root cause vs symptom: a missing field outranks the "Dependent class is invalid" errors it causes, which outrank the coverage failure after them.
4. **Evidence.** Dependency diff between source and destination for missing-dependency failures; open conflicts for merge failures; a Copado AI agent only for errors no rule recognises (`--ai`).
5. **Plan.** Every step is `read`, `write` or `manual`. `write` steps always need confirmation.

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

## Develop

```sh
npm test        # vitest, synthetic fixtures only
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
