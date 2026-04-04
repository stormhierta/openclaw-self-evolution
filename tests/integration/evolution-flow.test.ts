/**
 * Integration test for the full evolution flow.
 *
 * Tests the GEPAEvolver end-to-end without making real LLM calls.
 * Uses mocked LlmJudge and internal evolver methods to validate the evolution loop.
 */

import { jest } from "@jest/globals";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { GEPAEvolver, type EvolutionResult } from "../../src/evolution/gepa/evolver.js";
import { LlmJudge } from "../../src/evolution/fitness/llm-judge.js";
import { RubricRegistry } from "../../src/evolution/fitness/rubrics.js";
import { ConstraintValidator } from "../../src/validation/constraint-validator.js";
import { SkillValidator } from "../../src/validation/skill-validator.js";
import { SizeLimits } from "../../src/validation/size-limits.js";
import { DatasetManager } from "../../src/dataset/manager.js";
import type { EvolutionConfig, DatasetEntry, FitnessScore, SkillVariant } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const TEST_SKILL_CONTENT = `---
name: test-skill
description: "A test skill"
---
## When to use
Use this skill when testing.
## How to use
Follow these steps.
`;

const MOCK_FITNESS_SCORE: FitnessScore = {
  overall: 75,
  components: { correctness: 75, procedureFollowing: 75, conciseness: 75 },
  evaluatedAt: new Date(),
  method: "llm_judge" as const,
  rawScores: { correctness: 75, procedure_following: 75, conciseness: 75 },
  feedback: "Clear instructions but could be more specific",
};

const MOCK_BASELINE_SCORE: FitnessScore = {
  overall: 70,
  components: { correctness: 70, procedureFollowing: 70, conciseness: 70 },
  evaluatedAt: new Date(),
  method: "llm_judge" as const,
  rawScores: { correctness: 70, procedure_following: 70, conciseness: 70 },
  feedback: "Baseline feedback",
};

// Helper to create a mock variant
function createMockVariant(skillName: string, generation: number, suffix: string): SkillVariant {
  return {
    id: `${skillName}-gen${generation}-${suffix}-${Date.now()}`,
    skillName,
    generation,
    content: TEST_SKILL_CONTENT + `\n<!-- Variant ${suffix} -->`,
    mutations: [{ type: "prompt_rewrite", description: "Test mutation" }],
    parents: [],
    createdAt: new Date(),
  };
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
      populationSize: 4,
      mutationRate: 0.5,
      eliteSize: 2,
      targetSkills: [],
      useDspyBridge: false,
      useDspyPrimary: false,
      schedule: { cron: "0 0 * * *" },
    },
    costLimits: {
      maxTokensPerRun: 100_000,
      maxCostPerRun: 5,
      maxConcurrentRuns: 2,
    },
    retentionDays: 30,
    storage: {
      datasetPath: join(tmpPath, "datasets"),
      evolutionLogPath: join(tmpPath, "evolution.db"),
    },
  };
}

// ---------------------------------------------------------------------------
// Synthetic test cases
// ---------------------------------------------------------------------------

function makeSyntheticTestCases(): DatasetEntry[] {
  return [
    {
      id: "test-1",
      datasetId: "synthetic-dataset",
      input: "Test input for case 1",
      expectedOutput: "Expected output for case 1",
      context: { skill: "test-skill", scenario: "basic" },
      metadata: {
        source: "synthetic",
        difficulty: "easy",
        expectedBehavior: "The skill should provide clear instructions",
      },
      createdAt: new Date(),
    },
    {
      id: "test-2",
      datasetId: "synthetic-dataset",
      input: "Test input for case 2",
      expectedOutput: "Expected output for case 2",
      context: { skill: "test-skill", scenario: "intermediate" },
      metadata: {
        source: "synthetic",
        difficulty: "medium",
        expectedBehavior: "The skill should handle this scenario correctly",
      },
      createdAt: new Date(),
    },
    {
      id: "test-3",
      datasetId: "synthetic-dataset",
      input: "Test input for case 3",
      expectedOutput: "Expected output for case 3",
      context: { skill: "test-skill", scenario: "edge-case" },
      metadata: {
        source: "synthetic",
        difficulty: "hard",
        expectedBehavior: "The skill should handle edge cases properly",
      },
      createdAt: new Date(),
    },
  ];
}

