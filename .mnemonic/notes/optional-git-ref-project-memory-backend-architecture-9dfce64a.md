---
title: Optional Git ref project memory backend architecture
tags:
  - architecture
  - git
  - project-memory
  - vault
  - decision
lifecycle: permanent
createdAt: '2026-06-06T04:13:08.128Z'
updatedAt: '2026-06-06T04:13:08.128Z'
project: github-com-boblangley-mnemonic
projectName: mnemonic
relatedTo:
  - id: request-research-custom-git-ref-storage-for-project-memories-96d66dcc
    type: derives-from
memoryVersion: 1
---
Consolidate temporary RPIR notes after the backend-neutral VaultHistory preparatory slice was implemented and reviewed.

Optional Git ref project memory storage is feasible and should be added as an optional project-storage backend, not as a replacement for the existing `.mnemonic/` filesystem project vault.

## Decision

Keep `.mnemonic/` as the default compatibility backend. Add any future custom-ref storage as an explicit opt-in backend, with clear storage labels such as `project-ref-vault` for writable active project memory and `import-ref:<alias>` for read-only imported memory refs.

## Research Findings

- Git can store memory-only commits under a custom ref such as `refs/mnemonic/project` using plumbing like `git write-tree`, `git commit-tree`, and `git update-ref`.
- Custom refs can be pushed and fetched with explicit refspecs. A local experiment pushed `refs/mnemonic/project` to a bare remote, fetched it into `refs/mnemonic/vendor/source`, and checked it out in a detached worktree.
- Pulling memory sets from other repositories is feasible with explicit remote/refspec configuration, for example mapping another repo's `refs/mnemonic/project` into `refs/mnemonic/imports/<project>` locally.
- Submodules are the wrong primitive for custom memory refs. Git submodules pin gitlink commits; they do not directly track arbitrary custom refs. A branch-backed memory ref would fit submodule tracking more naturally, but then it is a branch rather than a non-head custom ref.

## Architecture Implications

- Introduce storage/backend boundaries below the existing tools so public MCP behavior can stay stable while vault implementations decide whether notes are filesystem-backed or Git-object-backed.
- Use compare-and-swap `update-ref` semantics against the previous ref oid to avoid clobbering concurrent memory writes.
- Make `sync` backend-aware: filesystem project vaults continue using the existing pull/rebase flow, while ref-backed vaults fetch and push explicit memory refspecs and diff old/new ref tips to rebuild embeddings.
- Keep imported refs read-only by default. They may participate in recall, list, get, relationship previews, summaries, graph, and tag discovery, but mutating tools must reject them or use an explicit future write policy.
- Store embeddings and projections as derived local artifacts keyed by vault/source identity plus ref plus note id, because imported refs can contain colliding note ids.
- Treat temporal provenance as backend-specific. Ref-backed notes do not have worktree paths in `HEAD`; temporal recall must inspect note paths inside the memory ref history.
- Decide PR visibility deliberately. Ref-backed memory commits will not appear as normal PR file changes, so PR description and CI workflows need either memory-ref diff support or a convention that review-visible decisions stay filesystem-backed.

## Implemented Preparatory Slice

The first upstream-friendly slice has already been implemented: `VaultHistory` and `WorktreeVaultHistory` now provide backend-neutral note history operations for provenance and temporal recall without adding custom-ref behavior.

Implemented changes included:

- `src/vault-history.ts` with `VaultHistory` and `WorktreeVaultHistory`.
- `history: VaultHistory` attached to `Vault` construction.
- Provenance, temporal recall, and project-memory-summary call sites now request note history by note id through `vault.history` instead of constructing worktree paths directly.
- Focused tests for worktree history behavior and provenance via the history interface.
- `ARCHITECTURE.md` updated for the new source file.

Verification for that slice passed: focused vault-history/provenance tests, typecheck, build, smaller integration reruns, and full single-worker test suite (`55 files, 931 tests`). A normal parallel full test run exposed existing MCP child-process rebuild races rather than assertions related to the patch.

## Open Questions

- Should protected branch policy apply to memory refs, or should memory refs have their own protection policy?
- Should PR workflows learn to diff memory refs, or should review-visible decisions stay in filesystem notes?
- Should imported refs be searched by default or only when explicitly enabled per project?
- Where should ref-backed derived artifacts live: `.git/mnemonic-cache`, main vault cache, or a project-local ignored directory?
- Should schema version live inside the memory ref so it travels with notes, or outside in local config to avoid mutating imported sources?
