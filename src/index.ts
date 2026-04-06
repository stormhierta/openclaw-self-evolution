/**
 * OpenClaw Self-Evolution Pipeline - Plugin Entry Point
 * 
 * Main plugin entry point that OpenClaw loads.
 * Registers hooks, tools, and CLI commands for the self-evolution system.
 * 
 * Source: matching bundled plugin firecrawl pattern
 */

import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { jsonResult } from "openclaw/plugin-sdk/agent-runtime";
import type {
  OpenClawPluginApi,
  AnyAgentTool,
} from "openclaw/plugin-sdk";
import { parseConfig } from "./config.js";
import type { EvolutionConfig, SkillVariant, GitManagerConfig } from "./types.js";
import { SizeLimits } from "./validation/size-limits.js";
import { DatasetManager } from "./dataset/manager.js";
import { DatasetBuilder } from "./dataset/builder.js";
import { EvolutionOptimizer } from "./evolution/optimizer.js";
import { GEPAEvolver } from "./evolution/gepa/evolver.js";
import { DatasetSessionMiner } from "./dataset/session-miner.js";
import { SyntheticGenerator } from "./dataset/synthetic-generator.js";
import { GoldenSetLoader } from "./dataset/golden-sets.js";
import { SkillValidator } from "./validation/skill-validator.js";
import { ConstraintValidator } from "./validation/constraint-validator.js";
import { TestRunner } from "./validation/test-runner.js";
import { BenchmarkGate } from "./validation/benchmark-gate.js";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { TrajectoryHookHandler } from "./hooks/trajectory-hooks.js";
import { OutcomeLabeler } from "./collection/outcome-labeler.js";
import { GitManager } from "./deployment/git-manager.js";
import { MetricsReporter } from "./deployment/metrics-reporter.js";
import { PrBuilder } from "./deployment/pr-builder.js";
import { ReviewQueue } from "./deployment/review-queue.js";
import { TrajectoryLogger } from "./collection/trajectory-logger.js";
import { EvolutionTrigger } from "./automation/evolution-trigger.js";
import { EvolutionScheduler } from "./automation/scheduler.js";
import { SessionMiner } from "./collection/session-miner.js";
import { SkillRegistry, getSkillRegistry } from "./collection/skill-registry.js";
import { RubricRegistry } from "./evolution/fitness/rubrics.js";
import { skillManagerTool } from "./tools/skill-manager-schema.js";
import { LlmJudge } from "./evolution/fitness/llm-judge.js";
import type {
  LlmInputEvent,
  LlmOutputEvent,
  AgentEndEvent,
  BeforeToolCallEvent,
  AfterToolCallEvent,
  SessionStartEvent,
  SessionEndEvent,
  SubagentSpawnedEvent,
  SubagentEndedEvent,
  AgentContext,
  ToolContext,
  SessionContext,
  SubagentContext,
} from "./hooks/trajectory-hooks.js";
import type { PluginHookBeforeToolCallResult } from "./types.js";

export const VERSION = "0.1.0";

// Store config for use across the plugin
let pluginConfig: EvolutionConfig;

// Trajectory hook handler instance
let trajectoryHandler: TrajectoryHookHandler | null = null;
// FIX 4: Trajectory logger instance for persisting trajectory data
let trajectoryLogger: TrajectoryLogger | null = null;
// P3-B: Outcome labeler for RL trajectory labeling
let outcomeLabeler: OutcomeLabeler | null = null;
// FIX 4: Shared DatasetManager instance (initialized once in register)
let datasetManager: DatasetManager | null = null;
// Phase 7: Deployment stack instances
let prBuilder: PrBuilder | null = null;
let reviewQueue: ReviewQueue | null = null;
// P3-A: Self-triggered evolution instance
let evolutionTrigger: EvolutionTrigger | null = null;
// P3-C: Evolution scheduler for automated background evolution
let evolutionScheduler: EvolutionScheduler | null = null;
// SkillRegistry: Runtime index of all known skills
let skillRegistry: SkillRegistry | null = null;

/**
 * Get the plugin configuration (for internal use)
 */
export function getConfig(): EvolutionConfig {
  return pluginConfig;
}

/**
 * Get the trajectory handler instance (for testing/internal use)
 */
export function getTrajectoryHandler(): TrajectoryHookHandler | null {
  return trajectoryHandler;
}

/**
 * FIX 4: Get the trajectory logger instance (for testing/internal use)
 */
export function getTrajectoryLogger(): TrajectoryLogger | null {
  return trajectoryLogger;
}

/**
 * P3-B: Get the outcome labeler instance (for testing/internal use)
 */
export function getOutcomeLabeler(): OutcomeLabeler | null {
  return outcomeLabeler;
}

/**
 * P3-A: Get the evolution trigger instance (for testing/internal use)
 */
export function getEvolutionTrigger(): EvolutionTrigger | null {
  return evolutionTrigger;
}

/**
 * P3-C: Get the evolution scheduler instance (for testing/internal use)
 */
export function getScheduler(): EvolutionScheduler | null {
  return evolutionScheduler;
}

/**
 * Get the skill registry instance (for testing/internal use)
 */
export function getSkillRegistryInstance(): SkillRegistry | null {
  return skillRegistry;
}


/**
 * Factory for check_evolution_need tool
 * Source: matching bundled plugin firecrawl tool pattern
 */