// ---------------------------------------------------------------------------
// Shared test setup
// ---------------------------------------------------------------------------

const setupTestEnvironment = async () => {
  const tmpPath = join(tmpdir(), `evolution-flow-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpPath, { recursive: true });

  const config = makeConfig(tmpPath);

  // Initialize dataset manager with temp DB
  const datasetManager = new DatasetManager(config);
  await datasetManager.initialize();

  // Initialize supporting components (order matters: SizeLimits first, then SkillValidator)
  const sizeLimits = new SizeLimits(config);
  const rubricRegistry = new RubricRegistry(config);
  const skillValidator = new SkillValidator(config, sizeLimits);
  const constraintValidator = new ConstraintValidator(skillValidator, sizeLimits, config);

  // Initialize real judge
  const judge = new LlmJudge(config, rubricRegistry);

  // Initialize evolver
  const evolver = new GEPAEvolver(config, judge, rubricRegistry, constraintValidator);

  // Mock the judge methods
  jest.spyOn(judge, "scoreVariant").mockResolvedValue(MOCK_FITNESS_SCORE);
  jest.spyOn(judge, "scoreBaseline").mockResolvedValue(MOCK_BASELINE_SCORE);

  // Mock evolver methods that call LLM
  jest.spyOn(GEPAEvolver.prototype, "generateValidVariants").mockImplementation(
    async (_skillContent: string, count: number) => {
      const variants: SkillVariant[] = [];
      for (let i = 0; i < count; i++) {
        variants.push(createMockVariant("test-skill", 1, `mock-${i}`));
      }
      return variants;
    }
  );

  jest.spyOn(GEPAEvolver.prototype, "applyMutation").mockImplementation(
    async (skillContent: string) => {
      return skillContent + "\n<!-- Mutated -->";
    }
  );

  return { tmpPath, config, datasetManager, judge, evolver };
};

const cleanupTestEnvironment = async (tmpPath: string, datasetManager: DatasetManager) => {
  datasetManager?.close();
  if (existsSync(tmpPath)) {
    rmSync(tmpPath, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Evolution Flow Integration", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("should run full evolution flow and return valid EvolutionResult", async () => {
    const { tmpPath, datasetManager, judge, evolver } = await setupTestEnvironment();

    try {
      const skillName = "test-skill";
      const testCases = makeSyntheticTestCases();

      const result: EvolutionResult = await evolver.evolveSkill(
        skillName,
        TEST_SKILL_CONTENT,
        testCases,
        {
          maxGenerations: 2,
          targetScore: 0.9,
          populationSize: 3,
          eliteSize: 1,
        }
      );

      // Assert: Returns an EvolutionResult with bestVariant.content set
      expect(result).toBeDefined();
      expect(result.bestVariant).toBeDefined();
      expect(result.bestVariant.content).toBeDefined();
      expect(typeof result.bestVariant.content).toBe("string");
      expect(result.bestVariant.content.length).toBeGreaterThan(0);

      // Assert: generationsCompleted is 1 or 2
      expect(result.generationsCompleted).toBeGreaterThanOrEqual(1);
      expect(result.generationsCompleted).toBeLessThanOrEqual(2);

      // Assert: stoppedEarly is false when hitting max generations
      expect(result.stoppedEarly).toBe(false);
      expect(result.stopReason).toBe("max_generations");

      // Assert: improvement is a number
      expect(typeof result.improvement).toBe("number");
      expect(Number.isFinite(result.improvement)).toBe(true);

      // Assert: totalVariantsEvaluated > 0
      expect(result.totalVariantsEvaluated).toBeGreaterThan(0);

      // Assert: status is completed
      expect(result.status).toBe("completed");

      // Assert: bestScore and baselineScore are present
      expect(result.bestScore).toBeDefined();
      expect(result.baselineScore).toBeDefined();
      expect(result.bestScore.overall).toBeGreaterThan(0);
      expect(result.baselineScore.overall).toBeGreaterThan(0);

      // Assert: completedAt is set
      expect(result.completedAt).toBeInstanceOf(Date);

      // Assert: generationHistory is populated
      expect(result.generationHistory).toBeDefined();
      expect(Array.isArray(result.generationHistory)).toBe(true);
      expect(result.generationHistory.length).toBeGreaterThan(0);
    } finally {
      await cleanupTestEnvironment(tmpPath, datasetManager);
    }
  }, 30000);

  it("should stop early when target score is reached", async () => {
    const { tmpPath, datasetManager, judge, evolver } = await setupTestEnvironment();

    try {
      // Override mock to return high score that exceeds target
      jest.spyOn(judge, "scoreVariant").mockResolvedValue({
        ...MOCK_FITNESS_SCORE,
        overall: 95, // Above 0.9 * 100 = 90 target
      });

      const skillName = "test-skill";
      const testCases = makeSyntheticTestCases();

      const result: EvolutionResult = await evolver.evolveSkill(
        skillName,
        TEST_SKILL_CONTENT,
        testCases,
        {
          maxGenerations: 5,
          targetScore: 0.9, // 90 on 0-100 scale
          populationSize: 3,
          eliteSize: 1,
        }
      );

      // Should stop early due to target reached
      expect(result.stoppedEarly).toBe(true);
      expect(result.stopReason).toBe("target_reached");
      expect(result.bestScore.overall).toBeGreaterThanOrEqual(90);
    } finally {
      await cleanupTestEnvironment(tmpPath, datasetManager);
    }
  }, 30000);

  it("should use mocked judge for all scoring calls", async () => {
    const { tmpPath, datasetManager, judge, evolver } = await setupTestEnvironment();

    try {
      const scoreBaselineMock = jest.spyOn(judge, "scoreBaseline").mockResolvedValue(MOCK_BASELINE_SCORE);
      const scoreVariantMock = jest.spyOn(judge, "scoreVariant").mockResolvedValue(MOCK_FITNESS_SCORE);

      const skillName = "test-skill";
      const testCases = makeSyntheticTestCases();

      await evolver.evolveSkill(
        skillName,
        TEST_SKILL_CONTENT,
        testCases,
        {
          maxGenerations: 2,
          targetScore: 0.9,
          populationSize: 3,
          eliteSize: 1,
        }
      );

      // Baseline should be scored once
      expect(scoreBaselineMock).toHaveBeenCalledTimes(1);
      expect(scoreBaselineMock).toHaveBeenCalledWith(skillName, TEST_SKILL_CONTENT, testCases);

      // Variants should be scored multiple times (at least once per generation)
      expect(scoreVariantMock).toHaveBeenCalled();
    } finally {
      await cleanupTestEnvironment(tmpPath, datasetManager);
    }
  }, 30000);

  it("should populate generation history with correct structure", async () => {
    const { tmpPath, datasetManager, evolver } = await setupTestEnvironment();

    try {
      const skillName = "test-skill";
      const testCases = makeSyntheticTestCases();

      const result: EvolutionResult = await evolver.evolveSkill(
        skillName,
        TEST_SKILL_CONTENT,
        testCases,
        {
          maxGenerations: 2,
          targetScore: 0.9,
          populationSize: 3,
          eliteSize: 1,
        }
      );

      // Each generation summary should have required fields
      for (const gen of result.generationHistory) {
        expect(gen.generation).toBeGreaterThanOrEqual(1);
        expect(gen.variantCount).toBeGreaterThan(0);
        expect(typeof gen.bestOverallScore).toBe("number");
        expect(typeof gen.averageOverallScore).toBe("number");
        expect(gen.bestVariantId).toBeDefined();
        expect(typeof gen.bestVariantId).toBe("string");
      }
    } finally {
      await cleanupTestEnvironment(tmpPath, datasetManager);
    }
  }, 30000);
});
