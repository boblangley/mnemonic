import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "../src/server-context.js";
import type { Vault } from "../src/vault.js";

const { detectProjectMock } = vi.hoisted(() => ({
  detectProjectMock: vi.fn(),
}));

vi.mock("../src/project.js", () => ({
  detectProject: detectProjectMock,
}));

import { resolveWriteVault } from "../src/helpers/project.js";

function makeVault(folderName: string): Vault {
  return {
    storage: { vaultPath: `/tmp/${folderName}` } as unknown as Vault["storage"],
    git: {} as Vault["git"],
    history: {} as Vault["history"],
    notesRelDir: "notes",
    provenance: "project-local",
    vaultFolderName: folderName,
    writable: true,
  } as Vault;
}

function fakeCtx(policy?: object): ServerContext {
  return {
    configStore: {
      getProjectPolicy: vi.fn().mockResolvedValue(policy),
      getProjectIdentityOverride: vi.fn().mockResolvedValue(undefined),
    },
    vaultManager: {
      main: makeVault("main"),
      getOrCreateProjectVault: vi.fn().mockResolvedValue(makeVault(".mnemonic")),
      getOrCreateProjectRefVault: vi.fn().mockResolvedValue(makeVault(".mnemonic-ref")),
    },
  } as unknown as ServerContext;
}

describe("resolveWriteVault", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    detectProjectMock.mockResolvedValue({ id: "project-1", name: "Project One" });
  });

  it("uses filesystem project vaults by default", async () => {
    const ctx = fakeCtx();

    const vault = await resolveWriteVault(ctx, "/repo", "project");

    expect(vault.vaultFolderName).toBe(".mnemonic");
    expect(ctx.vaultManager.getOrCreateProjectVault).toHaveBeenCalledWith("/repo");
    expect(ctx.vaultManager.getOrCreateProjectRefVault).not.toHaveBeenCalled();
  });

  it("uses ref-backed project vaults when project policy selects git-ref", async () => {
    const ctx = fakeCtx({
      projectId: "project-1",
      defaultScope: "project",
      projectStorageBackend: "git-ref",
      projectMemoryRef: "refs/mnemonic/custom",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const vault = await resolveWriteVault(ctx, "/repo", "project");

    expect(vault.vaultFolderName).toBe(".mnemonic-ref");
    expect(ctx.vaultManager.getOrCreateProjectRefVault).toHaveBeenCalledWith(
      "/repo",
      "refs/mnemonic/custom",
    );
    expect(ctx.vaultManager.getOrCreateProjectVault).not.toHaveBeenCalled();
  });
});
