import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";

import {
  embeddingDimensions,
  embeddingMetric,
  embeddingModelId,
  embeddingProviderId,
  isoDateString,
  memoryId,
} from "../src/brands.js";
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

describe("GitRefStorage", () => {
  let repoDir: string;
  let localVaultDir: string;
  let storage: GitRefStorage;

  beforeEach(async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemonic-git-ref-storage-repo-"));
    localVaultDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemonic-git-ref-storage-local-"));
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
  });

  afterEach(async () => {
    await fs.rm(repoDir, { recursive: true, force: true });
    await fs.rm(localVaultDir, { recursive: true, force: true });
  });

  it("stages note writes and flushes them to the custom ref", async () => {
    await storage.writeNote(makeNote("alpha-note"));

    await expect(storage.readNote(memoryId("alpha-note"))).resolves.toMatchObject({
      id: memoryId("alpha-note"),
      content: "Body for alpha-note",
    });
    await expect(
      git(repoDir, ["rev-parse", "--verify", "refs/mnemonic/project"]),
    ).rejects.toThrow();

    const result = await storage.flushPendingNotes("remember: alpha note");
    expect(result.status).toBe("committed");
    await expect(fs.stat(path.join(repoDir, "notes"))).rejects.toThrow();

    const nextStorage = new GitRefStorage(
      new Storage(localVaultDir),
      new GitRefNoteStore({
        gitRoot: repoDir,
        ref: "refs/mnemonic/project",
      }),
    );
    await nextStorage.init();
    await expect(nextStorage.readNote(memoryId("alpha-note"))).resolves.toMatchObject({
      id: memoryId("alpha-note"),
      title: "alpha-note",
    });
  });

  it("stages deletes and flushes them to the custom ref", async () => {
    await storage.writeNote(makeNote("alpha-note"));
    await storage.writeNote(makeNote("beta-note"));
    await storage.flushPendingNotes("remember: seed notes");

    await expect(storage.deleteNote(memoryId("alpha-note"))).resolves.toBe(true);
    await expect(storage.readNote(memoryId("alpha-note"))).resolves.toBeNull();
    await expect(storage.listNoteIds()).resolves.toEqual([memoryId("beta-note")]);

    await storage.flushPendingNotes("forget: alpha note");

    const nextStorage = new GitRefStorage(
      new Storage(localVaultDir),
      new GitRefNoteStore({
        gitRoot: repoDir,
        ref: "refs/mnemonic/project",
      }),
    );
    await nextStorage.init();
    await expect(nextStorage.listNoteIds()).resolves.toEqual([memoryId("beta-note")]);
  });

  it("rolls back staged atomic note writes to the pre-atomic pending state", async () => {
    await storage.writeNote(makeNote("before-atomic"));
    await storage.beginAtomicNotesWrite();
    await storage.writeNote(makeNote("inside-atomic"));
    await storage.deleteNote(memoryId("before-atomic"));

    await expect(storage.listNoteIds()).resolves.toEqual([memoryId("inside-atomic")]);

    await storage.rollbackAtomicNotesWrite();

    await expect(storage.listNoteIds()).resolves.toEqual([memoryId("before-atomic")]);
    await expect(storage.readNote(memoryId("inside-atomic"))).resolves.toBeNull();
  });

  it("delegates embeddings and projections to local storage", async () => {
    await storage.writeEmbedding({
      id: memoryId("alpha-note"),
      model: embeddingModelId("test-model"),
      provider: embeddingProviderId("test-provider"),
      dimensions: embeddingDimensions(2),
      metric: embeddingMetric("cosine"),
      embedding: [0.1, 0.2],
      updatedAt: isoDateString("2026-01-01T00:00:00.000Z"),
    });
    await storage.writeProjection({
      noteId: "alpha-note",
      title: "Alpha",
      summary: "Alpha",
      headings: [],
      tags: ["git-ref"],
      updatedAt: "2026-01-01T00:00:00.000Z",
      projectionText: "Title: Alpha",
      generatedAt: "2026-01-01T00:00:00.000Z",
    });

    await expect(storage.readEmbedding(memoryId("alpha-note"))).resolves.toMatchObject({
      id: memoryId("alpha-note"),
      embedding: [0.1, 0.2],
    });
    await expect(storage.readProjection(memoryId("alpha-note"))).resolves.toMatchObject({
      noteId: "alpha-note",
      summary: "Alpha",
    });
  });

  it("reports no changes when flushing without pending note writes", async () => {
    await expect(storage.flushPendingNotes("noop")).resolves.toMatchObject({
      status: "skipped",
      reason: "no-changes",
      oldOid: null,
    });
  });
});