function createCheckEvolutionNeedTool(config: EvolutionConfig): AnyAgentTool {
  return {
    name: "check_evolution_need",
    label: "Check Evolution Need",
    description: "Check if a skill needs evolution based on recent performance data",
    parameters: {
      type: "object",
      properties: {
        skillName: {
          type: "string",
          description: "Name of the skill to check (omit to check all tracked skills)",
        },
      },
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      try {
        if (!evolutionTrigger) {
          return jsonResult({
            success: false,
            error: "EvolutionTrigger not initialized",
            decisions: null,
          });
        }

        const skillName = args.skillName as string | undefined;

        if (skillName) {
          // Check specific skill
          const decision = await evolutionTrigger.checkSkill(skillName);
          return jsonResult({
            success: true,
            skillName: decision.skillName,
            shouldEvolve: decision.shouldEvolve,
            reason: decision.reason,
            urgency: decision.urgency,
            currentPerformance: {
              totalTurns: decision.currentPerformance.totalTurns,
              successRate: decision.currentPerformance.successRate,
              avgRewardSignal: decision.currentPerformance.avgRewardSignal,
              turnsInWindow: decision.currentPerformance.turnsInWindow,
              lastEvaluated: decision.currentPerformance.lastEvaluated.toISOString(),
            },
          });
        } else {
          // Check all tracked skills
          const triggerResult = await evolutionTrigger.checkAllSkills();
          return jsonResult({
            success: true,
            checkedAll: true,
            skillsNeedingEvolution: triggerResult.triggers.length,
            decisions: triggerResult.triggers.map((d) => ({
              skillName: d.skillName,
              shouldEvolve: d.shouldEvolve,
              reason: d.reason,
              urgency: d.urgency,
              currentPerformance: {
                totalTurns: d.currentPerformance.totalTurns,
                successRate: d.currentPerformance.successRate,
                avgRewardSignal: d.currentPerformance.avgRewardSignal,
                turnsInWindow: d.currentPerformance.turnsInWindow,
                lastEvaluated: d.currentPerformance.lastEvaluated.toISOString(),
              },
            })),
            skillCreationRecommendations: triggerResult.skillCreationRecommendations.map((r) => ({
              pattern: r.pattern,
              occurrences: r.occurrences,
              suggestedSkillName: r.suggestedSkillName,
              confidence: r.confidence,
              examplePrompts: r.examplePrompts,
            })),
          });
        }
      } catch (err) {
        return jsonResult({
          success: false,
          error: err instanceof Error ? err.message : String(err),
          decisions: null,
        });
      }
    },
  };
}
// ============================================================================
// Hook Handlers (delegating to TrajectoryHookHandler)
// ============================================================================

/**
 * Handle llm_input event
 * SDK Signature: (event: PluginHookLlmInputEvent, ctx: PluginHookAgentContext) => Promise<void> | void
 * Source: PluginHookHandlerMap['llm_input'] per SDK types.d.ts
 */
async function handleLlmInput(
  event: LlmInputEvent,
  ctx: AgentContext
): Promise<void> {
  await trajectoryHandler?.onLlmInput(event, ctx);
}

/**
 * Handle llm_output event
 * SDK Signature: (event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext) => Promise<void> | void
 * Source: PluginHookHandlerMap['llm_output'] per SDK types.d.ts
 */
async function handleLlmOutput(
  event: LlmOutputEvent,
  ctx: AgentContext
): Promise<void> {
  await trajectoryHandler?.onLlmOutput(event, ctx);
}

/**
 * Handle agent_end event
 * SDK Signature: (event: PluginHookAgentEndEvent, ctx: PluginHookAgentContext) => Promise<void> | void
 * Source: PluginHookHandlerMap['agent_end'] per SDK types.d.ts
 */
async function handleAgentEnd(
  event: AgentEndEvent,
  ctx: AgentContext
): Promise<void> {
  await trajectoryHandler?.onAgentEnd(event, ctx);
}

/**
 * Handle before_tool_call event
 * SDK Signature: (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) => Promise<PluginHookBeforeToolCallResult | void> | PluginHookBeforeToolCallResult | void
 * Source: PluginHookHandlerMap['before_tool_call'] per SDK types.d.ts
 */
async function handleBeforeToolCall(
  event: BeforeToolCallEvent,
  ctx: ToolContext
): Promise<PluginHookBeforeToolCallResult | void> {
  return await trajectoryHandler?.onBeforeToolCall(event, ctx);
}

/**
 * Handle after_tool_call event
 * SDK Signature: (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => Promise<void> | void
 * Source: PluginHookHandlerMap['after_tool_call'] per SDK types.d.ts
 */
async function handleAfterToolCall(
  event: AfterToolCallEvent,
  ctx: ToolContext
): Promise<void> {
  await trajectoryHandler?.onAfterToolCall(event, ctx);
}

/**
 * Handle session_start event
 * SDK Signature: (event: PluginHookSessionStartEvent, ctx: PluginHookSessionContext) => Promise<void> | void
 * Source: PluginHookHandlerMap['session_start'] per SDK types.d.ts
 */
async function handleSessionStart(
  event: SessionStartEvent,
  ctx: SessionContext
): Promise<void> {
  await trajectoryHandler?.onSessionStart(event, ctx);
}

/**
 * Handle session_end event
 * SDK Signature: (event: PluginHookSessionEndEvent, ctx: PluginHookSessionContext) => Promise<void> | void
 * Source: PluginHookHandlerMap['session_end'] per SDK types.d.ts
 */
async function handleSessionEnd(
  event: SessionEndEvent,
  ctx: SessionContext
): Promise<void> {
  await trajectoryHandler?.onSessionEnd(event, ctx);
}

/**
 * Handle subagent_spawned event
 * SDK Signature: (event: PluginHookSubagentSpawnedEvent, ctx: PluginHookSubagentContext) => Promise<void> | void
 * Source: PluginHookHandlerMap['subagent_spawned'] per SDK types.d.ts
 */
async function handleSubagentSpawned(
  event: SubagentSpawnedEvent,
  ctx: SubagentContext
): Promise<void> {
  await trajectoryHandler?.onSubagentSpawned(event, ctx);
}

/**
 * Handle subagent_ended event
 * SDK Signature: (event: PluginHookSubagentEndedEvent, ctx: PluginHookSubagentContext) => Promise<void> | void
 * Source: PluginHookHandlerMap['subagent_ended'] per SDK types.d.ts
 */
async function handleSubagentEnded(
  event: SubagentEndedEvent,
  ctx: SubagentContext
): Promise<void> {
  await trajectoryHandler?.onSubagentEnded(event, ctx);
}

// ============================================================================
// Tool Factories
// ============================================================================

/**
 * Factory for propose_skill_edit tool
 * Source: matching bundled plugin firecrawl tool pattern
 */
