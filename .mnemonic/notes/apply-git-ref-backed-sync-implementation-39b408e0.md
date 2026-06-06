---
title: 'Apply: Git ref-backed sync implementation'
tags:
  - workflow
  - apply
  - git
  - project-memory
  - vault
  - sync
lifecycle: temporary
createdAt: '2026-06-06T05:18:40.838Z'
updatedAt: '2026-06-06T05:18:40.838Z'
role: summary
alwaysLoad: false
project: github-com-boblangley-mnemonic
projectName: mnemonic
memoryVersion: 1
---
Implemented real `GitRefGitOps.sync()` for the custom-ref project memory backend.

The implementation fetches the remote memory ref into a separate `refs/mnemonic/remotes/<remote>/...` tracking ref so fetch does not overwrite the active local memory ref. Sync now handles empty-local pull, remote-missing push, fast-forward pull with `pulledNoteIds` and `deletedNoteIds`, local-ahead push with `pushedCommits`, and divergent refs as a non-conflict pull error requiring manual reconciliation.

Verification passed on 2026-06-06: focused ref-backend regression bundle, `npm run build`, and local MCP smoke using `npm run mcp:local` with `detect_project` for `/workspaces/mnemonic`.
