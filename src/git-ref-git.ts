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
const ZERO_OID = "0000000000000000000000000000000000000000";

const mutationLocks = new Map<string, Promise<void>>();

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

    const remotes = await this.remoteNames();
    const remote = this.preferredRemote(remotes);
    if (!remote) return { status: "skipped", reason: "no-remote" };

    const pushResult = await attempt("git-ref-git:push", () =>
      this.rawGit(["push", remote, `${this.ref}:${this.ref}`]),
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
    const empty: SyncResult = {
      hasRemote: false,
      pulledNoteIds: [],
      deletedNoteIds: [],
      pushedCommits: 0,
    };

    if (!this.gitEnabled) return empty;

    return this.withRefMutationLock(async () => {
      const remotes = await this.remoteNames();
      const remote = this.preferredRemote(remotes);
      if (!remote) return empty;

      const withRemote: SyncResult = {
        hasRemote: true,
        pulledNoteIds: [],
        deletedNoteIds: [],
        pushedCommits: 0,
      };

      const localBefore = await this.currentRefTip(this.ref);
      const trackingRef = this.remoteTrackingRef(remote);
      const fetchResult = await attempt("git-ref-git:fetch", () =>
        this.rawGit(["fetch", remote, `+${this.ref}:${trackingRef}`]),
      );

      if (!fetchResult.ok) {
        const message = getErrorMessage(fetchResult.error);
        if (!this.isMissingRemoteRef(message)) {
          return { ...withRemote, gitError: { phase: "fetch", message, isConflict: false } };
        }
      }

      const remoteTip = fetchResult.ok ? await this.currentRefTip(trackingRef) : null;

      if (!localBefore && !remoteTip) {
        return withRemote;
      }

      if (!localBefore && remoteTip) {
        const updateResult = await this.updateLocalRef(remoteTip, null);
        if (!updateResult.ok) {
          const message = getErrorMessage(updateResult.error);
          return { ...withRemote, gitError: { phase: "pull", message, isConflict: false } };
        }
        const pulled = await this.diffNoteIds(null, remoteTip);
        return { ...withRemote, ...pulled };
      }

      if (localBefore && !remoteTip) {
        const pushResult = await this.pushLocalRef(remote);
        if (!pushResult.ok) {
          const message = getErrorMessage(pushResult.error);
          return { ...withRemote, gitError: { phase: "push", message, isConflict: false } };
        }
        return {
          ...withRemote,
          pushedCommits: await this.countCommits(null, localBefore),
        };
      }

      if (!localBefore || !remoteTip || localBefore === remoteTip) {
        return withRemote;
      }

      if (await this.isAncestor(localBefore, remoteTip)) {
        const updateResult = await this.updateLocalRef(remoteTip, localBefore);
        if (!updateResult.ok) {
          const message = getErrorMessage(updateResult.error);
          return { ...withRemote, gitError: { phase: "pull", message, isConflict: false } };
        }
        const pulled = await this.diffNoteIds(localBefore, remoteTip);
        return { ...withRemote, ...pulled };
      }

      if (await this.isAncestor(remoteTip, localBefore)) {
        const pushedCommits = await this.countCommits(remoteTip, localBefore);
        const pushResult = await this.pushLocalRef(remote);
        if (!pushResult.ok) {
          const message = getErrorMessage(pushResult.error);
          return { ...withRemote, gitError: { phase: "push", message, isConflict: false } };
        }
        return { ...withRemote, pushedCommits };
      }

      return {
        ...withRemote,
        gitError: {
          phase: "pull",
          message: `Memory ref ${this.ref} diverged from ${remote}/${this.ref}; manual reconciliation is required.`,
          isConflict: false,
        },
      };
    });
  }

  private async rawGit(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd: this.repoPath,
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  }

  private async remoteNames(): Promise<string[]> {
    const remotesResult = await attempt("git-ref-git:remotes", () => this.rawGit(["remote"]));
    return remotesResult.ok
      ? remotesResult.value
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
      : [];
  }

  private preferredRemote(remotes: string[]): string | null {
    return remotes.includes("origin") ? "origin" : (remotes[0] ?? null);
  }

  private async currentRefTip(ref: string): Promise<string | null> {
    const result = await attempt("git-ref-git:current-ref", async () => {
      const output = await this.rawGit(["rev-parse", "--verify", ref]);
      return output.trim();
    });
    return result.ok && result.value ? result.value : null;
  }

  private remoteTrackingRef(remote: string): string {
    const refTail = this.ref.replace(/^refs\/mnemonic\//, "");
    const safeRemote = remote.replace(/[^A-Za-z0-9._/-]/g, "-").replace(/^\/+|\/+$/g, "");
    const safeTail = refTail.replace(/[^A-Za-z0-9._/-]/g, "-").replace(/^\/+|\/+$/g, "");
    return `refs/mnemonic/remotes/${safeRemote}/${safeTail}`;
  }

  private isMissingRemoteRef(message: string): boolean {
    return (
      message.includes("couldn't find remote ref") ||
      message.includes("could not find remote ref") ||
      message.includes("fatal: couldn't find remote ref")
    );
  }

  private updateLocalRef(newOid: string, oldOid: string | null) {
    return attempt("git-ref-git:update-ref", () =>
      this.rawGit(["update-ref", "--create-reflog", this.ref, newOid, oldOid ?? ZERO_OID]),
    );
  }

  private pushLocalRef(remote: string) {
    return attempt("git-ref-git:push", () =>
      this.rawGit(["push", remote, `${this.ref}:${this.ref}`]),
    );
  }

  private async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const result = await attempt("git-ref-git:is-ancestor", () =>
      this.rawGit(["merge-base", "--is-ancestor", ancestor, descendant]),
    );
    return result.ok;
  }

  private async countCommits(fromOid: string | null, toOid: string): Promise<number> {
    const revision = fromOid ? `${fromOid}..${toOid}` : toOid;
    const result = await attempt("git-ref-git:count-commits", async () => {
      const output = await this.rawGit(["rev-list", "--count", revision]);
      return parseInt(output.trim(), 10) || 0;
    });
    return result.ok ? result.value : 0;
  }

  private async diffNoteIds(
    fromOid: string | null,
    toOid: string | null,
  ): Promise<{ pulledNoteIds: string[]; deletedNoteIds: string[] }> {
    if (!fromOid && !toOid) return { pulledNoteIds: [], deletedNoteIds: [] };

    const prefix = `${this.storage.notesRelDir}/`;
    if (!fromOid && toOid) {
      const result = await attempt("git-ref-git:list-pulled-notes", () =>
        this.rawGit(["ls-tree", "-r", "--name-only", toOid, "--", `${prefix}`]),
      );
      return {
        pulledNoteIds: result.ok ? this.noteIdsFromPaths(result.value.split("\n"), prefix) : [],
        deletedNoteIds: [],
      };
    }

    if (fromOid && !toOid) {
      const result = await attempt("git-ref-git:list-deleted-notes", () =>
        this.rawGit(["ls-tree", "-r", "--name-only", fromOid, "--", `${prefix}`]),
      );
      return {
        pulledNoteIds: [],
        deletedNoteIds: result.ok ? this.noteIdsFromPaths(result.value.split("\n"), prefix) : [],
      };
    }

    if (!fromOid || !toOid) return { pulledNoteIds: [], deletedNoteIds: [] };

    const result = await attempt("git-ref-git:diff-notes", () =>
      this.rawGit(["diff", "--name-status", fromOid, toOid, "--", `${prefix}`]),
    );
    if (!result.ok) {
      debugLog("git-ref-git:diff-notes", getErrorMessage(result.error));
      return { pulledNoteIds: [], deletedNoteIds: [] };
    }

    const pulledNoteIds = new Set<string>();
    const deletedNoteIds = new Set<string>();
    for (const line of result.value.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;

      const status = parts[0];
      const filePath = parts[parts.length - 1];
      if (!status || !filePath?.startsWith(prefix) || !filePath.endsWith(".md")) continue;

      const id = filePath.replace(prefix, "").replace(/\.md$/, "");
      if (status === "D") {
        deletedNoteIds.add(id);
      } else if (status === "A" || status === "M" || status.startsWith("R")) {
        pulledNoteIds.add(id);
      }
    }

    return {
      pulledNoteIds: [...pulledNoteIds].sort(),
      deletedNoteIds: [...deletedNoteIds].sort(),
    };
  }

  private noteIdsFromPaths(paths: string[], prefix: string): string[] {
    return paths
      .map((line) => line.trim())
      .filter((line) => line.startsWith(prefix) && line.endsWith(".md"))
      .map((line) => line.replace(prefix, "").replace(/\.md$/, ""))
      .sort();
  }

  private async withRefMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const key = `${this.repoPath}:${this.ref}`;
    const previous = mutationLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    mutationLocks.set(key, current);
    await previous;

    return operation().finally(() => {
      release();
      if (mutationLocks.get(key) === current) {
        mutationLocks.delete(key);
      }
    });
  }
}
