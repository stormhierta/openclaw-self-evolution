import { MetricsReporter } from "../../../src/deployment/metrics-reporter.js";
import type { EvolutionConfig, EvolutionRun } from "../../../src/types.js";

const defaultConfig: EvolutionConfig = {
  enabled: true,
  trajectory: { enabled: false, sampleRate: 1, maxTurnsPerSession: 100 },
  evolution: {
    autoRun: false,
    maxGenerations: 10,
    populationSize: 10,
    mutationRate: 0.1,
    eliteSize: 2,
    targetSkills: [],
    useDspyBridge: false,
    schedule: { cron: "0 0 * * *" },
  },
  costLimits: { maxTokensPerRun: 1_000_000, maxCostPerRun: 10, maxConcurrentRuns: 1 },
  retentionDays: 30,
  storage: {},
};

function makeRun(overrides: Partial<EvolutionRun> = {}): EvolutionRun {
  return {
    id: "run-1",
    skillName: "test-skill",
    status: "completed",
    config: defaultConfig.evolution,
    currentGeneration: 10,
    maxGenerations: 10,
    variants: [],
    progress: {
      currentGeneration: 10,
      totalGenerations: 10,
      variantsEvaluated: 50,
      totalVariants: 50,
      bestFitnessScore: 85,
      averageFitnessScore: 72,
    },
    startedAt: new Date("2024-01-01T10:00:00Z"),
    completedAt: new Date("2024-01-01T10:05:00Z"),
    ...overrides,
  };
}

describe("MetricsReporter", () => {
  let reporter: MetricsReporter;

  beforeEach(() => {
    reporter = new MetricsReporter(defaultConfig);
  });

  describe("extractMetrics", () => {
    it("extracts metrics from a completed run with baseline", () => {
      const run = makeRun({ status: "completed", currentGeneration: 10, maxGenerations: 10 });
      const metrics = reporter.extractMetrics(run, 70);
      expect(metrics.skillName).toBe("test-skill");
      expect(metrics.runId).toBe("run-1");
      expect(metrics.status).toBe("completed");
      expect(metrics.baselineFitnessScore).toBe(70);
      expect(metrics.bestFitnessScore).toBe(85);
      expect(metrics.improvement).toBe(15);
    });

    it("extracts metrics without baseline", () => {
      const run = makeRun({ status: "completed" });
      const metrics = reporter.extractMetrics(run);
      expect(metrics.baselineFitnessScore).toBe(0);
      expect(metrics.improvement).toBe(metrics.bestFitnessScore);
      expect(metrics.improvementPercent).toBe("N/A");
    });

    it("marks as stopped early when cancelled", () => {
      const run = makeRun({ status: "cancelled", currentGeneration: 5, maxGenerations: 10 });
      const metrics = reporter.extractMetrics(run);
      expect(metrics.stoppedEarly).toBe(true);
      expect(metrics.stopReason).toBe("cancelled");
    });

    it("marks as stopped early when failed", () => {
      const run = makeRun({ status: "failed", currentGeneration: 3, maxGenerations: 10, errorMessage: "Out of memory" });
      const metrics = reporter.extractMetrics(run);
      expect(metrics.stoppedEarly).toBe(true);
      expect(metrics.stopReason).toBe("Out of memory");
    });

    it("marks as stopped early when completed before max generations", () => {
      const run = makeRun({ status: "completed", currentGeneration: 5, maxGenerations: 10 });
      const metrics = reporter.extractMetrics(run);
      expect(metrics.stoppedEarly).toBe(true);
    });

    it("computes correct duration from startedAt to completedAt", () => {
      const run = makeRun({
        startedAt: new Date("2024-01-01T10:00:00Z"),
        completedAt: new Date("2024-01-01T10:05:00Z"),
      });
      const metrics = reporter.extractMetrics(run);
      // 5 minutes = 300000ms
      expect(metrics.durationMs).toBe(300_000);
    });
  });

  describe("formatDuration", () => {
    it("formats seconds only", () => {
      expect(reporter.formatDuration(30_000)).toBe("30s");
    });

    it("formats minutes and seconds", () => {
      expect(reporter.formatDuration(90_000)).toBe("1m 30s");
    });

    it("formats hours, minutes and seconds", () => {
      expect(reporter.formatDuration(3_720_000)).toBe("1h 2m");
    });

    it("formats 0ms as 0s", () => {
      expect(reporter.formatDuration(0)).toBe("0s");
    });

    it("formats negative as 0s", () => {
      expect(reporter.formatDuration(-1000)).toBe("0s");
    });

    it("formats less than 1 second as 0s", () => {
      expect(reporter.formatDuration(500)).toBe("0s");
    });
  });

  describe("formatMarkdown", () => {
    it("output contains expected fields", () => {
      const run = makeRun({ status: "completed" });
      const metrics = reporter.extractMetrics(run, 60);
      const output = reporter.formatMarkdown(metrics);
      expect(output).toContain("## Evolution Results:");
      expect(output).toContain("test-skill");
      expect(output).toContain("Status");
      expect(output).toContain("completed");
      expect(output).toContain("Generations");
      expect(output).toContain("Best Fitness");
      expect(output).toContain("Improvement");
      expect(output).toContain("Duration");
      expect(output).toContain("Variants Evaluated");
    });

    it("includes stopped early note when stopped early", () => {
      const run = makeRun({ status: "cancelled" });
      const metrics = reporter.extractMetrics(run);
      const output = reporter.formatMarkdown(metrics);
      expect(output).toContain("Stopped early");
    });
  });

  describe("formatPlainText", () => {
    it("output contains expected fields", () => {
      const run = makeRun({ status: "completed" });
      const metrics = reporter.extractMetrics(run, 60);
      const output = reporter.formatPlainText(metrics);
      expect(output).toContain("Evolution Results:");
      expect(output).toContain("test-skill");
      expect(output).toContain("Status:");
      expect(output).toContain("Generations:");
      expect(output).toContain("Best Fitness:");
      expect(output).toContain("Improvement:");
      expect(output).toContain("Duration:");
      expect(output).toContain("Variants Evaluated:");
    });

    it("includes stopped early line when stopped early with reason", () => {
      const run = makeRun({ status: "failed", errorMessage: "Out of memory" });
      const metrics = reporter.extractMetrics(run);
      const output = reporter.formatPlainText(metrics);
      expect(output).toContain("Stopped early:");
      expect(output).toContain("Out of memory");
    });

    it("includes stopped early line when stopped early without reason", () => {
      const run = makeRun({ status: "cancelled" });
      const metrics = reporter.extractMetrics(run);
      const output = reporter.formatPlainText(metrics);
      expect(output).toContain("Stopped early:");
    });
  });
});
