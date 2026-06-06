import { execFile } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";

import { isValidMemoryId, memoryId, type MemoryId } from "./brands.js";
import { attempt, debugLog, getErrorMessage } from "./error-utils.js";
import { parseNote, serializeNote, type Note } from "./storage.js";

const execFileAsync = promisify(execFile);
const ZERO_OID = "0000000000000000000000000000000000000000";
const MEMORY_REF_PATTERN = /^refs\/mnemonic\/[A-Za-z0-9._/-]+$/;

const mutationLocks = new Map<string, Promise<void>>();

export class InvalidMemoryRefError extends Error {
  constructor(ref: string) {
    super(`Invalid memory ref: ${ref} (must match ${MEMORY_REF_PATTERN.source})`);
    this.name = "InvalidMemoryRefError";
  }
}

export class GitRefConflictError extends Error {
  constructor(ref: string, expected: string | null, actual: string | null) {
    super(
      `Memory ref ${ref} changed: expected ${expected ?? "<missing>"}, got ${actual ?? "<missing>"}`,
    );
    this.name = "GitRefConflictError";
  }
}

export interface GitRefNoteStoreOptions {
  gitRoot: string;
  ref: string;
  notesRelDir?: string;
}

export interface GitRefWriteOptions {
  message: string;
  body?: string;
  upsert?: Note[];
  deleteIds?: MemoryId[];
  expectedOldOid?: string | null;
}

export type GitRefWriteResult =
  | {
      status: "committed";
      oldOid: string | null;
      newOid: string;
      treeHash: string;
    }
  | {
      status: "skipped";
      reason: "no-changes";
      oldOid: string | null;
    };

export class GitRefNoteStore {
  readonly gitRoot: string;
  readonly ref: string;
  readonly notesRelDir: string;

  constructor(options: GitRefNoteStoreOptions) {
    validateMemoryRef(options.ref);
    this.gitRoot = path.resolve(options.gitRoot);
    this.ref = options.ref;
    this.notesRelDir = normalizeNotesRelDir(options.notesRelDir ?? "notes");
  }

  async currentTip(): Promise<string | null> {
    const result = await attempt("git-ref-store:current-tip", async () => {
      const output = await this.git(["rev-parse", "--verify", this.ref]);
      return output.trim();
    });
    return result.ok && result.value ? result.value : null;
  }

  async listNoteIds(): Promise<MemoryId[]> {
    const result = await attempt("git-ref-store:list-note-ids", async () => {
      const output = await this.git([
        "ls-tree",
        "-r",
        "--name-only",
        this.ref,
        "--",
        `${this.notesRelDir}/`,
      ]);
      return output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith(`${this.notesRelDir}/`) && line.endsWith(".md"))
        .map((line) => path.basename(line, ".md"))
        .filter(isValidMemoryId)
        .map(memoryId)
        .sort();
    });

    if (!result.ok) {
      debugLog("git-ref-store:list-note-ids", `failed: ${getErrorMessage(result.error)}`);
      return [];
    }
    return result.value;
  }

  async readNote(id: MemoryId): Promise<Note | null> {
    const notePath = this.noteRelPath(id);
    const result = await attempt("git-ref-store:read-note", async () => {
      const raw = await this.git(["show", `${this.ref}:${notePath}`]);
      return parseNote(id, raw);
    });

    if (!result.ok) {
      debugLog("git-ref-store:read-note", `failed for ${id}: ${getErrorMessage(result.error)}`);
      return null;
    }
    return result.value;
  }

  async write(options: GitRefWriteOptions): Promise<GitRefWriteResult> {
    return this.withMutationLock(async () => {
      const oldOid = await this.currentTip();
      if (options.expectedOldOid !== undefined && options.expectedOldOid !== oldOid) {
        throw new GitRefConflictError(this.ref, options.expectedOldOid, oldOid);
      }

      const upserts = options.upsert ?? [];
      const deleteIds = options.deleteIds ?? [];
      if (upserts.length === 0 && deleteIds.length === 0) {
        return { status: "skipped", reason: "no-changes", oldOid };
      }

      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemonic-git-ref-index-"));
      const indexPath = path.join(tempDir, "index");
      const result = await attempt("git-ref-store:write", () =>
        this.writeWithIndex(tempDir, indexPath, oldOid, upserts, deleteIds, options),
      );
      const cleanup = await attempt("git-ref-store:cleanup-temp", () =>
        fs.rm(tempDir, { recursive: true, force: true }),
      );
      if (!cleanup.ok) {
        debugLog("git-ref-store:cleanup-temp", getErrorMessage(cleanup.error));
      }
      if (result.ok) return result.value;
      throw result.error;
    });
  }

  private async writeWithIndex(
    tempDir: string,
    indexPath: string,
    oldOid: string | null,
    upserts: Note[],
    deleteIds: MemoryId[],
    options: GitRefWriteOptions,
  ): Promise<GitRefWriteResult> {
    if (oldOid) {
      await this.git(["read-tree", `${oldOid}^{tree}`], { GIT_INDEX_FILE: indexPath });
    }

    for (const note of upserts) {
      const blobHash = await this.writeBlob(tempDir, note);
      await this.git(
        ["update-index", "--add", "--cacheinfo", "100644", blobHash, this.noteRelPath(note.id)],
        { GIT_INDEX_FILE: indexPath },
      );
    }

    for (const id of deleteIds) {
      await this.git(["update-index", "--force-remove", this.noteRelPath(id)], {
        GIT_INDEX_FILE: indexPath,
      });
    }

    const treeHash = (await this.git(["write-tree"], { GIT_INDEX_FILE: indexPath })).trim();
    const oldTreeHash = oldOid ? (await this.git(["rev-parse", `${oldOid}^{tree}`])).trim() : null;
    if (treeHash === oldTreeHash) {
      return { status: "skipped", reason: "no-changes", oldOid };
    }

    const commitArgs = ["commit-tree", treeHash];
    if (oldOid) {
      commitArgs.push("-p", oldOid);
    }
    commitArgs.push("-m", options.body ? `${options.message}\n\n${options.body}` : options.message);
    const newOid = (await this.git(commitArgs)).trim();
    await this.git(["update-ref", "--create-reflog", this.ref, newOid, oldOid ?? ZERO_OID]);

    return { status: "committed", oldOid, newOid, treeHash };
  }

  private async writeBlob(tempDir: string, note: Note): Promise<string> {
    const noteFile = path.join(tempDir, `${note.id}.md`);
    await fs.writeFile(noteFile, serializeNote(note), "utf-8");
    return (await this.git(["hash-object", "-w", noteFile])).trim();
  }

  private noteRelPath(id: MemoryId): string {
    return `${this.notesRelDir}/${id}.md`;
  }

  private async git(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    const { stdout } = await execFileAsync("git", args, {
      cwd: this.gitRoot,
      env: { ...process.env, ...env },
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const key = `${this.gitRoot}:${this.ref}`;
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

export function validateMemoryRef(ref: string): void {
  if (
    !MEMORY_REF_PATTERN.test(ref) ||
    ref.includes("..") ||
    ref.endsWith("/") ||
    ref.endsWith(".")
  ) {
    throw new InvalidMemoryRefError(ref);
  }
}

function normalizeNotesRelDir(notesRelDir: string): string {
  return notesRelDir.replace(/^\/+|\/+$/g, "");
}
