---
title: 'Apply: Git ref note store foundation'
tags:
  - workflow
  - apply
  - git
  - project-memory
  - vault
lifecycle: temporary
createdAt: '2026-06-06T04:19:05.958Z'
updatedAt: '2026-06-06T05:09:40.149Z'
role: context
alwaysLoad: false
project: github-com-boblangley-mnemonic
projectName: mnemonic
relatedTo:
  - id: optional-git-ref-project-memory-backend-architecture-9dfce64a
    type: derives-from
memoryVersion: 1
---
Implemented the first Git ref-backed storage foundation: `GitRefNoteStore` can read and write note trees under custom refs such as `refs/mnemonic/project` without creating normal worktree note files.

## Changes

- Added `src/git-ref-note-store.ts` with `GitRefNoteStore`, memory-ref validation, stale-tip conflict detection, and compare-and-swap `git update-ref` writes.
- The store lists note ids with `git ls-tree`, reads notes with `git show`, writes note blobs with `git hash-object`, builds memory trees through a temporary index, creates commits with `git commit-tree`, and updates refs with an expected old oid.
- Exported shared `serializeNote` and `parseNote` helpers from `src/storage.ts` so filesystem storage and ref-backed note storage preserve the same markdown/frontmatter behavior.
- Added `tests/git-ref-note-store.unit.test.ts` covering ref validation, write/read without worktree files, preserving existing tree contents across add/delete, stale expected-tip rejection, and no-change detection.
- Updated `ARCHITECTURE.md` source layout for the new module.

## Verification

- `npm test -- tests/git-ref-note-store.unit.test.ts`: pass, 5 tests.
- `npm test -- tests/git-ref-note-store.unit.test.ts tests/storage.unit.test.ts`: pass, 2 files, 49 tests.
- `npm run typecheck`: pass.
- `npx eslint src/git-ref-note-store.ts tests/git-ref-note-store.unit.test.ts src/storage.ts`: pass.
- `npm run build`: pass.
- Local MCP smoke via `npm run mcp:local`: initialize and `tools/list` returned successfully.

## Next Step

Wire this lower-level store into a backend-shaped vault implementation and decide the public project policy/config shape for selecting filesystem vs custom-ref project storage.

## 2026-06-06 Continuation

Extended the Git ref-backed storage implementation beyond the low-level note store.

Additional committed slices:

- `feat: add custom-ref storage adapter` added `GitRefStorage`, a `NoteStorage` adapter that stages ref-backed note writes/deletes, overlays pending changes during reads/lists, flushes through `GitRefNoteStore`, and delegates embeddings/projections to local derived storage.
- `feat: add custom-ref git commit bridge` added `GitRefGitOps`, a `GitOps`-compatible bridge that maps `commitWithStatus` to staged ref flushes, reports pending note paths through `status`, and pushes custom refs with explicit refspecs.
- `feat: add project storage backend policy` added policy/config fields `projectStorageBackend` and `projectMemoryRef`, exposed them through set/get project policy schemas, validated custom refs, and updated the MCP schema snapshot.
- `feat: create ref-backed project vaults` added `VaultManager.getOrCreateProjectRefVault`, composing `GitRefStorage` and `GitRefGitOps` while keeping derived local artifacts under Git's private directory.
- `feat: route project writes to ref backend policy` made `resolveWriteVault` honor `projectStorageBackend: "git-ref"`.
- `feat: load ref-backed project vaults for reads` loads policy-selected ref-backed vaults before common visible-note collection and before `get` lookup.

Verification after these slices:

- Focused bundle: `npm test -- tests/git-ref-note-store.unit.test.ts tests/git-ref-storage.unit.test.ts tests/git-ref-git.unit.test.ts tests/vault.unit.test.ts tests/project-helper.unit.test.ts tests/project-memory-policy.unit.test.ts tests/config.unit.test.ts tests/mcp-schema-contract.integration.test.ts` passed: 8 files, 96 tests.
- `npm run build` passed.
- Local MCP smoke via `npm run mcp:local` initialized and `detect_project` returned the mnemonic project identity.

Known remaining gaps: ref-backed sync currently returns an empty sync result; temporal provenance for ref-backed notes still uses the worktree history abstraction and needs a ref-aware history implementation before temporal recall is accurate for custom-ref notes.
