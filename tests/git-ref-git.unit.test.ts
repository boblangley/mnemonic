import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";

import { isoDateString, memoryId } from "../src/brands.js";
import { GitRefGitOps } from "../src/git-ref-git.js";
import { GitRefNoteStore } from "../src/git-ref-note-store.js";
import { GitRefStorage } from "../src/git-ref-storage.js";
import { Storage, type Note } from "../src/storage.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

function makeNote(id: string, overrides: Partial<Note> = {}): Note {
  const now = isoDateString("2026-01-01T00:00:00.000Z");
  return {
    id: memoryId(id),
    title: id,
    content: `Body for ${id}`,
    tags: ["git-ref"],
    lifecycle: "permanent",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("GitRefGitOps", () => {
  let repoDir: string;
  let localVaultDir: string;
  let storage: GitRefStorage;
  let gitOps: GitRefGitOps;

  beforeEach(async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemonic-git-ref-git-repo-"));
    localVaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemonic-git-ref-git-local-"));
    await git(repoDir, ["init"]);
    await git(repoDir, ["config", "user.email", "test@example.com"]);
    await git(repoDir, ["config", "user.name", "Test User"]);

    storage = new GitRefStorage(
      new Storage(localVaultDir),
      new GitRefNoteStore({
        gitRoot: repoDir,
        ref: "refs/mnemonic/project",
      }),
    );
    await storage.init();
    gitOps = new GitRefGitOps(repoDir, "refs/mnemonic/project", storage);
  });

  afterEach(async () => {
    await fs.rm(repoDir, { recursive: true, force: true });
    await fs.rm(localVaultDir, { recursive: true, force: true });
  });

  it("reports pending ref-backed note paths as staged status", async () => {
    await storage.writeNote(makeNote("alpha-note"));
    await storage.deleteNote(memoryId("missing-note"));

    await expect(gitOps.status()).resolves.toEqual({
      staged: ["notes/alpha-note.md", "notes/missing-note.md"],
      modified: [],
    });
  });

  it("commits pending storage changes to the custom ref with the supplied message", async () => {
    await storage.writeNote(makeNote("alpha-note"));

    await expect(
      gitOps.commitWithStatus("remember: alpha note", ["notes/alpha-note.md"], "body text"),
    ).resolves.toEqual({ status: "committed" });
    await expect(storage.hasPendingNoteChanges()).toBe(false);

    const log = await git(repoDir, ["log", "-1", "--format=%s%n%b", "refs/mnemonic/project"]);
    expect(log).toContain("remember: alpha note");
    expect(log).toContain("body text");

    const refStore = new GitRefNoteStore({
      gitRoot: repoDir,
      ref: "refs/mnemonic/project",
    });
    await expect(refStore.readNote(memoryId("alpha-note"))).resolves.toMatchObject({
      id: memoryId("alpha-note"),
    });
  });

  it("skips commit when storage has no pending note changes", async () => {
    await expect(gitOps.commitWithStatus("noop", [])).resolves.toEqual({
      status: "skipped",
      reason: "no-changes",
    });
  });

  it("pushes the custom ref with an explicit refspec", async () => {
    const bareDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemonic-git-ref-git-bare-"));
    try {
      await git(bareDir, ["init", "--bare"]);
      await git(repoDir, ["remote", "add", "origin", bareDir]);
      await storage.writeNote(makeNote("alpha-note"));
      await gitOps.commitWithStatus("remember: alpha note", []);

      await expect(gitOps.pushWithStatus()).resolves.toEqual({ status: "pushed" });

      const { stdout: remoteTip } = await execFileAsync("git", [
        "--git-dir",
        bareDir,
        "rev-parse",
        "--verify",
        "refs/mnemonic/project",
      ]);
      expect(remoteTip.trim()).toHaveLength(40);
    } finally {
      await fs.rm(bareDir, { recursive: true, force: true });
    }
  });
});
