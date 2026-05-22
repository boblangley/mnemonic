import { describe, expect, it, vi } from "vitest";
import { WorktreeVaultHistory } from "../src/vault-history.js";
import type { CommitStats, LastCommit } from "../src/git.js";

describe("WorktreeVaultHistory", () => {
  it("maps note ids to filesystem vault paths for last commit lookups", async () => {
    const commit: LastCommit = {
      hash: "abc123",
      message: "update: test",
      timestamp: "2026-01-01T00:00:00.000Z",
    };
    const git = {
      getLastCommit: vi.fn().mockResolvedValue(commit),
      getFileHistory: vi.fn(),
      getCommitStats: vi.fn(),
    };
    const history = new WorktreeVaultHistory(git, ".mnemonic/notes");

    await expect(history.getLastCommit("note-1")).resolves.toEqual(commit);

    expect(git.getLastCommit).toHaveBeenCalledWith(".mnemonic/notes/note-1.md");
  });

  it("maps note ids to filesystem vault paths for history lookups", async () => {
    const commits: LastCommit[] = [{
      hash: "abc123",
      message: "remember: test",
      timestamp: "2026-01-01T00:00:00.000Z",
    }];
    const git = {
      getLastCommit: vi.fn(),
      getFileHistory: vi.fn().mockResolvedValue(commits),
      getCommitStats: vi.fn(),
    };
    const history = new WorktreeVaultHistory(git, "notes");

    await expect(history.getFileHistory("note-2", 3)).resolves.toEqual(commits);

    expect(git.getFileHistory).toHaveBeenCalledWith("notes/note-2.md", 3);
  });

  it("maps note ids to filesystem vault paths for commit stats", async () => {
    const stats: CommitStats = {
      additions: 2,
      deletions: 1,
      filesChanged: 1,
    };
    const git = {
      getLastCommit: vi.fn(),
      getFileHistory: vi.fn(),
      getCommitStats: vi.fn().mockResolvedValue(stats),
    };
    const history = new WorktreeVaultHistory(git, ".mnemonic-lib/notes");

    await expect(history.getCommitStats("note-3", "def456")).resolves.toEqual(stats);

    expect(git.getCommitStats).toHaveBeenCalledWith(".mnemonic-lib/notes/note-3.md", "def456");
  });
});
