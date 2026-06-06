import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerContext } from "../server-context.js";
import { resolveProject as resolveProjectFromModule } from "../helpers/project.js";
import { projectNotFoundResponse } from "../helpers/vault.js";
import {
  CONSOLIDATION_MODES,
  PROJECT_STORAGE_BACKENDS,
  PROTECTED_BRANCH_BEHAVIORS,
  PROJECT_POLICY_SCOPES,
  type ProjectMemoryPolicy,
} from "../project-memory-policy.js";
import { InvalidMemoryRefError, validateMemoryRef } from "../git-ref-note-store.js";
import { formatCommitBody } from "../helpers/git-commit.js";
import {
  pushAfterMutation as pushAfterMutationFromModule,
  buildMutationRetryContract,
  formatRetrySummary,
} from "../helpers/persistence.js";
import { PolicyResultSchema, type PolicyResult } from "../structured-content.js";
import { attemptSync } from "../error-utils.js";

export function registerSetProjectMemoryPolicyTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "set_project_memory_policy",
    {
      title: "Set Project Memory Policy",
      description:
        "Use this when:\n" +
        "- A project should default to project or global storage\n" +
        "- Protected-branch handling or consolidation behavior should be standardized\n\n" +
        "Do not use this when:\n" +
        "- You only need a one-off write location for a single `remember` call\n\n" +
        "Returns: saved project policy and effective values.\n\n" +
        "[mutating: writes config, git commits, may push]\n\n" +
        "Typical next step:\n" +
        "- Use `get_project_memory_policy` to verify the saved policy.",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({
        cwd: z
          .string()
          .describe(
            "Absolute path of the project working directory. Required for project-scoped routing, vault selection, and search boosting.",
          ),
        defaultScope: z
          .enum(PROJECT_POLICY_SCOPES)
          .optional()
          .describe(
            "Default storage: 'project' = shared project vault, 'global' = private main vault, 'ask' = prompt each time",
          ),
        consolidationMode: z
          .enum(CONSOLIDATION_MODES)
          .optional()
          .describe(
            "Default consolidation mode: 'supersedes' preserves history (default), 'delete' removes sources immediately",
          ),
        protectedBranchBehavior: z
          .enum(PROTECTED_BRANCH_BEHAVIORS)
          .optional()
          .describe(
            "Behavior for protected-branch matches during project-vault commits by mutating tools: 'ask', 'block', or 'allow'",
          ),
        protectedBranchPatterns: z
          .array(z.string())
          .optional()
          .describe(
            'Protected branch glob patterns. Defaults to ["main", "master", "release*"] when not set',
          ),
        projectStorageBackend: z
          .enum(PROJECT_STORAGE_BACKENDS)
          .optional()
          .describe(
            "Project memory storage backend: 'filesystem' uses `.mnemonic/`; 'git-ref' stores notes under a custom Git ref.",
          ),
        projectMemoryRef: z
          .string()
          .optional()
          .describe(
            "Custom Git ref used when projectStorageBackend is 'git-ref'. Defaults to refs/mnemonic/project.",
          ),
        maxAttachmentsPerProject: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe(
            "Maximum number of attachment vaults allowed per project. Clamped to [1, 20], default 5.",
          ),
      }),
      outputSchema: PolicyResultSchema,
    },
    async ({
      cwd,
      defaultScope,
      consolidationMode,
      protectedBranchBehavior,
      protectedBranchPatterns,
      projectStorageBackend,
      projectMemoryRef,
      maxAttachmentsPerProject,
    }) => {
      const project = await resolveProjectFromModule(ctx, cwd);
      if (!project) {
        return projectNotFoundResponse(cwd);
      }

      const maxAttachmentsChanged = maxAttachmentsPerProject !== undefined;

      if (
        defaultScope === undefined &&
        consolidationMode === undefined &&
        protectedBranchBehavior === undefined &&
        protectedBranchPatterns === undefined &&
        projectStorageBackend === undefined &&
        projectMemoryRef === undefined &&
        !maxAttachmentsChanged
      ) {
        return {
          content: [
            {
              type: "text",
              text: "No policy fields provided. Set at least one of: defaultScope, consolidationMode, protectedBranchBehavior, protectedBranchPatterns, projectStorageBackend, projectMemoryRef, maxAttachmentsPerProject.",
            },
          ],
          isError: true,
        };
      }

      const existing = await ctx.configStore.getProjectPolicy(project.id);
      const effectiveDefaultScope = defaultScope ?? existing?.defaultScope ?? "project";
      const effectiveConsolidationMode = consolidationMode ?? existing?.consolidationMode;
      const effectiveProtectedBranchBehavior =
        protectedBranchBehavior ?? existing?.protectedBranchBehavior;
      const effectiveProtectedBranchPatterns = protectedBranchPatterns
        ? protectedBranchPatterns
            .map((pattern) => pattern.trim())
            .filter((pattern) => pattern.length > 0)
        : existing?.protectedBranchPatterns;
      const effectiveProjectStorageBackend =
        projectStorageBackend ?? existing?.projectStorageBackend;
      const effectiveProjectMemoryRef = projectMemoryRef?.trim() || existing?.projectMemoryRef;
      if (effectiveProjectMemoryRef) {
        const validation = attemptSync("policy:validate-memory-ref", () =>
          validateMemoryRef(effectiveProjectMemoryRef),
        );
        if (!validation.ok && validation.error instanceof InvalidMemoryRefError) {
          return {
            content: [{ type: "text", text: validation.error.message }],
            isError: true,
          };
        }
        if (!validation.ok) {
          throw validation.error;
        }
      }

      const now = new Date().toISOString();
      const policy: ProjectMemoryPolicy = {
        projectId: project.id,
        projectName: project.name,
        defaultScope: effectiveDefaultScope,
        consolidationMode: effectiveConsolidationMode,
        protectedBranchBehavior: effectiveProtectedBranchBehavior,
        protectedBranchPatterns: effectiveProtectedBranchPatterns,
        projectStorageBackend: effectiveProjectStorageBackend,
        projectMemoryRef: effectiveProjectMemoryRef,
        updatedAt: now,
      };
      await ctx.configStore.setProjectPolicy(policy);

      if (maxAttachmentsChanged) {
        await ctx.configStore.setMaxAttachmentsPerProject(maxAttachmentsPerProject);
      }

      const modeStr = effectiveConsolidationMode
        ? `, consolidationMode=${effectiveConsolidationMode}`
        : "";
      const branchBehaviorStr = effectiveProtectedBranchBehavior
        ? `, protectedBranchBehavior=${effectiveProtectedBranchBehavior}`
        : "";
      const branchPatternsStr =
        effectiveProtectedBranchPatterns && effectiveProtectedBranchPatterns.length > 0
          ? `, protectedBranchPatterns=${effectiveProtectedBranchPatterns.join("|")}`
          : "";
      const maxAttachmentsStr = maxAttachmentsChanged
        ? `, maxAttachmentsPerProject=${maxAttachmentsPerProject}`
        : "";
      const backendStr = effectiveProjectStorageBackend
        ? `, projectStorageBackend=${effectiveProjectStorageBackend}`
        : "";
      const memoryRefStr = effectiveProjectMemoryRef
        ? `, projectMemoryRef=${effectiveProjectMemoryRef}`
        : "";
      const commitBody = formatCommitBody({
        projectName: project.name,
        description:
          `Default scope: ${effectiveDefaultScope}` +
          `${effectiveConsolidationMode ? `\nConsolidation mode: ${effectiveConsolidationMode}` : ""}` +
          `${effectiveProtectedBranchBehavior ? `\nProtected branch behavior: ${effectiveProtectedBranchBehavior}` : ""}` +
          `${
            effectiveProtectedBranchPatterns && effectiveProtectedBranchPatterns.length > 0
              ? `\nProtected branch patterns: ${effectiveProtectedBranchPatterns.join(", ")}`
              : ""
          }` +
          `${
            effectiveProjectStorageBackend
              ? `\nProject storage backend: ${effectiveProjectStorageBackend}`
              : ""
          }` +
          `${effectiveProjectMemoryRef ? `\nProject memory ref: ${effectiveProjectMemoryRef}` : ""}`,
      });
      const commitMessage = `policy: ${project.name} default scope ${effectiveDefaultScope}`;
      const commitFiles = ["config.json"];
      const commitStatus = await ctx.vaultManager.main.git.commitWithStatus(
        commitMessage,
        commitFiles,
        commitBody,
      );
      const pushStatus =
        commitStatus.status === "committed"
          ? await pushAfterMutationFromModule(ctx, ctx.vaultManager.main)
          : { status: "skipped" as const, reason: "commit-failed" as const };
      const retry = buildMutationRetryContract({
        commit: commitStatus,
        commitMessage,
        commitBody,
        files: commitFiles,
        cwd,
        vault: ctx.vaultManager.main,
        mutationApplied: true,
      });

      const structuredContent: PolicyResult = {
        action: "policy_set",
        project: { id: project.id, name: project.name },
        defaultScope: effectiveDefaultScope,
        consolidationMode: effectiveConsolidationMode,
        protectedBranchBehavior: effectiveProtectedBranchBehavior,
        protectedBranchPatterns: effectiveProtectedBranchPatterns,
        projectStorageBackend: effectiveProjectStorageBackend,
        projectMemoryRef: effectiveProjectMemoryRef,
        maxAttachmentsPerProject: maxAttachmentsChanged
          ? maxAttachmentsPerProject
          : await ctx.configStore.getMaxAttachmentsPerProject(),
        updatedAt: now,
        retry,
      };

      return {
        content: [
          {
            type: "text",
            text:
              `Project memory policy set for ${project.name}: defaultScope=${effectiveDefaultScope}` +
              `${modeStr}${branchBehaviorStr}${branchPatternsStr}${backendStr}${memoryRefStr}${maxAttachmentsStr}` +
              `${
                commitStatus.status === "failed"
                  ? `\n${formatRetrySummary(retry) ?? `Commit failed. Push status: ${pushStatus.status}.`}`
                  : ""
              }`,
          },
        ],
        structuredContent,
      };
    },
  );
}

