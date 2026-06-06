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

async function bareGit(gitDir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["--git-dir", gitDir, ...args]);
  return stdout;
}

async function createRefVault(
  repoPath: string,
  vaultPath: string,
): Promise<{
  storage: GitRefStorage;
  gitOps: GitRefGitOps;
}> {
  const storage = new GitRefStorage(
    new Storage(vaultPath),
    new GitRefNoteStore({
      gitRoot: repoPath,
      ref: "refs/mnemonic/project",
    }),
  );
  await storage.init();
  return {
    storage,
    gitOps: new GitRefGitOps(repoPath, "refs/mnemonic/project", storage),
  };
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

      const remoteTip = await bareGit(bareDir, ["rev-parse", "--verify", "refs/mnemonic/project"]);
      expect(remoteTip.trim()).toHaveLength(40);
    } finally {
      await fs.rm(bareDir, { recursive: true, force: true });
    }
  });

  it("sync pulls a remote custom ref into an empty local ref", async () => {
    const bareDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemonic-git-ref-git-bare-"));
    const producerRepoDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "mnemonic-git-ref-git-producer-"),
    );
    const producerVaultDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "mnemonic-git-ref-git-producer-local-"),
    );
    try {
      await git(bareDir, ["init", "--bare"]);
      await git(repoDir, ["remote", "add", "origin", bareDir]);
      await git(producerRepoDir, ["init"]);
      await git(producerRepoDir, ["config", "user.email", "producer@example.com"]);
      await git(producerRepoDir, ["config", "user.name", "Producer"]);
      await git(producerRepoDir, ["remote", "add", "origin", bareDir]);

      const producer = await createRefVault(producerRepoDir, producerVaultDir);
      await producer.storage.writeNote(makeNote("alpha-note"));
      await expect(producer.gitOps.commitWithStatus("remember: alpha note", [])).resolves.toEqual({
        status: "committed",
      });
      await expect(producer.gitOps.pushWithStatus()).resolves.toEqual({ status: "pushed" });

      await expect(gitOps.sync()).resolves.toEqual({
        hasRemote: true,
        pulledNoteIds: ["alpha-note"],
        deletedNoteIds: [],
        pushedCommits: 0,
      });
      await expect(storage.readNote(memoryId("alpha-note"))).resolves.toMatchObject({
        id: memoryId("alpha-note"),
      });
    } finally {
      await fs.rm(bareDir, { recursive: true, force: true });
      await fs.rm(producerRepoDir, { recursive: true, force: true });
      await fs.rm(producerVaultDir, { recursive: true, force: true });
    }
  });

  it("sync pushes a local custom ref when the remote ref is missing", async () => {
    const bareDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemonic-git-ref-git-bare-"));
    try {
      await git(bareDir, ["init", "--bare"]);
      await git(repoDir, ["remote", "add", "origin", bareDir]);
      await storage.writeNote(makeNote("alpha-note"));
      await expect(gitOps.commitWithStatus("remember: alpha note", [])).resolves.toEqual({
        status: "committed",
      });

      await expect(gitOps.sync()).resolves.toEqual({
        hasRemote: true,
        pulledNoteIds: [],
        deletedNoteIds: [],
        pushedCommits: 1,
      });

      const remoteTip = await bareGit(bareDir, ["rev-parse", "--verify", "refs/mnemonic/project"]);
      expect(remoteTip.trim()).toHaveLength(40);
    } finally {
      await fs.rm(bareDir, { recursive: true, force: true });
    }
  });

  it("sync fast-forwards from remote and reports deleted note ids", async () => {
    const bareDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemonic-git-ref-git-bare-"));
    const producerRepoDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "mnemonic-git-ref-git-producer-"),
    );
    const producerVaultDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "mnemonic-git-ref-git-producer-local-"),
    );
    try {
      await git(bareDir, ["init", "--bare"]);
      await git(repoDir, ["remote", "add", "origin", bareDir]);
      await git(producerRepoDir, ["init"]);
      await git(producerRepoDir, ["config", "user.email", "producer@example.com"]);
      await git(producerRepoDir, ["config", "user.name", "Producer"]);
      await git(producerRepoDir, ["remote", "add", "origin", bareDir]);

      await storage.writeNote(makeNote("alpha-note"));
      await storage.writeNote(makeNote("beta-note"));
      await expect(gitOps.commitWithStatus("remember: seed notes", [])).resolves.toEqual({
        status: "committed",
      });
      await expect(gitOps.pushWithStatus()).resolves.toEqual({ status: "pushed" });

      const producer = await createRefVault(producerRepoDir, producerVaultDir);
      await expect(producer.gitOps.sync()).resolves.toMatchObject({
        hasRemote: true,
        pulledNoteIds: ["alpha-note", "beta-note"],
      });
      await expect(producer.storage.deleteNote(memoryId("alpha-note"))).resolves.toBe(true);
      await expect(producer.gitOps.commitWithStatus("forget: alpha note", [])).resolves.toEqual({
        status: "committed",
      });
      await expect(producer.gitOps.pushWithStatus()).resolves.toEqual({ status: "pushed" });

      await expect(gitOps.sync()).resolves.toEqual({
        hasRemote: true,
        pulledNoteIds: [],
        deletedNoteIds: ["alpha-note"],
        pushedCommits: 0,
      });
      await expect(storage.readNote(memoryId("alpha-note"))).resolves.toBeNull();
      await expect(storage.readNote(memoryId("beta-note"))).resolves.toMatchObject({
        id: memoryId("beta-note"),
      });
    } finally {
      await fs.rm(bareDir, { recursive: true, force: true });
      await fs.rm(producerRepoDir, { recursive: true, force: true });
      await fs.rm(producerVaultDir, { recursive: true, force: true });
    }
  });
});
