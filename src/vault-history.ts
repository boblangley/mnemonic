import type { CommitStats, GitOps, LastCommit } from "./git.js";

export interface VaultHistory {
  getLastCommit(noteId: string): Promise<LastCommit | null>;
  getFileHistory(noteId: string, limit?: number): Promise<LastCommit[]>;
  getCommitStats(noteId: string, commitHash: string): Promise<CommitStats | null>;
}

type PathBackedGitHistory = Pick<GitOps, "getLastCommit" | "getFileHistory" | "getCommitStats">;

export class WorktreeVaultHistory implements VaultHistory {
  constructor(
    private readonly git: PathBackedGitHistory,
    private readonly notesRelDir: string,
  ) {}

  getLastCommit(noteId: string): Promise<LastCommit | null> {
    return this.git.getLastCommit(this.noteRelPath(noteId));
  }

  getFileHistory(noteId: string, limit?: number): Promise<LastCommit[]> {
    return this.git.getFileHistory(this.noteRelPath(noteId), limit);
  }

  getCommitStats(noteId: string, commitHash: string): Promise<CommitStats | null> {
    return this.git.getCommitStats(this.noteRelPath(noteId), commitHash);
  }

  private noteRelPath(noteId: string): string {
    return `${this.notesRelDir}/${noteId}.md`;
  }
}
