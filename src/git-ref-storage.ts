import path from "path";

import { memoryId, type MemoryId } from "./brands.js";
import { AtomicWriteInProgressError } from "./domain-errors.js";
import { GitRefNoteStore, type GitRefWriteResult } from "./git-ref-note-store.js";
import { Storage, type EmbeddingRecord, type Note, type NoteStorage } from "./storage.js";
import type { NoteProjection } from "./structured-content.js";

interface AtomicSnapshot {
  notes: Map<string, Note>;
  deletedNoteIds: Set<string>;
}

export class GitRefStorage implements NoteStorage {
  readonly vaultPath: string;
  readonly notesDir: string;
  readonly embeddingsDir: string;
  readonly projectionsDir: string;

  private readonly localStorage: Storage;
  private readonly noteStore: GitRefNoteStore;
  private stagedNotes = new Map<string, Note>();
  private stagedDeletedNoteIds = new Set<string>();
  private atomicSnapshot?: AtomicSnapshot;

  constructor(localStorage: Storage, noteStore: GitRefNoteStore) {
    this.localStorage = localStorage;
    this.noteStore = noteStore;
    this.vaultPath = localStorage.vaultPath;
    this.notesDir = path.join(
      this.vaultPath,
      "refs",
      this.noteStore.ref.replace(/^refs\//, "").replace(/\//g, "__"),
      "notes",
    );
    this.embeddingsDir = localStorage.embeddingsDir;
    this.projectionsDir = localStorage.projectionsDir;
  }

  get notesRelDir(): string {
    return this.noteStore.notesRelDir;
  }

  async init(): Promise<void> {
    await this.localStorage.init();
  }

  async listNoteIds(): Promise<MemoryId[]> {
    const ids = new Set<string>((await this.noteStore.listNoteIds()).map(String));
    for (const id of this.stagedNotes.keys()) {
      ids.add(id);
    }
    for (const id of this.stagedDeletedNoteIds) {
      ids.delete(id);
    }
    return [...ids].sort().map(memoryId);
  }

  async readNote(id: MemoryId): Promise<Note | null> {
    if (this.stagedDeletedNoteIds.has(id)) {
      return null;
    }

    const staged = this.stagedNotes.get(id);
    if (staged) {
      return staged;
    }

    return this.noteStore.readNote(id);
  }

  async listNotes(filter?: { project?: string | null }): Promise<Note[]> {
    const ids = await this.listNoteIds();
    const notes: Note[] = [];
    for (const id of ids) {
      const note = await this.readNote(id);
      if (!note) continue;

      if (filter !== undefined) {
        if (filter.project === null) {
          if (note.project) continue;
        } else if (filter.project !== undefined) {
          if (note.project !== filter.project) continue;
        }
      }

      notes.push(note);
    }
    return notes;
  }

  async writeNote(note: Note): Promise<void> {
    this.stagedNotes.set(note.id, note);
    this.stagedDeletedNoteIds.delete(note.id);
  }

  async deleteNote(id: MemoryId): Promise<boolean> {
    const existing = this.stagedNotes.has(id) || (await this.noteStore.readNote(id)) !== null;
    this.stagedNotes.delete(id);
    this.stagedDeletedNoteIds.add(id);
    return existing;
  }

  async beginAtomicNotesWrite(): Promise<void> {
    if (this.atomicSnapshot) {
      throw new AtomicWriteInProgressError();
    }

    this.atomicSnapshot = {
      notes: new Map(this.stagedNotes),
      deletedNoteIds: new Set(this.stagedDeletedNoteIds),
    };
  }

  async commitAtomicNotesWrite(): Promise<void> {
    this.atomicSnapshot = undefined;
  }

  async rollbackAtomicNotesWrite(): Promise<void> {
    if (!this.atomicSnapshot) {
      return;
    }

    this.stagedNotes = new Map(this.atomicSnapshot.notes);
    this.stagedDeletedNoteIds = new Set(this.atomicSnapshot.deletedNoteIds);
    this.atomicSnapshot = undefined;
  }

  hasPendingNoteChanges(): boolean {
    return this.stagedNotes.size > 0 || this.stagedDeletedNoteIds.size > 0;
  }

  pendingNotePaths(): string[] {
    const ids = new Set<string>([...this.stagedNotes.keys(), ...this.stagedDeletedNoteIds]);
    return [...ids].sort().map((id) => `${this.noteStore.notesRelDir}/${id}.md`);
  }

  async flushPendingNotes(message: string, body?: string): Promise<GitRefWriteResult> {
    const upsert = [...this.stagedNotes.values()];
    const deleteIds = [...this.stagedDeletedNoteIds].map(memoryId);

    if (upsert.length === 0 && deleteIds.length === 0) {
      return {
        status: "skipped",
        reason: "no-changes",
        oldOid: await this.noteStore.currentTip(),
      };
    }

    const result = await this.noteStore.write({ message, body, upsert, deleteIds });
    this.stagedNotes.clear();
    this.stagedDeletedNoteIds.clear();
    return result;
  }

  async readEmbedding(id: MemoryId): Promise<EmbeddingRecord | null> {
    return this.localStorage.readEmbedding(id);
  }

  async writeEmbedding(record: EmbeddingRecord): Promise<void> {
    return this.localStorage.writeEmbedding(record);
  }

  async listEmbeddings(): Promise<EmbeddingRecord[]> {
    return this.localStorage.listEmbeddings();
  }

  async readProjection(id: MemoryId): Promise<NoteProjection | null> {
    return this.localStorage.readProjection(id);
  }

  async writeProjection(projection: NoteProjection): Promise<void> {
    return this.localStorage.writeProjection(projection);
  }

  notePath(id: MemoryId): string {
    return `git-ref:${this.noteStore.ref}:${this.noteStore.notesRelDir}/${id}.md`;
  }

  embeddingPath(id: MemoryId): string {
    return this.localStorage.embeddingPath(id);
  }

  projectionPath(id: MemoryId): string {
    return this.localStorage.projectionPath(id);
  }
}