export function registerGetProjectMemoryPolicyTool(server: McpServer, ctx: ServerContext): void {
  server.registerTool(
    "get_project_memory_policy",
    {
      title: "Get Project Memory Policy",
      description:
        "Use this when:\n" +
        "- You want to confirm the default write scope before storing memory\n" +
        "- You are debugging why notes land in an unexpected vault\n" +
        "- You need to inspect protected-branch or consolidation defaults\n\n" +
        "Do not use this when:\n" +
        "- You want to change the policy; use `set_project_memory_policy`\n\n" +
        "Returns: saved policy values or an explanation of the fallback behavior.\n\n" +
        "Typical next step:\n" +
        "- Call `remember` with explicit `scope` for a one-off override, or `set_project_memory_policy` to change defaults.",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      inputSchema: z.object({
        cwd: z
          .string()
          .describe(
            "Absolute path of the project working directory. Required for project-scoped routing, vault selection, and search boosting.",
          ),
      }),
      outputSchema: PolicyResultSchema,
    },
    async ({ cwd }) => {
      const project = await resolveProjectFromModule(ctx, cwd);
      if (!project) {
        return projectNotFoundResponse(cwd);
      }

      const policy = await ctx.configStore.getProjectPolicy(project.id);
      const maxAttachmentsPerProject = await ctx.configStore.getMaxAttachmentsPerProject();
      if (!policy) {
        const structuredContent: PolicyResult = {
          action: "policy_shown",
          project: { id: project.id, name: project.name },
          maxAttachmentsPerProject,
        };
        return {
          content: [
            {
              type: "text",
              text: `No project memory policy set for ${project.name}. Default write behavior remains scope=project when cwd is present. maxAttachmentsPerProject=${maxAttachmentsPerProject}.`,
            },
          ],
          structuredContent,
        };
      }

      const structuredContent: PolicyResult = {
        action: "policy_shown",
        project: { id: project.id, name: project.name },
        defaultScope: policy.defaultScope,
        consolidationMode: policy.consolidationMode,
        protectedBranchBehavior: policy.protectedBranchBehavior,
        protectedBranchPatterns: policy.protectedBranchPatterns,
        projectStorageBackend: policy.projectStorageBackend,
        projectMemoryRef: policy.projectMemoryRef,
        maxAttachmentsPerProject,
        updatedAt: policy.updatedAt,
      };

      const details = [
        `defaultScope=${policy.defaultScope}`,
        policy.consolidationMode ? `consolidationMode=${policy.consolidationMode}` : undefined,
        policy.protectedBranchBehavior
          ? `protectedBranchBehavior=${policy.protectedBranchBehavior}`
          : undefined,
        policy.protectedBranchPatterns && policy.protectedBranchPatterns.length > 0
          ? `protectedBranchPatterns=${policy.protectedBranchPatterns.join("|")}`
          : undefined,
        policy.projectStorageBackend
          ? `projectStorageBackend=${policy.projectStorageBackend}`
          : undefined,
        policy.projectMemoryRef ? `projectMemoryRef=${policy.projectMemoryRef}` : undefined,
        `maxAttachmentsPerProject=${maxAttachmentsPerProject}`,
      ]
        .filter(Boolean)
        .join(", ");

      return {
        content: [
          {
            type: "text",
            text: `Project memory policy for ${project.name}: ${details} (updated ${policy.updatedAt})`,
          },
        ],
        structuredContent,
      };
    },
  );
}
