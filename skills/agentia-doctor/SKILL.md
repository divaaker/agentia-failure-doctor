---
name: agentia-doctor
description: Use this skill when a Copado promotion, deployment, validation or job execution failed and the user wants to know why or how to fix it; before promoting a user story (preflight); when triaging several failures; or when asked for release health / DORA metrics. Works through the Agentia Failure Doctor plugin (`agentia doctor ...`) or its MCP tools (`doctor_*`), alongside the agentia-cicd skill.
---

# Agentia Failure Doctor

Diagnose failed Copado jobs from evidence, then fix them safely with a human in the loop.

Prefer the `doctor_*` MCP tools when registered (`agentia doctor mcp`). Otherwise use the CLI with `--json`.

## The loop

1. **Identify.** Get a JobExecution Id or Promotion Id from the user or from `agentia cicd job list --status Error --json`. Never invent Ids.
2. **Diagnose.** `doctor_diagnose` / `agentia doctor diagnose <jobId> --json`. Add `--pipeline-id`, `--source-org-id` and `--target-org-id` when known, so missing-dependency findings come with proof. Add `--ai` only if the root cause is `UNKNOWN`.
3. **Explain.** Tell the user the root cause, the confidence, and the evidence, in that order. Name symptoms (`SF-DEPENDENT-INVALID`, `SF-COVERAGE` after a compile error) as symptoms: do not ask the user to fix them separately.
4. **Plan.** `doctor_plan_fix` / `agentia doctor fix <jobId>` (dry run). Each step is `read`, `write` or `manual`.
5. **Act, with confirmation.**
   - `read` steps: run them.
   - `write` steps change Copado (resolve conflict, resume job, re-run promotion). Show the exact command and wait for an explicit "yes" before running it, via the Agentia MCP tool or `agentia doctor fix <jobId> --apply`.
   - `manual` steps: hand them to the user with the context they need. Do not improvise workarounds (for example deleting metadata or deactivating a Flow) that the plan did not propose.
6. **Verify.** After a resume or re-run, re-check with `agentia cicd job get <id> --json`. Report the final status, not the intended one.

## Prevent before promoting

Before a user asks to promote a story, run `doctor_preflight` / `agentia doctor preflight US-… --json`. If `ok` is false, show the blockers and the suggested fix (add the missing component to the story, or promote the owning story first). Do not promote a blocked story.

## Teach the Doctor

When a root cause was `UNKNOWN` and the user confirms the fix (yours or a Copado AI agent's), offer `agentia doctor learn <jobId> --title "…" --explain "…"`. It writes `.agentia-doctor/signatures.json`; remind the user to commit it so the whole team benefits.

## Triage many failures

`doctor_scan` / `agentia doctor scan --json` groups recent failures by root-cause fingerprint. Start with the biggest group: one fix often clears many jobs.

## Release health

`doctor_dora` / `agentia doctor dora --json` gives deployment frequency, change failure rate and MTTR by job type. State the window and job count with every number.

## Rules

- Evidence first. If the diagnosis confidence is `low`, say so and show the raw log sample. Do not present a guess as a cause.
- Never run a `write` step without confirmation, even if a previous step in the conversation was approved.
- Never print credentials, tokens, session Ids or org URLs from logs.
- If Agentia reports missing auth or context, stop and tell the user which `agentia auth set` / project default is needed.
