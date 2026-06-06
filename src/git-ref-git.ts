import { execFile } from "child_process";
import path from "path";
import { promisify } from "util";

import { attempt, debugLog, getErrorMessage } from "./error-utils.js";
import {
  GitOperationError,
  GitOps,
  type CommitResult,
  type PushResult,
  type SyncResult,
} from "./git.js";
import { GitRefStorage } from "./git-ref-storage.js";

const execFileAsync = promisify(execFile);

export class GitRefGitOps extends GitOps {
  private readonly repoPath: string;
  private readonly ref: string;
  private readonly storage: GitRefStorage;
  private readonly gitEnabled: boolean;

  constructor(gitRoot: string, ref: string, storage: GitRefStorage) {
    super(gitRoot, storage.notesRelDir);
    this.repoPath = path.resolve(gitRoot);
    this.ref = ref;
    this.storage = storage;
    this.gitEnabled = process.env["DISABLE_GIT"] !== "true";
  }

  override async commit(message: string, files: string[], body?: string): Promise<boolean> {
    void files;
    const result = await this.commitWithStatus(message, [], body);
    if (result.status === "failed") {
      throw new GitOperationError("commit", result.error);
    }
    return result.status === "committed";
  }

  override async commitWithStatus(
    message: string,
    files: string[],
    body?: string,
  ): Promise<CommitResult> {
    void files;
    if (!this.gitEnabled) return { status: "skipped", reason: "git-disabled" };
    if (!this.storage.hasPendingNoteChanges()) return { status: "skipped", reason: "no-changes" };

    const result = await attempt("git-ref-git:commit", () =>
      this.storage.flushPendingNotes(message, body),
    );
    if (!result.ok) {
      const error = getErrorMessage(result.error);
      debugLog("git-ref-git:commit", error);
      return { status: "failed", reason: "error", operation: "commit", error };
    }

    return result.value.status === "committed"
      ? { status: "committed" }
      : { status: "skipped", reason: "no-changes" };
  }

  override async status(): Promise<{ staged: string[]; modified: string[] }> {
    if (!this.gitEnabled) return { staged: [], modified: [] };
    return { staged: this.storage.pendingNotePaths(), modified: [] };
  }

  override async push(): Promise<void> {
    const result = await this.pushWithStatus();
    if (result.status === "failed") {
      throw new GitOperationError("push", result.error);
    }
  }

  override async pushWithStatus(): Promise<PushResult> {
    if (!this.gitEnabled) return { status: "skipped", reason: "git-disabled" };

    const remotesResult = await attempt("git-ref-git:remotes", () => this.rawGit(["remote"]));
    const remotes = remotesResult.ok
      ? remotesResult.value
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
      : [];
    if (remotes.length === 0) return { status: "skipped", reason: "no-remote" };

    const pushResult = await attempt("git-ref-git:push", () =>
      this.rawGit(["push", "origin", `${this.ref}:${this.ref}`]),
    );
    if (!pushResult.ok) {
      return { status: "failed", error: getErrorMessage(pushResult.error) };
    }
    return { status: "pushed" };
  }

  override async pushBranch(branch: string): Promise<PushResult> {
    void branch;
    return this.pushWithStatus();
  }

  override async sync(): Promise<SyncResult> {
    return {
      hasRemote: false,
      pulledNoteIds: [],
      deletedNoteIds: [],
      pushedCommits: 0,
    };
  }

  private async rawGit(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd: this.repoPath,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  }
}
