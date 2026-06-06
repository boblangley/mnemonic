---
title: 'Research: feature impact of optional Git ref memory backend'
tags:
  - workflow
  - research
  - git
  - project-memory
  - architecture
lifecycle: temporary
createdAt: '2026-05-22T17:58:38.575Z'
updatedAt: '2026-06-06T04:13:08.128Z'
role: research
alwaysLoad: false
project: github-com-danielmarbach-mnemonic
projectName: mnemonic
relatedTo:
  - id: request-research-custom-git-ref-storage-for-project-memories-96d66dcc
    type: derives-from
  - id: research-custom-git-refs-for-project-memory-storage-9d7d5aa5
    type: follows
  - id: plan-backend-neutral-vault-history-abstraction-for-custom-re-99f14851
    type: derives-from
  - id: optional-git-ref-project-memory-backend-architecture-9dfce64a
    type: supersedes
memoryVersion: 1
---
A custom Git ref backend should be modeled as an optional project-storage pathway, not a replacement for the existing `.mnemonic/` project vault. The existing filesystem project vault remains the compatibility baseline; the new pathway adds `refs/mnemonic/<project>` for writable project memories and read-only imported memory refs such as `refs/mnemonic/imports/<alias>/<name>`.

## Architecture Framing

- Current architecture is file-first: `Vault` owns `Storage` plus `GitOps`; project vaults are directories like `.mnemonic/` in the project working tree.
- Optional custom-ref architecture needs a storage abstraction boundary below tools: tools should continue asking for visible vaults and write targets, while the vault implementation decides whether notes are backed by filesystem paths or Git objects under a ref.
- Imports should be read-only vaults by default. They can participate in recall, list, get, relationship preview, and summaries, but should be excluded from mutating flows unless an explicit future write/import policy exists.
- The safest rollout is additive: keep existing `project-vault` behavior, introduce a new storage label such as `project-ref-vault` or `import-ref:<alias>`, and let project memory policy select the backend.

## Feature Impact

### Vault Discovery And Routing

Current `VaultManager` discovers the main vault, `.mnemonic/`, and `.mnemonic-*` sub-vault directories. A ref backend needs discovery from Git config or mnemonic config rather than directory scanning. Search order should become: active writable project storage, imported read-only ref vaults, project-associated main-vault notes, global main-vault notes. Existing `scope` semantics should stay about project association, while `storedIn` needs new labels for ref-backed storage.

### Remember And Update

`remember` and `update` can preserve their public behavior if they write through a storage interface. The ref-backed implementation must create commits under the memory ref without staging normal worktree files. It also needs compare-and-swap ref updates using the previous ref oid to prevent clobbering concurrent updates. Imported read-only vaults must reject updates with a clear error.

### Forget, Relate, Unrelate, And Relationship Cleanup

Deletes and relationship edits are normal note rewrites, so they can work on the writable ref backend. The harder case is cross-vault cleanup: deleting a note currently scans all known vaults and rewrites relationships pointing at it. That must skip read-only imported refs or report that dangling imported relationships remain externally owned. Relationship previews can still read imported refs.

### Move Memory

`move_memory` currently moves between main and project filesystem vaults, optionally sub-vault folders. It would need explicit target variants for `project-ref-vault` and should reject moves into read-only imports. Moving from `.mnemonic/` to the ref backend is a migration operation because it changes where shared project memory lives.

### Recall

Recall should benefit from imports, but only if imported notes have local embeddings. The read path can treat ref-backed notes as normal notes after materialization or object-backed parsing. Ranking should annotate source labels so imported memories do not masquerade as active project decisions. Project boost should apply to active-project notes; imported refs should probably get a smaller or no boost unless their note frontmatter project matches the active project.

### Temporal Recall And Provenance

Temporal mode currently uses `git log --follow -- <file>` and per-file commit stats. Ref-backed notes do not have worktree paths in `HEAD`, so provenance must become backend-specific: log commits reachable from the memory ref and inspect changes for `notes/<id>.md` inside that ref history. This is one of the biggest feature impacts. Commit messages can stay structured, but should remain advisory metadata.

### Project Memory Summary

`project_memory_summary` mostly uses visible notes, relationships, metadata, and embeddings, so it can work if the vault abstraction supplies normal note lists and provenance. Counts need clearer buckets: filesystem project vault, ref project vault, imported refs, and main-vault project-associated notes. Maintenance warnings should avoid suggesting mutation actions against imported read-only notes.

