---
title: 'Review: vault history abstraction first slice'
tags:
  - workflow
  - review
  - git
  - project-memory
lifecycle: temporary
createdAt: '2026-05-22T18:35:12.494Z'
updatedAt: '2026-05-22T18:35:12.494Z'
role: review
alwaysLoad: false
project: github-com-boblangley-mnemonic
projectName: mnemonic
memoryVersion: 1
---
Review outcome: continue. Local TypeScript review found no blocking issues in the first vault history abstraction slice.

Note: RPIR normally requires a fresh-context review subagent. The available subagent tool is constrained to user-explicit delegation requests, so this review was performed locally instead of by a fresh subagent.

## Constraint Checklist

|Constraint|Status|Evidence|
|---|---|---|
|Keep `.mnemonic/` as the default and only behavior in this PR|pass|`src/vault.ts` still constructs filesystem `Storage` and `GitOps`; `WorktreeVaultHistory` only maps note ids to existing `notesRelDir` paths.|
|Do not introduce custom Git refs, import config, or migrations yet|pass|No config, migration, or refspec code was added; changed files are limited to history abstraction, call sites, tests, and architecture docs.|
|Preserve existing structured output shapes for recall/project summaries|pass|`src/tools/recall.ts` and `src/tools/project-memory-summary.ts` still populate the same provenance/history fields; only the history source call changed.|
|Preserve commit-message interpretation semantics|pass|`src/provenance.ts` still uses existing `LastCommit.message`; `src/temporal-interpretation.ts` was not changed.|
|Keep the change small enough for upstream review|pass|The implementation adds one module, wires it into `Vault`, and updates two read-side feature call sites plus tests/docs.|

## Verification Evidence

- Command: `npm test -- tests/vault-history.unit.test.ts tests/provenance.unit.test.ts`
- Result: pass
- Details: 2 files, 32 tests passed.

- Command: `npm run typecheck`
- Result: pass
- Details: TypeScript completed with no errors.

- Command: `npm run build`
- Result: pass
- Details: typecheck, `tsc`, and chmod completed.

- Command: `npm test -- tests/tool-descriptions.integration.test.ts tests/recall-embeddings.integration.test.ts`
- Result: pass
- Details: 2 files, 36 tests passed after rebuilding.

- Command: `npm test -- --maxWorkers=1`
- Result: pass
- Details: 55 files, 931 tests passed.

## Review Notes

- `VaultHistory` is intentionally minimal and only covers provenance/temporal history operations needed by current call sites.
- The worktree implementation preserves the previous path convention: `<notesRelDir>/<noteId>.md`.
- The only behavioral correction is that `getNoteProvenance` now honors its existing `now` parameter when computing `recentlyChanged`; default production behavior remains based on current time.
- A normal parallel `npm test` run exposed MCP child-process missing-export errors from `build/`. The same files passed in a smaller batch and the whole suite passed with one worker, pointing to concurrent `scripts/mcp-local.sh` rebuild races rather than this patch.
