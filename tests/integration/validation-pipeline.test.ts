/**
 * Integration tests for the validation pipeline:
 * SizeLimits → SkillValidator → BenchmarkGate
 *
 * Tests real component interactions without LLM calls (TestRunner is mocked).
 */

import { jest } from "@jest/globals";
import { SizeLimits } from "../../src/validation/size-limits.js";
import { SkillValidator } from "../../src/validation/skill-validator.js";
import { BenchmarkGate } from "../../src/validation/benchmark-gate.js";
import type { EvolutionConfig, SkillVariant, FitnessScore } from "../../src/types.js";
import type { TestRunResult } from "../../src/validation/test-runner.js";

// ---------------------------------------------------------------------------
// Test config
// ---------------------------------------------------------------------------

function makeConfig(): EvolutionConfig {
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
    sizeLimits: {
      maxSkillSizeBytes: 15_000,
      maxDescriptionLength: 500,
      maxSectionCount: 20,
    },
    retentionDays: 30,
    storage: {},
  };
}

// ---------------------------------------------------------------------------
// Fake TestRunResult factory
// ---------------------------------------------------------------------------

function makePassingTestResult(): TestRunResult {
  return {
    totalTests: 5,
    passed: 5,
    failed: 0,
    passRate: 1.0,
    results: [
      {
        testCaseId: "t1",
        passed: true,
        simulatedOutput: "hello",
        expectedOutput: "hello",
        score: 1.0,
      },
    ],
    durationMs: 100,
  };
}

function makeFailingTestResult(): TestRunResult {
  return {
    totalTests: 5,
    passed: 2,
    failed: 3,
    passRate: 0.4,
    results: [],
    durationMs: 100,
  };
}

function makeZeroTestsResult(): TestRunResult {
  return {
    totalTests: 0,
    passed: 0,
    failed: 0,
    passRate: 0,
    results: [],
    durationMs: 0,
  };
}

// ---------------------------------------------------------------------------
// Valid skill content helpers
// ---------------------------------------------------------------------------

function validSkillContent(skillName = "test-skill"): string {
  return `---
name: ${skillName}
description: "A test skill for validation pipeline testing."
---

## Usage

This skill does something useful.

## Examples

### Example 1
Show how to use the skill.
`;
}

function skillWithUnsafeContent(): string {
  return `---
name: unsafe-skill
description: "An unsafe skill."
---

## Bad

Calling \`rm -rf /\` is bad.
`;
}

// ---------------------------------------------------------------------------
// Fitness score helpers
// ---------------------------------------------------------------------------

function makeFitnessScore(overall = 80): FitnessScore {
  return {
    overall,
    components: {
      correctness: 80,
      formatAdherence: 80,
      efficiency: 80,
      robustness: 80,
      clarity: 80,
    },
    evaluatedAt: new Date(),
    method: "llm_judge",
    rawScores: {},
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Validation pipeline", () => {
  const config = makeConfig();
  const sizeLimits = new SizeLimits(config);
  const skillValidator = new SkillValidator(config, sizeLimits);

  // Helper: run the full pipeline
  function runPipeline(
    content: string,
    skillName: string,
    testResult: TestRunResult,
    gateConfig?: { requireFitnessScore?: boolean }
  ): { validationResult: ReturnType<typeof skillValidator.validateContent>; gateResult: ReturnType<BenchmarkGate["evaluate"]> } {
    const variant: SkillVariant = {
      id: "variant-1",
      skillName,
      generation: 1,
      content,
      mutations: [],
      fitnessScore: makeFitnessScore(80),
      parents: [],
      createdAt: new Date(),
    };

    const validationResult = skillValidator.validateContent(content, skillName);

    const gate = new BenchmarkGate(config, {
      minPassRate: 0.7,
      minFitnessScore: 60,
      requireValidation: true,
      requireFitnessScore: gateConfig?.requireFitnessScore ?? true,
    });

    const gateResult = gate.evaluate(variant, validationResult, testResult);

    return { validationResult, gateResult };
  }

  it("approves a valid skill variant with passing tests and good gate config", () => {
    const content = validSkillContent();
    const { validationResult, gateResult } = runPipeline(content, "test-skill", makePassingTestResult());

    expect(validationResult.valid).toBe(true);
    expect(validationResult.errors).toHaveLength(0);
    expect(gateResult.passed).toBe(true);
    expect(gateResult.reasons).toHaveLength(0);
  });

  it("rejects a variant that fails validation", () => {
    // Unsafe content triggers SkillValidator errors
    const content = skillWithUnsafeContent();
    const testResult = makePassingTestResult();
    const { validationResult, gateResult } = runPipeline(content, "unsafe-skill", testResult);

    expect(validationResult.valid).toBe(false);
    expect(validationResult.errors.length).toBeGreaterThan(0);
    expect(gateResult.passed).toBe(false);
    expect(gateResult.reasons.some((r) => r.includes("Validation failed"))).toBe(true);
  });

  it("rejects a variant with zero tests run", () => {
    const content = validSkillContent();
    const testResult = makeZeroTestsResult();
    const { gateResult } = runPipeline(content, "test-skill", testResult);

    expect(gateResult.passed).toBe(false);
    expect(gateResult.reasons.some((r) => r.includes("no tests run") || r.includes("Pass rate"))).toBe(true);
  });

  it("approves variant when requireFitnessScore is false and no score present", () => {
    // Create a variant without a fitness score
    const content = validSkillContent("no-score-skill");
    const variant: SkillVariant = {
      id: "variant-no-score",
      skillName: "no-score-skill",
      generation: 1,
      content,
      mutations: [],
      parents: [],
      createdAt: new Date(),
      // no fitnessScore
    };

    const validationResult = skillValidator.validateContent(content, "no-score-skill");
    const testResult = makePassingTestResult();

    const gate = new BenchmarkGate(config, {
      minPassRate: 0.7,
      minFitnessScore: 60,
      requireValidation: true,
      requireFitnessScore: false, // <-- disabled
    });

    const gateResult = gate.evaluate(variant, validationResult, testResult);

    expect(validationResult.valid).toBe(true);
    expect(gateResult.passed).toBe(true);
  });

  it("rejects a variant with failing tests (pass rate below threshold)", () => {
    const content = validSkillContent("failing-skill");
    const testResult = makeFailingTestResult();
    const { gateResult } = runPipeline(content, "failing-skill", testResult);

    expect(gateResult.passed).toBe(false);
    expect(gateResult.reasons.some((r) => r.includes("Pass rate"))).toBe(true);
  });
});
