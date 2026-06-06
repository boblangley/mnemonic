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
updatedAt: '2026-06-06T04:19:10.569Z'
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
