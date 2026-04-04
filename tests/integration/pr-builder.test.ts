/**
 * Integration tests for PrBuilder.
 *
 * Uses a real SQLite DB in a temp directory. GitManager and MetricsReporter
 * are mocked to avoid real git/file operations.
 */

import { jest } from "@jest/globals";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import Database from "better-sqlite3";
import { PrBuilder } from "../../src/deployment/pr-builder.js";
import type { EvolutionConfig, EvolutionRun, SkillVariant } from "../../src/types.js";
import type { GitManager } from "../../src/deployment/git-manager.js";
import type { MetricsReporter } from "../../src/deployment/metrics-reporter.js";

// ---------------------------------------------------------------------------
// Mock implementations
// ---------------------------------------------------------------------------

function makeMockGitManager() {
  return {
    applyVariantToBranch: jest.fn<() => Promise<{ branchName: string; commitSha: string; pushed: boolean }>>().mockResolvedValue({
      branchName: "evolution/test-skill/run-1",
      commitSha: "abc1234",
      pushed: false,
    }),
    deleteBranch: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    createBranch: jest.fn<() => Promise<string>>().mockResolvedValue("evolution/test-skill/run-1"),
    commit: jest.fn<() => Promise<string>>().mockResolvedValue("abc1234"),
    push: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getCurrentCommit: jest.fn<() => Promise<string>>().mockResolvedValue("abc1234"),
  } as unknown as GitManager;
}

function makeMockMetricsReporter() {
  return {
    extractMetrics: jest.fn<() => { skillName: string; runId: string; status: string; generationsCompleted: number; maxGenerations: number; totalVariantsEvaluated: number; bestFitnessScore: number; baselineFitnessScore: number; improvement: number; improvementPercent: string; durationMs: number; stoppedEarly: boolean; stopReason?: string }>().mockReturnValue({
      skillName: "test-skill",
      runId: "run-1",
      status: "completed",
      generationsCompleted: 5,
      maxGenerations: 5,
      totalVariantsEvaluated: 50,
      bestFitnessScore: 85,
      baselineFitnessScore: 70,
      improvement: 15,
      improvementPercent: "+21.4%",
      durationMs: 60_000,
      stoppedEarly: false,
    }),
    formatMarkdown: jest.fn<() => string>().mockReturnValue("## Metrics\n\nSome metrics"),
  } as unknown as MetricsReporter;
}

// ---------------------------------------------------------------------------
// Test config
// ---------------------------------------------------------------------------

function makeConfig(tmpPath: string): EvolutionConfig {
  return {
    enabled: true,
    trajectory: { enabled: false, sampleRate: 0.1, maxTurnsPerSession: 50 },
    evolution: {
      autoRun: false,
      maxGenerations: 5,
      populationSize: 10,
      mutationRate: 0.1,
      eliteSize: 2,
      targetSkills: [],
      useDspyBridge: false,
      schedule: { cron: "0 0 * * *" },
    },
    costLimits: {
      maxTokensPerRun: 100_000,
      maxCostPerRun: 5,
      maxConcurrentRuns: 2,
    },
    retentionDays: 30,
    storage: {
      evolutionLogPath: join(tmpPath, "evolution.db"),
    },
  };
}

// ---------------------------------------------------------------------------
// Run builders
// ---------------------------------------------------------------------------

function makeCompletedRun(skillName = "test-skill", runId = "run-1"): EvolutionRun {
  return {
    id: runId,
    skillName,
    status: "completed",
    config: {
      autoRun: false,
      maxGenerations: 5,
      populationSize: 10,
      mutationRate: 0.1,
      eliteSize: 2,
      targetSkills: [],
      useDspyBridge: false,
      schedule: { cron: "0 0 * * *" },
    },
    currentGeneration: 5,
    maxGenerations: 5,
    variants: [],
    bestVariant: {
      id: "variant-1",
      skillName,
      generation: 1,
      content: "---\nname: test\ndescription: test\n---\n\n## Test\n",
      mutations: [],
      fitnessScore: {
        overall: 85,
        components: { correctness: 85, formatAdherence: 85, efficiency: 85, robustness: 85, clarity: 85 },
        evaluatedAt: new Date(),
        method: "llm_judge" as const,
        rawScores: {},
      },
      parents: [],
      createdAt: new Date(),
    },
    progress: {
      currentGeneration: 5,
      totalGenerations: 5,
      variantsEvaluated: 50,
      totalVariants: 50,
      bestFitnessScore: 85,
      averageFitnessScore: 75,
    },
    startedAt: new Date(),
    completedAt: new Date(),
  };
}