function createProposeSkillEditTool(config: EvolutionConfig): AnyAgentTool {
  return {
    name: "propose_skill_edit",
    label: "Propose Skill Edit",
    description: "Propose an improvement to a skill based on observed usage patterns",
    parameters: {
      type: "object",
      properties: {
        skillName: {
          type: "string",
          description: "Name of the skill to improve",
        },
        rationale: {
          type: "string",
          description: "Explanation of why this change is needed",
        },
        proposedChanges: {
          type: "object",
          description: "The proposed changes to the skill",
          properties: {
            content: {
              type: "string",
              description: "Proposed new SKILL.md content",
            },
          },
        },
      },
      required: ["skillName", "rationale"],
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const skillName = args.skillName as string;
      const rationale = args.rationale as string;
      const proposedChanges = args.proposedChanges as { content?: string } | undefined;

      // 1. Validate skillName
      if (!skillName || typeof skillName !== "string" || skillName.trim() === "") {
        return jsonResult({
          success: false,
          error: "skillName must be a non-empty string",
          proposalId: null,
        });
      }

      // 2. Validate rationale
      if (!rationale || typeof rationale !== "string" || rationale.trim() === "") {
        return jsonResult({
          success: false,
          error: "rationale must be a non-empty string",
          proposalId: null,
        });
      }

      // 3. Resolve skill path
      const skillPath = join(
        process.env.HOME ?? ".",
        ".openclaw",
        "skills",
        skillName.trim(),
        "SKILL.md"
      );

      // 4. Check file exists
      if (!existsSync(skillPath)) {
        return jsonResult({
          success: false,
          error: `Skill file not found: ${skillPath}`,
          proposalId: null,
        });
      }

      // 5. Read current skill content
      let currentContent: string;
      try {
        currentContent = readFileSync(skillPath, "utf-8");
      } catch (err) {
        return jsonResult({
          success: false,
          error: `Failed to read skill file: ${err instanceof Error ? err.message : String(err)}`,
          proposalId: null,
        });
      }

      // 6. Run SkillValidator on current content to get baseline validity
      const sizeLimits = new SizeLimits(config);
      const validator = new SkillValidator(config, sizeLimits);
      const currentVariant: SkillVariant = {
        id: `current-${skillName}`,
        skillName,
        generation: 0,
        content: currentContent,
        mutations: [],
        parents: [],
        createdAt: new Date(),
      };
      const validationResult = validator.validate(currentVariant);

      // 7. If proposedChanges.content is provided, validate proposed content too
      let proposedValidation = null;
      if (proposedChanges?.content && typeof proposedChanges.content === "string") {
        const proposedVariant: SkillVariant = {
          id: `proposed-${skillName}`,
          skillName,
          generation: 0,
          content: proposedChanges.content,
          mutations: [],
          parents: [],
          createdAt: new Date(),
        };
        proposedValidation = validator.validate(proposedVariant);
      }

      // 8. Return structured proposal record
      const proposalId = `proposal-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      return jsonResult({
        success: true,
        proposalId,
        skillName,
        rationale,
        currentValid: validationResult.valid,
        currentErrors: validationResult.errors,
        proposedContentValid: proposedValidation?.valid ?? null,
        proposedErrors: proposedValidation?.errors ?? null,
        status: "pending",
        message: "Proposal recorded. Human review required before applying changes.",
      });
    },
  };
}

/**
 * Factory for run_evolution tool
 * Source: matching bundled plugin firecrawl tool pattern
 */
function createRunEvolutionTool(config: EvolutionConfig): AnyAgentTool {
  return {
    name: "run_evolution",
    label: "Run Evolution",
    description: "Trigger an evolution run for a specific skill",
    parameters: {
      type: "object",
      properties: {
        skillName: {
          type: "string",
          description: "Name of the skill to evolve",
        },
        generations: {
          type: "number",
          description: "Number of generations to run (optional)",
        },
        populationSize: {
          type: "number",
          description: "Size of the population (optional)",
        },
      },
      required: ["skillName"],
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const skillName = args.skillName as string;

      // 1. Validate skillName arg
      if (!skillName || typeof skillName !== "string" || skillName.trim() === "") {
        return jsonResult({
          success: false,
          error: "skillName must be a non-empty string",
          runId: null,
        });
      }

      // 2. Resolve skill path
      const skillPath = join(
        process.env.HOME ?? ".",
        ".openclaw",
        "skills",
        String(skillName),
        "SKILL.md"
      );

      // 3. Check file exists
      if (!existsSync(skillPath)) {
        return jsonResult({
          success: false,
          error: `Skill file not found: ${skillPath}`,
          runId: null,
        });
      }

      try {
        // FIX 4: Use shared datasetManager instance
        if (!datasetManager) {
          return jsonResult({
            success: false,
            error: "DatasetManager not initialized",
            runId: null,
          });
        }

        // 4. Instantiate dependencies
        const rubricRegistry = new RubricRegistry(config);
        const llmJudge = new LlmJudge(config, rubricRegistry);
        const sizeLimits = new SizeLimits(config);
        const skillValidator = new SkillValidator(config, sizeLimits);
        const constraintValidator = new ConstraintValidator(skillValidator, sizeLimits, config);
        const evolver = new GEPAEvolver(config, llmJudge, rubricRegistry, constraintValidator);

        // SessionMiner and SyntheticGenerator need trajectoryLogger
        if (!trajectoryLogger) {
          return jsonResult({
            success: false,
            error: "TrajectoryLogger not initialized. Ensure trajectory collection is enabled.",
            runId: null,
          });
        }
        const sessionMinerCollection = new SessionMiner(config);
        const datasetSessionMiner = new DatasetSessionMiner(config, sessionMinerCollection, trajectoryLogger);
        const syntheticGenerator = new SyntheticGenerator(config);
        const goldenSetLoader = new GoldenSetLoader(config);
        const datasetBuilder = new DatasetBuilder(
          config,
          datasetManager,
          datasetSessionMiner,
          syntheticGenerator,
          goldenSetLoader
        );

        const optimizer = new EvolutionOptimizer(
          config,
          evolver,
          datasetManager,
          datasetBuilder
        );

        // 5. Run evolution
        const maxGenerations = args.generations as number | undefined;
        // FIX 3: Extract and pass populationSize to optimizeSkill
        const populationSize = typeof args.populationSize === "number" ? args.populationSize : undefined;
        const run = await optimizer.optimizeSkill(skillName, skillPath, {
          maxGenerations,
          populationSize,
          buildNewDataset: true,
        });

        // 6. Return result
        return jsonResult({
          success: true,
          runId: run.id,
          status: run.status,
          bestFitnessScore: run.progress.bestFitnessScore,
          generationsCompleted: run.currentGeneration,
        });
      } catch (err) {
        // FIX 6: Better error serialization
        return jsonResult({
          success: false,
          error: err instanceof Error ? (err.stack ?? err.message) : String(err),
          runId: null,
        });
      }
    },
  };
}

/**
 * Factory for evolution_status tool
 * Source: matching bundled plugin firecrawl tool pattern
 */
function createEvolutionStatusTool(config: EvolutionConfig): AnyAgentTool {
  return {
    name: "evolution_status",
    label: "Evolution Status",
    description: "Check the status of an evolution run",
    parameters: {
      type: "object",
      properties: {
        runId: {
          type: "string",
          description: "ID of the evolution run to check",
        },
        skillName: {
          type: "string",
          description: "Name of the skill to check status for (optional, returns latest run)",
        },
      },
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      try {
        // FIX 4: Use shared datasetManager instance
        if (!datasetManager) {
          return jsonResult({
            success: false,
            error: "DatasetManager not initialized",
            status: null,
          });
        }

        // FIX 1: Only instantiate what's needed for read-only DB access.
        // Stubs satisfy EvolutionOptimizer constructor but are not used for status queries.
        const stubEvolver = null as unknown as GEPAEvolver;
        const stubDatasetBuilder = null as unknown as DatasetBuilder;
        const optimizer = new EvolutionOptimizer(
          config,
          stubEvolver,
          datasetManager,
          stubDatasetBuilder
        );

        // 2. Query based on args
        if (args.runId) {
          const run = await optimizer.getRunStatus(String(args.runId));
          if (!run) {
            return jsonResult({ found: false, runId: args.runId });
          }
          return jsonResult({
            found: true,
            runId: run.id,
            skillName: run.skillName,
            status: run.status,
            currentGeneration: run.currentGeneration,
            maxGenerations: run.maxGenerations,
            bestFitnessScore: run.progress.bestFitnessScore,
            averageFitnessScore: run.progress.averageFitnessScore,
            startedAt: run.startedAt?.toISOString(),
            completedAt: run.completedAt?.toISOString(),
            errorMessage: run.errorMessage,
          });
        } else if (args.skillName) {
          const runs = await optimizer.listRuns({ skillName: String(args.skillName) });
          return jsonResult({
            runs: runs.map((r) => ({
              runId: r.id,
              skillName: r.skillName,
              status: r.status,
              currentGeneration: r.currentGeneration,
              maxGenerations: r.maxGenerations,
              bestFitnessScore: r.progress.bestFitnessScore,
              startedAt: r.startedAt?.toISOString(),
              completedAt: r.completedAt?.toISOString(),
            })),
          });
        } else {
          const runs = await optimizer.listRuns();
          const last10 = runs.slice(0, 10);
          return jsonResult({
            runs: last10.map((r) => ({
              runId: r.id,
              skillName: r.skillName,
              status: r.status,
              currentGeneration: r.currentGeneration,
              maxGenerations: r.maxGenerations,
              bestFitnessScore: r.progress.bestFitnessScore,
              startedAt: r.startedAt?.toISOString(),
              completedAt: r.completedAt?.toISOString(),
            })),
          });
        }
      } catch (err) {
        // FIX 6: Better error serialization
        return jsonResult({
          success: false,
          error: err instanceof Error ? (err.stack ?? err.message) : String(err),
          status: null,
        });
      }
    },
  };
}

/**
 * Extract a description from a skill's YAML frontmatter.
 * Matches the pattern from optimizer.ts extractSkillDescription().
 */
function extractSkillDescription(skillContent: string): string {
  const frontmatterMatch = skillContent.match(/^---\n([\s\S]*?)\n---/);
  if (frontmatterMatch) {
    const descMatch = frontmatterMatch[1].match(/description:\s*["']?(.+?)["']?\s*$/m);
    if (descMatch) {
      return descMatch[1].trim();
    }
  }
  // Fallback: first non-empty non-heading line
  const lines = skillContent.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("---")) {
      return trimmed.slice(0, 200);
    }
  }
  return "Skill content for evolution";
}

/**
 * Factory for dataset_build tool
 * Source: matching bundled plugin firecrawl tool pattern
 */
function createDatasetBuildTool(config: EvolutionConfig): AnyAgentTool {
  return {
    name: "dataset_build",
    label: "Dataset Build",
    description: "Build a training dataset for a skill from trajectories",
    parameters: {
      type: "object",
      properties: {
        skillName: {
          type: "string",
          description: "Name of the skill to build dataset for",
        },
        datasetType: {
          type: "string",
          description: "Type of dataset: synthetic|mined|golden|external|all",
          enum: ["synthetic", "mined", "golden", "external", "all"],
        },
        maxEntries: {
          type: "number",
          description: "Maximum number of entries to include",
        },
      },
      required: ["skillName"],
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const skillName = args.skillName as string;
      const datasetType = (args.datasetType as string) || "all";
      const maxEntries = args.maxEntries as number | undefined;

      // 1. Validate skillName arg
      if (!skillName) {
        return jsonResult({
          success: false,
          error: "skillName is required",
          datasetId: null,
        });
      }

      // 2. Resolve skill path
      const skillPath = join(
        process.env.HOME ?? ".",
        ".openclaw",
        "skills",
        skillName,
        "SKILL.md"
      );

      // 3. Check file exists
      if (!existsSync(skillPath)) {
        return jsonResult({
          success: false,
          error: `Skill file not found at ${skillPath}`,
          datasetId: null,
        });
      }

      // 4. Read skill content
      let skillContent: string;
      try {
        skillContent = readFileSync(skillPath, "utf-8");
      } catch (err) {
        return jsonResult({
          success: false,
          error: `Failed to read skill file: ${err instanceof Error ? err.message : String(err)}`,
          datasetId: null,
        });
      }

      try {
        // 5. Extract description from YAML frontmatter (inside try so malformed YAML doesn't crash the plugin)
        const description = extractSkillDescription(skillContent);

        // FIX 4: Use the module-level shared datasetManager (initialized once at plugin startup)
        if (!datasetManager) {
          return jsonResult({
            success: false,
            error: "DatasetManager not initialized",
            datasetId: null,
          });
        }

        // datasetType filtering is not yet supported by DatasetBuilder for synthetic/mined/golden.
        // "all" and "external" are supported (external enables external session import).
        if (datasetType !== "all" && datasetType !== "external") {
          return jsonResult({
            success: false,
            error: `datasetType "${datasetType}" is not yet supported. Only "all" and "external" are currently implemented. Type-specific filtering is a planned enhancement.`,
            datasetId: null,
          });
        }
        const buildOptions: { maxSynthetic?: number; maxMined?: number; includeExternalSessions?: boolean; maxExternalExamples?: number } = {};
        if (maxEntries !== undefined) {
          // Distribute maxEntries across sources (all sources get the same limit for now)
          buildOptions.maxSynthetic = maxEntries;
          buildOptions.maxMined = maxEntries;
        }
        // Enable external session import when datasetType is "all" or "external"
        if (datasetType === "all" || datasetType === "external") {
          buildOptions.includeExternalSessions = true;
          buildOptions.maxExternalExamples = maxEntries ?? 50;
        }

        const syntheticGenerator = new SyntheticGenerator(config);
        const goldenSetLoader = new GoldenSetLoader(config);

        // Always require trajectoryLogger and instantiate DatasetSessionMiner.
        // DatasetBuilder.buildForSkill() always builds all types internally (golden, mined, synthetic),
        // so it will always call sessionMiner.mineForSkill() — null miner would crash.
        if (!trajectoryLogger) {
          return jsonResult({
            success: false,
            error: "TrajectoryLogger not initialized. Ensure trajectory collection is enabled.",
            datasetId: null,
          });
        }
        const sessionMinerCollection = new SessionMiner(config);
        const datasetSessionMiner = new DatasetSessionMiner(
          config,
          sessionMinerCollection,
          trajectoryLogger
        );

        const builder = new DatasetBuilder(
          config,
          datasetManager,
          datasetSessionMiner,
          syntheticGenerator,
          goldenSetLoader
        );

        // 7. Based on datasetType, call builder
        // Note: DatasetBuilder.buildForSkill() handles all types in one call.
        // Type-specific filtering (synthetic/mined/golden) is a future enhancement.
        const manifest = await builder.buildForSkill(skillName, description, buildOptions);

        // 8. Return success result
        return jsonResult({
          success: true,
          datasetId: manifest.id,
          entryCount: manifest.entryCount,
          name: manifest.name,
        });
      } catch (err) {
        // 9. Catch errors
        return jsonResult({
          success: false,
          error: err instanceof Error ? err.message : String(err),
          datasetId: null,
        });
      }
    },
  };
}

/**
 * Factory for benchmark_run tool
 * Source: matching bundled plugin firecrawl tool pattern
 */
function createBenchmarkRunTool(config: EvolutionConfig): AnyAgentTool {
  return {
    name: "benchmark_run",
    label: "Benchmark Run",
    description: "Run benchmarks to evaluate a skill variant",
    parameters: {
      type: "object",
      properties: {
        skillName: {
          type: "string",
          description: "Name of the skill to benchmark",
        },
        datasetId: {
          type: "string",
          description: "Dataset ID to use for test cases (optional)",
        },
      },
      required: ["skillName"],
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      const skillName = args.skillName as string;

      // Validate skillName before path resolution
      if (!skillName || typeof skillName !== "string" || skillName.trim() === "") {
        return jsonResult({ success: false, error: "skillName must be a non-empty string", benchmarkRunId: null });
      }

      const trimmedSkillName = skillName.trim();

      // Resolve skill path using OpenClaw standard layout (matches optimizer.ts resolveSkillPath)
      const skillPath = join(
        process.env.HOME ?? ".",
        ".openclaw",
        "skills",
        trimmedSkillName,
        "SKILL.md"
      );

      // Read skill content from disk
      let skillContent: string;
      try {
        skillContent = readFileSync(skillPath, "utf-8");
      } catch (err) {
        return jsonResult({
          success: false,
          error: `Failed to read skill file at ${skillPath}: ${err instanceof Error ? err.message : String(err)}`,
          benchmarkRunId: null,
        });
      }

      // Construct a minimal SkillVariant for baseline validation
      const variant: SkillVariant = {
        id: `baseline-${skillName}`,
        skillName,
        generation: 0,
        content: skillContent,
        mutations: [],
        parents: [],
        createdAt: new Date(),
      };

      // Run Phase 5 validation
      const sizeLimits = new SizeLimits(config);
      const validator = new SkillValidator(config, sizeLimits);
      const validationResult = validator.validate(variant);

      // Initialize response with validation results
      const benchmarkRunId = `bench-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
      const baseResult: Record<string, unknown> = {
        success: validationResult.valid,
        benchmarkRunId,
        skillName,
        skillPath,
        sizeBytes: validationResult.sizeBytes,
        valid: validationResult.valid,
        errors: validationResult.errors,
        warnings: validationResult.warnings,
      };

      // Check if datasetId was provided for TestRunner and BenchmarkGate
      const datasetId = args.datasetId as string | undefined;
      if (datasetId) {
        // Use shared datasetManager to load test cases
        if (!datasetManager) {
          return jsonResult({
            ...baseResult,
            success: false,
            error: "DatasetManager not initialized",
          });
        }

        try {
          // Load test cases from dataset
          const testCases = await datasetManager.getEntries(datasetId);
          if (testCases.length === 0) {
            return jsonResult({
              ...baseResult,
              testRunnerRun: false,
              testRunnerNote: `Dataset ${datasetId} has no entries; TestRunner and BenchmarkGate skipped`,
            });
          }

          // Run TestRunner
          const testRunner = new TestRunner(config);
          const testRunResult = await testRunner.runTests(variant, testCases);

          // Baseline benchmark runs measure test pass rate and validation,
          // not fitness score (which requires a full evolution run first).
          // Disable fitness score requirement since baseline variants have no fitnessScore.
          const benchmarkGate = new BenchmarkGate(config, { requireFitnessScore: false });
          const gateResult = benchmarkGate.evaluate(variant, validationResult, testRunResult);

          // Return full results including gate decision
          return jsonResult({
            ...baseResult,
            success: validationResult.valid && gateResult.passed,
            testRunnerRun: true,
            testRunner: {
              totalTests: testRunResult.totalTests,
              passed: testRunResult.passed,
              failed: testRunResult.failed,
              passRate: testRunResult.passRate,
              durationMs: testRunResult.durationMs,
            },
            gateDecision: {
              passed: gateResult.passed,
              reasons: gateResult.reasons,
              scores: gateResult.scores,
            },
          });
        } catch (err) {
          return jsonResult({
            ...baseResult,
            success: false,
            error: `Error running TestRunner/BenchmarkGate: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      // No datasetId provided — return validation-only result with note
      return jsonResult({
        ...baseResult,
        testRunnerRun: false,
        testRunnerNote: "datasetId not provided; TestRunner and BenchmarkGate were not run",
      });
    },
  };
}

/**
 * Factory for run_scheduler_cycle tool
 * P3-C: Manually trigger one auto-evolution scheduler cycle
 * Source: matching bundled plugin firecrawl tool pattern
 */
function createRunSchedulerCycleTool(_config: EvolutionConfig): AnyAgentTool {
  return {
    name: "run_scheduler_cycle",
    label: "Run Scheduler Cycle",
    description: "Manually trigger one auto-evolution scheduler cycle: label trajectories, check skill performance, trigger evolution for underperforming skills",
    parameters: {
      type: "object",
      properties: {},
    },
    execute: async (_toolCallId: string, _args: Record<string, unknown>) => {
      try {
        if (!evolutionScheduler) {
          return jsonResult({
            success: false,
            error: "EvolutionScheduler not initialized",
            result: null,
          });
        }

        const result = await evolutionScheduler.runCycle();

        return jsonResult({
          success: true,
          result: {
            newLabels: result.newLabels,
            skillsNeedingEvolution: result.skillsNeedingEvolution,
            skillsTriggered: result.skillsTriggered,
            evolutionRunIds: result.evolutionRunIds,
            prIds: result.prIds,
            errors: result.errors,
          },
        });
      } catch (err) {
        return jsonResult({
          success: false,
          error: err instanceof Error ? err.message : String(err),
          result: null,
        });
      }
    },
  };
}

/**
 * Factory for label_trajectories tool
 * P3-B: Label recent trajectory turns with outcome quality scores for RL training
 * Source: matching bundled plugin firecrawl tool pattern
 */
function createLabelTrajectoriesTool(config: EvolutionConfig): AnyAgentTool {
  return {
    name: "label_trajectories",
    label: "Label Trajectories",
    description: "Label recent trajectory turns with outcome quality scores for RL training",
    parameters: {
      type: "object",
      properties: {
        skillName: {
          type: "string",
          description: "Optional — label for specific skill",
        },
        limit: {
          type: "number",
          description: "Optional — max turns to label (default 50)",
        },
      },
    },
    execute: async (_toolCallId: string, args: Record<string, unknown>) => {
      try {
        // P3-B: Use module-level outcomeLabeler
        if (!outcomeLabeler) {
          return jsonResult({
            success: false,
            error: "OutcomeLabeler not initialized. Ensure trajectory collection is enabled.",
            labeledCount: 0,
          });
        }

        const skillName = args.skillName as string | undefined;
        const limit = typeof args.limit === "number" ? args.limit : 50;

        // Get unlabeled turns
        const unlabeledTurns = await outcomeLabeler.getUnlabeledTurns(skillName, limit);

        if (unlabeledTurns.length === 0) {
          return jsonResult({
            success: true,
            labeledCount: 0,
            message: "No unlabeled turns found",
          });
        }

        // Label the batch
        const results = await outcomeLabeler.labelBatch(unlabeledTurns);

        // Count by outcome type
        const successCount = results.filter(r => r.outcomeType === "success").length;
        const partialCount = results.filter(r => r.outcomeType === "partial").length;
        const failureCount = results.filter(r => r.outcomeType === "failure").length;

        return jsonResult({
          success: true,
          labeledCount: results.length,
          skillName: skillName ?? null,
          breakdown: {
            success: successCount,
            partial: partialCount,
            failure: failureCount,
          },
          averageScore: results.reduce((sum, r) => sum + r.rewardSignal, 0) / results.length,
        });
      } catch (err) {
        return jsonResult({
          success: false,
          error: err instanceof Error ? err.message : String(err),
          labeledCount: 0,
        });
      }
    },
  };
}

// ============================================================================
// CLI Registration
// ============================================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
 type AnyContext = any;

/** CLI command descriptor - per docs/plugins/manifest.md */
interface CliCommandDescriptor {
  name: string;
  description: string;
  hasSubcommands: boolean;
}

/** CLI registrar function type */
type CliRegistrar = (ctx: AnyContext) => void | Promise<void>;

/**
 * Register evolution CLI commands
 */
function registerEvolutionCli(ctx: AnyContext): void {
  const { program } = ctx;
  const evolutionCmd = program.command("evolution").description("Self-evolution pipeline management");

  evolutionCmd
    .command("run")
    .description("Run evolution on a skill")
    .requiredOption("--skill <skillName>", "Skill name to evolve")
    .option("--generations <number>", "Number of generations", "10")
    .option("--population <number>", "Population size", "20")
    .action(async (options: Record<string, string | undefined>) => {
      console.log("[self-evolution] evolution run CLI - not yet implemented", { options });
    });

  evolutionCmd
    .command("status")
    .description("Check evolution status")
    .option("--run-id <id>", "Evolution run ID")
    .option("--skill <skillName>", "Skill name")
    .action(async (options: Record<string, string | undefined>) => {
      console.log("[self-evolution] evolution status CLI - not yet implemented", { options });
    });

  evolutionCmd
    .command("list")
    .description("List evolution runs")
    .option("--skill <skillName>", "Filter by skill name")
    .action(async (options: { skill?: string }) => {
      console.log("[self-evolution] evolution list CLI - not yet implemented", { options });
    });

  const prCmd = evolutionCmd.command("pr").description("Manage evolution pull requests");
  prCmd
    .command("list")
    .description("List pending PRs")
    .action(async () => {
      if (!reviewQueue) {
        console.error("[self-evolution] ReviewQueue not initialized");
        return;
      }
      try {
        const pending = await reviewQueue.getPending();
        if (pending.length === 0) {
          console.log("[self-evolution] No pending PRs");
        } else {
          console.log(`[self-evolution] ${pending.length} pending PR(s):`);
          for (const item of pending) {
            console.log(`  - ${item.pr.id}  |  ${item.pr.skillName}  |  ${item.pr.title}`);
            console.log(`    branch: ${item.pr.branchName}  |  priority: ${item.priority}  |  queued: ${item.queuedAt}`);
          }
        }
      } catch (err) {
        console.error(`[self-evolution] Failed to list PRs: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  prCmd
    .command("approve")
    .description("Approve a pending PR")
    .requiredOption("--pr <prId>", "PR ID to approve")
    .option("--note <reviewNote>", "Review note")
    .action(async (options: Record<string, string | undefined>) => {
      if (!reviewQueue) {
        console.error("[self-evolution] ReviewQueue not initialized");
        return;
      }
      const prId = options.pr as string;
      if (!prId) {
        console.error("[self-evolution] --pr <prId> is required");
        return;
      }
      try {
        const approved = await reviewQueue.approve(prId, options.note);
        console.log(`[self-evolution] PR ${prId} approved: ${approved.title}`);
      } catch (err) {
        console.error(`[self-evolution] Failed to approve PR: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  prCmd
    .command("reject")
    .description("Reject a pending PR")
    .requiredOption("--pr <prId>", "PR ID to reject")
    .option("--note <reviewNote>", "Review note")
    .action(async (options: Record<string, string | undefined>) => {
      if (!reviewQueue) {
        console.error("[self-evolution] ReviewQueue not initialized");
        return;
      }
      const prId = options.pr as string;
      if (!prId) {
        console.error("[self-evolution] --pr <prId> is required");
        return;
      }
      try {
        const rejected = await reviewQueue.reject(prId, options.note);
        console.log(`[self-evolution] PR ${prId} rejected: ${rejected.title}`);
      } catch (err) {
        console.error(`[self-evolution] Failed to reject PR: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
}

/**
 * Register dataset CLI commands
 */
function registerDatasetCli(ctx: AnyContext): void {
  const { program } = ctx;
  const datasetCmd = program.command("dataset").description("Dataset management for evolution");

  datasetCmd
    .command("build")
    .description("Build dataset for a skill")
    .requiredOption("--skill <skillName>", "Skill name")
    .option("--type <type>", "Dataset type: synthetic|mined|golden|all", "all")
    .action(async (options: Record<string, string | undefined>) => {
      console.log("[self-evolution] dataset build CLI - not yet implemented", { options });
    });

  datasetCmd
    .command("list")
    .description("List available datasets")
    .option("--skill <skill>", "Filter by skill")
    .action(async (options: Record<string, string | undefined>) => {
      console.log("[self-evolution] dataset list CLI - not yet implemented", { options });
    });

  datasetCmd
    .command("validate")
    .description("Validate a dataset")
    .requiredOption("--dataset <datasetId>", "Dataset ID")
    .action(async (options: Record<string, string | undefined>) => {
      console.log("[self-evolution] dataset validate CLI - not yet implemented", { options });
    });
}

/**
 * Register benchmark CLI commands
 */
function registerBenchmarkCli(ctx: AnyContext): void {
  const { program } = ctx;
  const benchmarkCmd = program.command("benchmark").description("Benchmark management for skill evaluation");

  benchmarkCmd
    .command("run")
    .description("Run benchmarks for a skill")
    .requiredOption("--skill <skillName>", "Skill name")
    .option("--variant <variantId>", "Specific variant to benchmark")
    .action(async (options: Record<string, string | undefined>) => {
      console.log("[self-evolution] benchmark run CLI - not yet implemented", { options });
    });

  benchmarkCmd
    .command("list")
    .description("List available benchmarks")
    .option("--skill <skillName>", "Filter by skill")
    .action(async (options: Record<string, string | undefined>) => {
      console.log("[self-evolution] benchmark list CLI - not yet implemented", { options });
    });

  benchmarkCmd
    .command("compare")
    .description("Compare benchmark results")
    .requiredOption("--baseline <runId>", "Baseline run ID")
    .requiredOption("--compare <runId>", "Comparison run ID")
    .action(async (options: Record<string, string | undefined>) => {
      console.log("[self-evolution] benchmark compare CLI - not yet implemented", { options });
    });
}

// ============================================================================
// Plugin Registration
// ============================================================================

/**
 * Main plugin registration function
 */
async function register(api: OpenClawPluginApi): Promise<void> {
  const { logger, pluginConfig: rawConfig } = api;

  logger.info(`[self-evolution] Initializing self-evolution plugin v${VERSION}`);

  // Parse and validate configuration
  try {
    pluginConfig = parseConfig(rawConfig ?? {});
    logger.info("[self-evolution] Configuration loaded successfully");
  } catch (error) {
    logger.error(`[self-evolution] Failed to parse configuration: ${error}`);
    throw error;
  }

  if (!pluginConfig.enabled) {
    logger.info("[self-evolution] Plugin is disabled, skipping registration");
    return;
  }

  // FIX 4: Initialize trajectory handler and logger
  trajectoryHandler = new TrajectoryHookHandler(pluginConfig);
  trajectoryLogger = new TrajectoryLogger(pluginConfig, trajectoryHandler);

  // P3-B: Initialize outcome labeler for RL trajectory labeling
  outcomeLabeler = new OutcomeLabeler(pluginConfig);

  // FIX 4: Initialize shared DatasetManager once (reused across all tool calls)
  datasetManager = new DatasetManager(pluginConfig);
  await datasetManager.initialize();

  // Phase 7: Initialize deployment stack (GitManager, PrBuilder, ReviewQueue)
  const gitManager = new GitManager({} as GitManagerConfig);
  const metricsReporter = new MetricsReporter(pluginConfig);
  prBuilder = new PrBuilder(pluginConfig, gitManager, metricsReporter);
  await prBuilder.initialize();
  reviewQueue = new ReviewQueue(pluginConfig, prBuilder, gitManager);
  await reviewQueue.initialize();
  logger.info("[self-evolution] Deployment stack initialized (GitManager, PrBuilder, ReviewQueue)");

  // P3-A: Initialize evolution trigger for self-triggered evolution
  evolutionTrigger = new EvolutionTrigger(pluginConfig);
  logger.info("[self-evolution] Evolution trigger initialized for self-triggered evolution");

  // Initialize SkillRegistry for runtime skill discovery
  skillRegistry = new SkillRegistry();
  skillRegistry.scan();
  logger.info(`[self-evolution] SkillRegistry initialized with ${skillRegistry.getAllSkills().length} skills`);

  // P3-C: Initialize and start evolution scheduler for automated background evolution
  // Only start if autoRun is explicitly true in config (default is false)
  if (datasetManager && prBuilder && outcomeLabeler && evolutionTrigger) {
    evolutionScheduler = new EvolutionScheduler(
      pluginConfig,
      evolutionTrigger,
      outcomeLabeler,
      prBuilder,
      datasetManager
    );
    
    if (pluginConfig.evolution.autoRun === true) {
      evolutionScheduler.start({
        enabled: true,
        intervalMs: 1_800_000, // 30 minutes
        minNewTurnsToTrigger: 20,
        maxSkillsPerCycle: 1,
      });
      logger.info("[self-evolution] Evolution scheduler started (autoRun=true)");
    } else {
      logger.info("[self-evolution] Evolution scheduler initialized but not started (autoRun=false)");
    }
  }

  // Register trajectory hooks
  if (pluginConfig.trajectory.enabled) {
    logger.info("[self-evolution] Registering trajectory hooks");
    
    api.on("llm_input", handleLlmInput);
    api.on("llm_output", handleLlmOutput);
    api.on("agent_end", handleAgentEnd);
    api.on("before_tool_call", handleBeforeToolCall);
    api.on("after_tool_call", handleAfterToolCall);
    api.on("session_start", handleSessionStart);
    api.on("session_end", handleSessionEnd);
    api.on("subagent_spawned", handleSubagentSpawned);
    api.on("subagent_ended", handleSubagentEnded);

    // FIX 4: Initialize and start the trajectory logger
    try {
      await trajectoryLogger.initialize();
      // P3-B: Connect outcome labeler to trajectory logger for background labeling
      trajectoryLogger.setOutcomeLabeler(outcomeLabeler);
      trajectoryLogger.startPeriodicFlush(30_000); // 30 second flush interval
      logger.info("[self-evolution] Trajectory logger initialized and started");
    } catch (error) {
      logger.error(`[self-evolution] Failed to initialize trajectory logger: ${error}`);
      // Don't fail plugin registration if logger fails - hooks still work
    }

    // P3-B: Initialize outcome labeler
    try {
      await outcomeLabeler.initialize();
      logger.info("[self-evolution] Outcome labeler initialized");
    } catch (error) {
      logger.error(`[self-evolution] Failed to initialize outcome labeler: ${error}`);
      // Don't fail plugin registration if labeler fails
    }
  }

  // Register evolution tools
  logger.info("[self-evolution] Registering evolution tools");
  
  api.registerTool(createProposeSkillEditTool(pluginConfig), {
    name: "propose_skill_edit",
  });

  api.registerTool(createRunEvolutionTool(pluginConfig), {
    name: "run_evolution",
  });

  api.registerTool(createEvolutionStatusTool(pluginConfig), {
    name: "evolution_status",
  });

  api.registerTool(createDatasetBuildTool(pluginConfig), {
    name: "dataset_build",
  });

  api.registerTool(createBenchmarkRunTool(pluginConfig), {
    name: "benchmark_run",
  });

  api.registerTool(createCheckEvolutionNeedTool(pluginConfig), {
    name: "check_evolution_need",
  });

  api.registerTool(createLabelTrajectoriesTool(pluginConfig), {
    name: "label_trajectories",
  });

  api.registerTool(createRunSchedulerCycleTool(pluginConfig), {
    name: "run_scheduler_cycle",
  });

  // Register skill manager tool
  api.registerTool(skillManagerTool, {
    name: "skill_manage",
  });

  // Register CLI commands
  logger.info("[self-evolution] Registering CLI commands");
  
  api.registerCli(registerEvolutionCli as CliRegistrar, {
    commands: ["evolution"],
    descriptors: [
      { name: "evolution", description: "Self-evolution pipeline management", hasSubcommands: true } as CliCommandDescriptor,
    ],
  });

  api.registerCli(registerDatasetCli as CliRegistrar, {
    commands: ["dataset"],
    descriptors: [
      { name: "dataset", description: "Dataset management for evolution", hasSubcommands: true } as CliCommandDescriptor,
    ],
  });

  api.registerCli(registerBenchmarkCli as CliRegistrar, {
    commands: ["benchmark"],
    descriptors: [
      { name: "benchmark", description: "Benchmark management for skill evaluation", hasSubcommands: true } as CliCommandDescriptor,
    ],
  });

  logger.info("[self-evolution] Plugin registration complete");
}

// ============================================================================
// Plugin Export
// ============================================================================

export default definePluginEntry({
  id: "self-evolution",
  name: "Self-Evolution Pipeline",
  description: "Self-evolution pipeline for OpenClaw skills using genetic algorithms and LLM-as-judge",
  register,
});
