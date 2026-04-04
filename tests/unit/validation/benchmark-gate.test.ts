import { BenchmarkGate } from "../../../src/validation/benchmark-gate.js";
import type { EvolutionConfig, SkillVariant } from "../../../src/types.js";
import type { ValidationResult } from "../../../src/validation/skill-validator.js";
import type { TestRunResult } from "../../../src/validation/test-runner.js";

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

function makeVariant(overrides: Partial<SkillVariant> = {}): SkillVariant {
  return {
    id: "variant-1",
    skillName: "test-skill",
    generation: 1,
    content: "---",
    mutations: [],
    parents: [],
    createdAt: new Date(),
    ...overrides,
  };
}

function makeValidationResult(overrides: Partial<ValidationResult> = {}): ValidationResult {
  return {
    valid: true,
    errors: [],
    warnings: [],
    sizeBytes: 100,
    ...overrides,
  };
}

function makeTestRunResult(overrides: Partial<TestRunResult> = {}): TestRunResult {
  return {
    totalTests: 10,
    passed: 10,
    failed: 0,
    passRate: 1.0,
    results: [],
    durationMs: 1000,
    ...overrides,
  };
}

describe("BenchmarkGate", () => {
  describe("evaluate", () => {
    it("passes when all checks pass", () => {
      const gate = new BenchmarkGate(defaultConfig);
      const variant = makeVariant({
        fitnessScore: { overall: 80, components: {} as any, evaluatedAt: new Date(), method: "llm_judge", rawScores: {} },
      });
      const result = gate.evaluate(variant, makeValidationResult(), makeTestRunResult({ passRate: 1.0 }));
      expect(result.passed).toBe(true);
      expect(result.reasons).toHaveLength(0);
      expect(result.scores.validationPassed).toBe(true);
    });

    it("fails when validation fails", () => {
      const gate = new BenchmarkGate(defaultConfig);
      const variant = makeVariant({
        fitnessScore: { overall: 80, components: {} as any, evaluatedAt: new Date(), method: "llm_judge", rawScores: {} },
      });
      const validationResult = makeValidationResult({ valid: false, errors: ["Missing frontmatter"] });
      const result = gate.evaluate(variant, validationResult, makeTestRunResult({ passRate: 1.0 }));
      expect(result.passed).toBe(false);
      expect(result.reasons.some((r) => r.includes("Validation failed"))).toBe(true);
    });

    it("fails when pass rate is below minimum", () => {
      const gate = new BenchmarkGate(defaultConfig);
      const variant = makeVariant({
        fitnessScore: { overall: 80, components: {} as any, evaluatedAt: new Date(), method: "llm_judge", rawScores: {} },
      });
      const result = gate.evaluate(variant, makeValidationResult(), makeTestRunResult({ passRate: 0.5 }));
      expect(result.passed).toBe(false);
      expect(result.reasons.some((r) => r.includes("Pass rate"))).toBe(true);
    });

    it("fails when pass rate is NaN", () => {
      const gate = new BenchmarkGate(defaultConfig);
      const variant = makeVariant({
        fitnessScore: { overall: 80, components: {} as any, evaluatedAt: new Date(), method: "llm_judge", rawScores: {} },
      });
      const result = gate.evaluate(variant, makeValidationResult(), makeTestRunResult({ passRate: NaN }));
      expect(result.passed).toBe(false);
      expect(result.reasons.some((r) => r.includes("Pass rate"))).toBe(true);
    });

    it("fails when pass rate is exactly zero", () => {
      const gate = new BenchmarkGate(defaultConfig);
      const variant = makeVariant({
        fitnessScore: { overall: 80, components: {} as any, evaluatedAt: new Date(), method: "llm_judge", rawScores: {} },
      });
      const result = gate.evaluate(variant, makeValidationResult(), makeTestRunResult({ passRate: 0, passed: 0, failed: 10 }));
      expect(result.passed).toBe(false);
    });

    it("fails when fitness score is below minimum", () => {
      const gate = new BenchmarkGate(defaultConfig);
      const variant = makeVariant({
        fitnessScore: { overall: 30, components: {} as any, evaluatedAt: new Date(), method: "llm_judge", rawScores: {} },
      });
      const result = gate.evaluate(variant, makeValidationResult(), makeTestRunResult({ passRate: 1.0 }));
      expect(result.passed).toBe(false);
      expect(result.reasons.some((r) => r.includes("Fitness score"))).toBe(true);
    });

    it("fails when fitness score is missing and requireFitnessScore is true", () => {
      const gate = new BenchmarkGate(defaultConfig, { requireFitnessScore: true });
      const variant = makeVariant(); // no fitnessScore
      const result = gate.evaluate(variant, makeValidationResult(), makeTestRunResult({ passRate: 1.0 }));
      expect(result.passed).toBe(false);
      expect(result.reasons.some((r) => r.includes("Fitness score is missing"))).toBe(true);
    });

    it("passes when fitness score is missing and requireFitnessScore is false", () => {
      const gate = new BenchmarkGate(defaultConfig, { requireFitnessScore: false });
      const variant = makeVariant(); // no fitnessScore
      const result = gate.evaluate(variant, makeValidationResult(), makeTestRunResult({ passRate: 1.0 }));
      expect(result.passed).toBe(true);
      expect(result.reasons).toHaveLength(0);
    });

    it("reports NaN in passRate score when NaN is passed", () => {
      const gate = new BenchmarkGate(defaultConfig);
      const variant = makeVariant({
        fitnessScore: { overall: 80, components: {} as any, evaluatedAt: new Date(), method: "llm_judge", rawScores: {} },
      });
      const result = gate.evaluate(variant, makeValidationResult(), makeTestRunResult({ passRate: NaN }));
      expect(result.scores.passRate).toBeNaN();
    });

    it("returns null fitnessScore when variant has no fitnessScore", () => {
      const gate = new BenchmarkGate(defaultConfig, { requireFitnessScore: false });
      const variant = makeVariant();
      const result = gate.evaluate(variant, makeValidationResult(), makeTestRunResult({ passRate: 1.0 }));
      expect(result.scores.fitnessScore).toBeNull();
    });
  });

  describe("canApply", () => {
    it("returns true when variant passes all gates", () => {
      const gate = new BenchmarkGate(defaultConfig);
      const variant = makeVariant({
        fitnessScore: { overall: 80, components: {} as any, evaluatedAt: new Date(), method: "llm_judge", rawScores: {} },
      });
      const canApply = gate.canApply(variant, makeValidationResult(), makeTestRunResult({ passRate: 1.0 }));
      expect(canApply).toBe(true);
    });

    it("returns false when variant fails any gate", () => {
      const gate = new BenchmarkGate(defaultConfig);
      const variant = makeVariant(); // no fitnessScore
      const canApply = gate.canApply(variant, makeValidationResult(), makeTestRunResult({ passRate: 0.5 }));
      expect(canApply).toBe(false);
    });
  });
});
