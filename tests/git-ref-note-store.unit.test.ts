import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";

import { memoryId, isoDateString } from "../src/brands.js";
import {
  GitRefConflictError,
  GitRefNoteStore,
  InvalidMemoryRefError,
  validateMemoryRef,
} from "../src/git-ref-note-store.js";
import type { Note } from "../src/storage.js";

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

describe("GitRefNoteStore", () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemonic-git-ref-store-"));
    await git(repoDir, ["init"]);
    await git(repoDir, ["config", "user.email", "test@example.com"]);
    await git(repoDir, ["config", "user.name", "Test User"]);
  });

  afterEach(async () => {
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  it("validates memory ref names", () => {
    expect(() => validateMemoryRef("refs/mnemonic/project")).not.toThrow();
    expect(() => validateMemoryRef("refs/heads/main")).toThrow(InvalidMemoryRefError);
    expect(() => validateMemoryRef("refs/mnemonic/bad..ref")).toThrow(InvalidMemoryRefError);
    expect(() => validateMemoryRef("refs/mnemonic/trailing/")).toThrow(InvalidMemoryRefError);
  });

  it("writes notes to a custom ref without adding worktree files", async () => {
    const store = new GitRefNoteStore({
      gitRoot: repoDir,
      ref: "refs/mnemonic/project",
    });

    const result = await store.write({
      message: "remember: ref note",
      upsert: [makeNote("alpha-note")],
    });

    expect(result.status).toBe("committed");
    await expect(fs.stat(path.join(repoDir, "notes"))).rejects.toThrow();
    await expect(
      git(repoDir, ["rev-parse", "--verify", "refs/mnemonic/project"]),
    ).resolves.toContain(result.status === "committed" ? result.newOid : "");

    const ids = await store.listNoteIds();
    expect(ids).toEqual([memoryId("alpha-note")]);

    const note = await store.readNote(memoryId("alpha-note"));
    expect(note).toMatchObject({
      id: memoryId("alpha-note"),
      title: "alpha-note",
      content: "Body for alpha-note",
      tags: ["git-ref"],
    });
  });

  it("preserves existing ref contents while adding and deleting notes", async () => {
    const store = new GitRefNoteStore({
      gitRoot: repoDir,
      ref: "refs/mnemonic/project",
    });

    await store.write({
      message: "remember: first notes",
      upsert: [makeNote("alpha-note"), makeNote("beta-note")],
    });

    await store.write({
      message: "update: replace notes",
      upsert: [makeNote("gamma-note")],
      deleteIds: [memoryId("alpha-note")],
    });

    await expect(store.readNote(memoryId("alpha-note"))).resolves.toBeNull();
    await expect(store.readNote(memoryId("beta-note"))).resolves.toMatchObject({
      id: memoryId("beta-note"),
    });
    await expect(store.readNote(memoryId("gamma-note"))).resolves.toMatchObject({
      id: memoryId("gamma-note"),
    });
    await expect(store.listNoteIds()).resolves.toEqual([
      memoryId("beta-note"),
      memoryId("gamma-note"),
    ]);
  });

  it("rejects stale expected ref tips before writing", async () => {
    const store = new GitRefNoteStore({
      gitRoot: repoDir,
      ref: "refs/mnemonic/project",
    });

    const first = await store.write({
      message: "remember: first note",
      upsert: [makeNote("alpha-note")],
    });
    expect(first.status).toBe("committed");
    if (first.status !== "committed") throw new Error("expected commit");

    await store.write({
      message: "remember: second note",
      upsert: [makeNote("beta-note")],
    });

    await expect(
      store.write({
        message: "remember: stale note",
        upsert: [makeNote("gamma-note")],
        expectedOldOid: first.newOid,
      }),
    ).rejects.toThrow(GitRefConflictError);

    await expect(store.readNote(memoryId("gamma-note"))).resolves.toBeNull();
  });

  it("returns no-changes when the resulting tree matches the current ref", async () => {
    const store = new GitRefNoteStore({
      gitRoot: repoDir,
      ref: "refs/mnemonic/project",
    });
    const note = makeNote("alpha-note");

    await store.write({
      message: "remember: first note",
      upsert: [note],
    });

    const result = await store.write({
      message: "remember: same note",
      upsert: [note],
    });

    expect(result).toMatchObject({ status: "skipped", reason: "no-changes" });
  });
});
