---
title: 'Plan: backend-neutral vault history abstraction for custom refs'
tags:
  - workflow
  - plan
  - git
  - project-memory
lifecycle: temporary
createdAt: '2026-05-22T18:25:22.670Z'
updatedAt: '2026-05-22T18:34:15.287Z'
role: plan
alwaysLoad: false
project: github-com-boblangley-mnemonic
projectName: mnemonic
relatedTo:
  - id: request-research-custom-git-ref-storage-for-project-memories-96d66dcc
    type: derives-from
  - id: research-feature-impact-of-optional-git-ref-memory-backend-e6aa4449
    type: derives-from
  - id: apply-vault-history-abstraction-first-slice-9d51ab5a
    type: follows
memoryVersion: 1
---
Plan: introduce a backend-neutral vault history abstraction as the first upstream-friendly slice toward optional custom Git ref memory storage.

## Scope

This first PR should not add custom-ref storage behavior yet. It should preserve current `.mnemonic/` filesystem project vault behavior while removing direct assumptions that provenance and temporal history always use `HEAD` plus a worktree path.

## Steps

- [ ] Add a small `VaultHistory` interface for note history operations by note id.
- [ ] Implement the existing worktree/path-backed behavior through that interface.
- [ ] Attach the history implementation to `Vault` construction without changing storage routing.
- [ ] Update provenance and temporal recall call sites to ask `vault.history` instead of `vault.git` plus manually assembled file paths.
- [ ] Add focused tests that prove the path-backed implementation preserves current behavior.
- [ ] Run typecheck and focused tests; broaden to full test suite if the change touches shared behavior more than expected.

## Constraints

- Keep `.mnemonic/` as the default and only behavior in this PR.
- Do not introduce custom Git refs, import config, or migrations yet.
- Preserve existing structured output shapes for recall/project summaries.
- Preserve commit-message interpretation semantics.
- Keep the change small enough for upstream review.