### List, Recent, Get, Where Is, Memory Graph, Discover Tags

These are mostly read/list operations and should adapt well. `recent_memories` sorts by note `updatedAt`, so it does not require Git history. `where_is_memory` and list output need new storage labels. `memory_graph` should include imported relationships but mark source vaults clearly. `discover_tags` can include imported tags as inventory context, but should avoid learning write defaults from read-only imports.

### Consolidate

Analysis modes can include imported refs as evidence, but mutating modes must not merge, supersede, prune, or clean up read-only imported notes. `execute-merge` needs a clear writable target policy: active project backend or main vault. If imported notes are sources, the canonical note should cite them as evidence without trying to alter them.

### Sync

This is the largest architectural change. Current project sync is `fetch -> pull --rebase -> diff .mnemonic/notes -> push`. Ref backend sync should fetch and push explicit refspecs, diff old and new memory ref tips for changed note ids, then rebuild embeddings. Imports should be fetch-only. Normal `git fetch` can retrieve custom refs if mnemonic configures additional `remote.<name>.fetch` refspecs, but the MCP `sync` tool still needs to know which refs were updated and which embeddings to rebuild.

### Embeddings And Projections

Embeddings and projections remain derived local artifacts. For ref-backed notes, they should live in a local cache keyed by source identity plus ref plus note id, not inside the memory ref. Projection staleness can still use note `updatedAt`, but imported refs may contain note ids that collide with local notes, so cache keys must include vault/source identity.

### Migrations

Migrations currently assume a writable filesystem vault with `config.json` and atomic staging directories. Ref-backed writable vaults need migration support through the same storage interface, but schema version storage is a design choice: store it inside the memory ref as `config.json`, or keep backend config in main vault. Read-only imports should report schema version and pending migrations if detectable, but not execute migrations unless explicitly cloned/promoted to a writable source.

### Config, Policies, And Project Identity

Project policy should grow from write scope only to include project storage backend, for example filesystem project vault vs Git ref project vault. Imported refs should be configured separately from project identity: a project can have one active writable memory backend and many imported read-only memory sources. Remote identity overrides still matter for project id detection, but import aliases should be stable and user-chosen.

### Protected Branches And Branch Switching

A memory ref backend decouples memory writes from the current code branch. Protected branch policy may need reinterpretation: it might be irrelevant because `HEAD` is not being committed, or it might still guard writes in repos where memory refs are treated as shared project state. Branch-change auto-sync currently syncs main and project vaults; it should sync the active memory ref and imports, but avoid coupling imported memory freshness to every branch switch if that becomes noisy.

### PR Description And CI Workflows

The PR updater currently detects changed `.mnemonic/notes/*.md` files. Ref-backed memory commits will not appear as normal PR file changes. CI support needs a different mechanism: compare memory ref tips associated with a PR, generate notes from a memory-ref diff, or keep filesystem notes for PR-authored design decisions. This is a major product choice because the current design makes decision notes visible in code review.

### Dogfooding And Tests

Dogfooding runners copy `.mnemonic/` into isolated workspaces. Ref-backed dogfooding needs fixture refs or a materialized cache. Integration tests around vault routing, sync, migrations, temporal recall, and PR description generation will need parallel coverage for both filesystem and ref backends.

### User Experience

The optional pathway should be explicit and inspectable. Users need commands or tools to enable ref-backed project memory, add read-only imports, list configured imports, fetch/rebuild embeddings, and explain where a memory lives. The old `.mnemonic/` path should continue to work without migration.

## Recommended Shape

- Introduce a vault/storage backend interface before adding feature behavior.
- Preserve `.mnemonic/` as the default project backend.
- Add `project-ref` as an opt-in project policy backend.
- Add read-only import refs as separate visible vaults with clear storage labels.
- Make sync backend-aware: filesystem vaults use existing pull/rebase; ref vaults use explicit fetch/push/diff of memory refs.
- Treat temporal provenance, migrations, and PR description integration as first-class design items rather than follow-up polish.

## Open Questions

- Should protected branch policy apply to memory refs, or should memory refs have their own protection policy?
- Should PR workflows continue requiring filesystem note changes for review visibility, or should CI learn to diff memory refs?
- Should imported refs be searched by default or only when explicitly enabled per project?
- Where should ref-backed derived artifacts live: `.git/mnemonic-cache`, main vault cache, or a project-local ignored directory?
- Should schema version live inside the memory ref to travel with notes, or outside in local config to avoid mutating imported sources?
