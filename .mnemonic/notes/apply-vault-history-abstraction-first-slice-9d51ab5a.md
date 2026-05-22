---
title: 'Apply: vault history abstraction first slice'
tags:
  - workflow
  - apply
  - git
  - project-memory
lifecycle: temporary
createdAt: '2026-05-22T18:34:09.127Z'
updatedAt: '2026-05-22T18:34:15.287Z'
role: context
alwaysLoad: false
project: github-com-boblangley-mnemonic
projectName: mnemonic
relatedTo:
  - id: plan-backend-neutral-vault-history-abstraction-for-custom-re-99f14851
    type: follows
memoryVersion: 1
---
Implemented the first optional-custom-ref preparatory slice: a backend-neutral vault history abstraction with no custom-ref behavior yet.

## Changes

- Added `src/vault-history.ts` with `VaultHistory` and `WorktreeVaultHistory`.
- Added `history: VaultHistory` to `Vault` and wired existing vault construction to use `WorktreeVaultHistory` backed by the current `GitOps` instance and `notesRelDir`.
- Updated provenance and temporal recall call sites to request history by note id through `vault.history` instead of constructing `notesRelDir/<id>.md` at each call site.
- Updated project memory summary provenance enrichment to use `vault.history`.
- Added unit tests for `WorktreeVaultHistory` path mapping and `getNoteProvenance` using the history interface.
- Updated `ARCHITECTURE.md` source layout table for `src/vault-history.ts`.

## Verification

- Command: `npm test -- tests/vault-history.unit.test.ts tests/provenance.unit.test.ts`
- Result: pass
- Details: 2 files, 32 tests passed.

- Command: `npm run typecheck`
- Result: pass
- Details: TypeScript completed with no errors.

- Command: `npm run build`
- Result: pass
- Details: typecheck, `tsc`, and executable chmod completed.

- Command: `npm test`
- Result: partial
- Details: first full parallel run failed with MCP child-process missing-export errors from `build/`, consistent with concurrent `scripts/mcp-local.sh` rebuild races rather than assertions in this change.

- Command: `npm test -- tests/tool-descriptions.integration.test.ts tests/recall-embeddings.integration.test.ts`
- Result: pass
- Details: previously failing integration files passed when rerun in a smaller batch.

- Command: `npm test -- --maxWorkers=1`
- Result: pass
- Details: 55 files, 931 tests passed.

## Notes

The implementation intentionally does not add custom Git refs, imported refs, new config, or migrations. It creates the boundary needed for future ref-backed provenance and temporal history.
