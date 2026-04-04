/**
 * Integration tests for ReviewQueue.
 *
 * Uses mocked PrBuilder (with a real SQLite DB in a temp dir) and
 * mocked GitManager to avoid real git operations.
 */

import { jest } from "@jest/globals";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { PrBuilder } from "../../src/deployment/pr-builder.js";
import { ReviewQueue } from "../../src/deployment/review-queue.js";
import type { EvolutionConfig, PrRecord } from "../../src/types.js";
import type { GitManager } from "../../src/deployment/git-manager.js";
import type { MetricsReporter } from "../../src/deployment/metrics-reporter.js";

// ---------------------------------------------------------------------------
// Mock GitManager
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

// ---------------------------------------------------------------------------
// Mock MetricsReporter
// ---------------------------------------------------------------------------

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

function makeCompletedRun(skillName = "test-skill", runId = "run-1") {
  return {
    id: runId,
    skillName,
    status: "completed" as const,
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ReviewQueue", () => {
  let tmpPath: string;
  let gitManager: ReturnType<typeof makeMockGitManager>;
  let metricsReporter: ReturnType<typeof makeMockMetricsReporter>;
  let prBuilder: PrBuilder;
  let queue: ReviewQueue;

  beforeEach(() => {
    tmpPath = join(tmpdir(), `review-queue-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpPath, { recursive: true });
    gitManager = makeMockGitManager();
    metricsReporter = makeMockMetricsReporter();
  });

  afterEach(async () => {
    queue?.close?.();
    prBuilder?.close?.();
    if (existsSync(tmpPath)) {
      rmSync(tmpPath, { recursive: true, force: true });
    }
  });

  it("getPending returns empty when no pending PRs", async () => {
    const config = makeConfig(tmpPath);
    prBuilder = new PrBuilder(config, gitManager, metricsReporter);
    await prBuilder.initialize();

    queue = new ReviewQueue(config, prBuilder, gitManager);
    await queue.initialize();

    const pending = await queue.getPending();
    expect(pending).toEqual([]);
  });

  it("approve throws if PR is not pending", async () => {
    const config = makeConfig(tmpPath);
    prBuilder = new PrBuilder(config, gitManager, metricsReporter);
    await prBuilder.initialize();

    // Create a PR directly via buildPr (it starts as 'pending')
    const run = makeCompletedRun();
    const pr = await prBuilder.buildPr(run, "variant content");

    // Update its status to 'approved' directly in DB so it's no longer pending
    await prBuilder.updatePrStatus(pr.id, "approved", "already approved");

    queue = new ReviewQueue(config, prBuilder, gitManager);
    await queue.initialize();

    await expect(queue.approve(pr.id)).rejects.toThrow(/"approved", expected "pending"/i);
  });

  it("reject throws if PR is not pending", async () => {
    const config = makeConfig(tmpPath);
    prBuilder = new PrBuilder(config, gitManager, metricsReporter);
    await prBuilder.initialize();

    // Create a PR directly
    const run = makeCompletedRun();
    const pr = await prBuilder.buildPr(run, "variant content");

    // Update its status to 'rejected' directly so it's no longer pending
    await prBuilder.updatePrStatus(pr.id, "rejected", "already rejected");

    queue = new ReviewQueue(config, prBuilder, gitManager);
    await queue.initialize();

    await expect(queue.reject(pr.id)).rejects.toThrow(/"rejected", expected "pending"/i);
  });

  it("getStats returns zero pending count initially", async () => {
    const config = makeConfig(tmpPath);
    prBuilder = new PrBuilder(config, gitManager, metricsReporter);
    await prBuilder.initialize();

    queue = new ReviewQueue(config, prBuilder, gitManager);
    await queue.initialize();

    const stats = await queue.getStats();
    expect(stats.pendingCount).toBe(0);
    expect(stats.oldestPendingAgeMs).toBeNull();
  });

  it("getPending returns pending PRs after creating one", async () => {
    const config = makeConfig(tmpPath);
    prBuilder = new PrBuilder(config, gitManager, metricsReporter);
    await prBuilder.initialize();

    const run = makeCompletedRun();
    await prBuilder.buildPr(run, "variant content");

    queue = new ReviewQueue(config, prBuilder, gitManager);
    await queue.initialize();

    const pending = await queue.getPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].pr.skillName).toBe("test-skill");
    expect(pending[0].pr.status).toBe("pending");
  });

  it("approve changes PR status to approved", async () => {
    const config = makeConfig(tmpPath);
    prBuilder = new PrBuilder(config, gitManager, metricsReporter);
    await prBuilder.initialize();

    const run = makeCompletedRun();
    const pr = await prBuilder.buildPr(run, "variant content");

    queue = new ReviewQueue(config, prBuilder, gitManager);
    await queue.initialize();

    const approved = await queue.approve(pr.id, "looks good");

    expect(approved.status).toBe("approved");
    expect(approved.reviewNote).toBe("looks good");

    // Should no longer appear in pending
    const pending = await queue.getPending();
    expect(pending).toHaveLength(0);
  });

  it("reject changes PR status to rejected and deletes branch", async () => {
    const config = makeConfig(tmpPath);
    prBuilder = new PrBuilder(config, gitManager, metricsReporter);
    await prBuilder.initialize();

    const run = makeCompletedRun();
    const pr = await prBuilder.buildPr(run, "variant content");

    queue = new ReviewQueue(config, prBuilder, gitManager);
    await queue.initialize();

    await queue.reject(pr.id, "not good enough");

    const rejected = await prBuilder.getPr(pr.id);
    expect(rejected!.status).toBe("rejected");
    expect(rejected!.reviewNote).toBe("not good enough");

    // GitManager.deleteBranch should have been called
    expect(gitManager.deleteBranch).toHaveBeenCalledWith(pr.branchName);
  });
});
