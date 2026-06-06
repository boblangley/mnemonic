---
title: 'Research: custom Git refs for project memory storage'
tags:
  - workflow
  - research
  - git
  - project-memory
lifecycle: temporary
createdAt: '2026-05-22T17:48:35.371Z'
updatedAt: '2026-05-22T17:58:51.400Z'
role: research
alwaysLoad: false
project: github-com-danielmarbach-mnemonic
projectName: mnemonic
relatedTo:
  - id: request-research-custom-git-ref-storage-for-project-memories-96d66dcc
    type: derives-from
  - id: research-feature-impact-of-optional-git-ref-memory-backend-e6aa4449
    type: follows
memoryVersion: 1
---
Custom Git refs are feasible for project-level mnemonic memories, but they are a storage-model change rather than a small relocation of `.mnemonic/`.

## Findings

- Today mnemonic stores project memories as markdown notes in `<git-root>/.mnemonic/notes`, with `.mnemonic/embeddings` and `.mnemonic/projections` ignored/local-only. The implementation is filesystem-first: `VaultManager` creates/loads `.mnemonic`, `Storage` reads/writes note files, and `GitOps` stages/commits paths like `.mnemonic/notes/<id>.md`.
- Git can store memory-only commits under a custom ref such as `refs/mnemonic/project`. Official docs describe refs as entries under `refs/`, `git update-ref` as the safe way to update a ref, and `git commit-tree`/`git write-tree` as plumbing for making commits from trees. A throwaway local test wrote `notes/one.md` to `refs/mnemonic/project` without adding it to `HEAD` or the project working tree.
- Custom refs can be pushed and fetched with explicit refspecs. A throwaway local test pushed `refs/mnemonic/project` to a bare remote, then fetched it into `refs/mnemonic/vendor/source` and checked it out in a detached worktree.
- Fetching custom refs is permissive when the destination is outside `refs/heads/*` and `refs/tags/*`; Git docs say fetch updates outside those namespaces are accepted without `+`, even for non-fast-forward or object-type swaps. Push rules still require explicit destination refs and hosting policy may restrict non-branch namespaces.
- Pulling memories from other repositories via Git is feasible with explicit remote/refspec configuration, for example mapping `refs/mnemonic/project` from another repo into a local namespace like `refs/mnemonic/imports/<project>`. The consumer can then read notes directly from that ref or materialize them into a worktree/cache.
- There is no direct concept of "submodule a ref". Git submodules record a gitlink commit in the superproject, plus `.gitmodules` hints. The Git docs state the gitlink contains the object name of the expected commit. A local experiment confirmed `git submodule add -b refs/mnemonic/project` fails because Git tries to resolve `origin/refs/mnemonic/project` as a branch.
- A submodule can be pinned to a commit that came from a custom ref if the commit is fetchable. In the experiment, manually fetching `refs/mnemonic/project`, checking out that fetched commit in the submodule, and committing the gitlink worked; a fresh clone's `git submodule update --init` also fetched that exact commit with the local file transport. This is not the same as tracking the custom ref.
- `git submodule update --remote` tracks a remote-tracking branch derived from `submodule.<name>.branch`. Setting that branch to `refs/mnemonic/project` failed in the experiment because Git looked for `refs/remotes/origin/refs/mnemonic/project`. A branch-backed memory ref like `refs/heads/mnemonic/project` would fit submodule tracking more naturally, but it would be a branch, not a custom non-head ref.

## Implementation Implications

- Lowest-risk custom-ref design: introduce a new `GitRefVault` or storage backend rather than bending `Storage`/`GitOps` around hidden worktrees. Use Git plumbing and a temporary index to read the current memory tree, write updated blobs, create a new commit, and atomically update `refs/mnemonic/project` with an expected-old-oid guard.
- Sync would need to stop relying on `git pull --rebase` for project memory and instead fetch/push the custom ref explicitly, likely with conflict handling based on commit ancestry or tree-level merge.
- Recall/list/get can either read from a materialized cache/worktree or from Git objects directly. Direct object reads avoid working-tree churn but require adapting `Storage.listNotes`, `readNote`, atomic writes, deletes, and embedding backfill triggers.
- Imported memory refs should probably be read-only by default and searched after the active project vault but before or alongside the global vault. Write routing into imported refs would require an explicit policy because pushing to another repo's custom namespace is surprising.
- Submodules are probably the wrong primitive for sharing memory refs. Better options are explicit Git remotes/refspecs, `git bundle` import/export, or a separate memory repo branch if branch-like tracking is desired.

## Evidence

- Repository docs: README describes project vault storage in `.mnemonic/` and sync behavior for project vaults.
- Code paths inspected: `src/vault.ts`, `src/storage.ts`, `src/git.ts`, `src/tools/sync.ts`, `src/tools/move-memory.ts`.
- Official Git docs used: <https://git-scm.com/docs/gitrepository-layout.html>, <https://git-scm.com/docs/git-update-ref.html>, <https://git-scm.com/docs/git-commit-tree.html>, <https://git-scm.com/docs/git-write-tree.html>, <https://git-scm.com/docs/git-fetch>, <https://git-scm.com/docs/git-push>, <https://git-scm.com/docs/gitsubmodules>, <https://git-scm.com/docs/git-submodule.html>.
- Local experiments verified: custom ref write via temporary index; explicit fetch of `refs/mnemonic/project`; detached worktree checkout from fetched custom ref; failed `git submodule add -b refs/mnemonic/project`; successful submodule pin to a commit reached through a custom ref; failed `git submodule update --remote` with `.gitmodules` branch set to the full custom ref.