function makePendingRun(): EvolutionRun {
  return {
    id: "run-pending",
    skillName: "test-skill",
    status: "pending",
    config: {
      autoRun: false,
      maxGenerations: 5,
      populationSize: 10,
      mutationRate: 0.1,
      eliteSize: 2,
      targetSkills: [],
      useDspyBridge: false,
      schedule: { cron: "0 0 * * *" },
    },
    currentGeneration: 0,
    maxGenerations: 5,
    variants: [],
    progress: {
      currentGeneration: 0,
      totalGenerations: 5,
      variantsEvaluated: 0,
      totalVariants: 0,
      bestFitnessScore: 0,
      averageFitnessScore: 0,
    },
    startedAt: new Date(),
  };
}

function makeCompletedRunNoBestVariant(): EvolutionRun {
  const run = makeCompletedRun();
  run.bestVariant = undefined;
  return run;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PrBuilder", () => {
  let tmpPath: string;
  let gitManager: ReturnType<typeof makeMockGitManager>;
  let metricsReporter: ReturnType<typeof makeMockMetricsReporter>;
  let builder: PrBuilder;

  beforeEach(() => {
    tmpPath = join(tmpdir(), `pr-builder-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpPath, { recursive: true });
    gitManager = makeMockGitManager();
    metricsReporter = makeMockMetricsReporter();
  });

  afterEach(async () => {
    builder?.close?.();
    if (existsSync(tmpPath)) {
      rmSync(tmpPath, { recursive: true, force: true });
    }
  });

  it("buildPr fails if run is not completed", async () => {
    const config = makeConfig(tmpPath);
    builder = new PrBuilder(config, gitManager, metricsReporter);
    await builder.initialize();

    const pendingRun = makePendingRun();

    await expect(
      builder.buildPr(pendingRun, "variant content")
    ).rejects.toThrow(/status is "pending", expected "completed"/i);
  });

  it("buildPr fails if run has no bestVariant", async () => {
    const config = makeConfig(tmpPath);
    builder = new PrBuilder(config, gitManager, metricsReporter);
    await builder.initialize();

    const run = makeCompletedRunNoBestVariant();

    await expect(
      builder.buildPr(run, "variant content")
    ).rejects.toThrow(/no best variant/i);
  });

  it("getPr returns null for unknown ID", async () => {
    const config = makeConfig(tmpPath);
    builder = new PrBuilder(config, gitManager, metricsReporter);
    await builder.initialize();

    const result = await builder.getPr("non-existent-id");

    expect(result).toBeNull();
  });

  it("listPrs returns empty array initially", async () => {
    const config = makeConfig(tmpPath);
    builder = new PrBuilder(config, gitManager, metricsReporter);
    await builder.initialize();

    const prs = await builder.listPrs();

    expect(prs).toEqual([]);
  });

  it("updatePrStatus throws if PR not found", async () => {
    const config = makeConfig(tmpPath);
    builder = new PrBuilder(config, gitManager, metricsReporter);
    await builder.initialize();

    await expect(
      builder.updatePrStatus("non-existent-id", "approved")
    ).rejects.toThrow(/PR record not found/i);
  });

  it("buildPr creates a PR record that can be retrieved", async () => {
    const config = makeConfig(tmpPath);
    builder = new PrBuilder(config, gitManager, metricsReporter);
    await builder.initialize();

    const run = makeCompletedRun();
    const pr = await builder.buildPr(run, "variant content");

    expect(pr.id).toBeDefined();
    expect(pr.skillName).toBe("test-skill");
    expect(pr.runId).toBe("run-1");
    expect(pr.status).toBe("pending");

    // retrieve it
    const retrieved = await builder.getPr(pr.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(pr.id);
    expect(retrieved!.title).toContain("21.4%");
  });

  it("listPrs returns the created PR", async () => {
    const config = makeConfig(tmpPath);
    builder = new PrBuilder(config, gitManager, metricsReporter);
    await builder.initialize();

    const run = makeCompletedRun();
    await builder.buildPr(run, "variant content");

    const prs = await builder.listPrs();
    expect(prs).toHaveLength(1);
    expect(prs[0].skillName).toBe("test-skill");
  });
});
