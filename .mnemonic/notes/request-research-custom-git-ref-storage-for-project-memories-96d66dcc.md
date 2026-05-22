---
title: 'Request: Research custom git ref storage for project memories'
tags:
  - workflow
  - request
lifecycle: temporary
createdAt: '2026-05-22T17:45:39.150Z'
updatedAt: '2026-05-22T17:58:46.206Z'
role: context
alwaysLoad: false
project: github-com-danielmarbach-mnemonic
projectName: mnemonic
relatedTo:
  - id: research-custom-git-refs-for-project-memory-storage-9d7d5aa5
    type: derives-from
  - id: research-feature-impact-of-optional-git-ref-memory-backend-e6aa4449
    type: derives-from
memoryVersion: 1
---
Research request: evaluate moving project-level mnemonic memories into a custom Git ref, whether memories can be pulled from other repositories via Git, and whether Git can submodule a ref.

User wants research first, not implementation. Key questions:

- Can project-level memories live in a custom Git ref instead of the working tree?
- Can memory sets be imported or synchronized from other repositories via Git?
- Is there a way to use submodules with a custom ref directly?

Follow the RPIR workflow: present research findings and confirm direction before planning.
