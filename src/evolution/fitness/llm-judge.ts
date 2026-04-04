/**
 * OpenClaw Self-Evolution Pipeline - LLM Judge
 * 
 * Uses MiniMax LLM to score skill variants against evaluation rubrics.
 * 
 * Types referenced:
 * - SkillVariant from src/types.ts (lines 104-113)
 * - FitnessScore from src/types.ts (lines 140-148)
 * - FitnessComponents from src/types.ts (lines 150-157)
 * - DatasetEntry from src/types.ts (lines 245-255)
 * - EvolutionConfig from src/types.ts (lines 25-35)
 * 
 * MiniMax API pattern: same as src/dataset/synthetic-generator.ts
 * - Endpoint: https://api.minimax.io/v1/text/chatcompletion_v2
 * - Model: MiniMax-M2.7
 */

import type {
  SkillVariant,
  FitnessScore,
  FitnessComponents,
  DatasetEntry,
  EvolutionConfig,
} from "../../types.js";
import { RubricRegistry } from "./rubrics.js";

// ============================================================================
// MiniMax API Types
// ============================================================================

interface MiniMaxResponse {
  id?: string;
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  base_resp?: {
    status_code: number;
    status_msg: string;
  };
  error?: {
    message: string;
  };
}

// ============================================================================
// LLM Judge Score Result (intermediate parsed from LLM)
// ============================================================================

/**
 * Raw scores returned by the LLM judge for a single test case.
 * Maps directly to rubric criterion names (snake_case).
 */
interface LlmRawScores {
  correctness: number;
  procedure_following: number;
  conciseness: number;
}

// ============================================================================
// LLM Judge
// ============================================================================

/**
 * LLMJudge uses MiniMax to evaluate skill variants against rubrics.
 * 
 * Referenced by: RubricRegistry from src/evolution/fitness/rubrics.ts
 */
export class LlmJudge {
  private config: EvolutionConfig;
  private rubricRegistry: RubricRegistry;
  private apiKey: string;
  private apiBaseUrl: string;

  constructor(config: EvolutionConfig, rubricRegistry: RubricRegistry) {
    this.config = config;
    this.rubricRegistry = rubricRegistry;
    this.apiKey = process.env.MINIMAX_API_KEY ?? "";
    this.apiBaseUrl = "https://api.minimax.io";
  }

  /**
   * Score a skill variant against a set of test cases using the rubric.
   * 
   * @param variant - The SkillVariant to evaluate (from src/types.ts lines 104-113)
   * @param testCases - Array of DatasetEntry test cases (from src/types.ts lines 245-255)
   * @returns Promise resolving to a FitnessScore
   */
  async scoreVariant(
    variant: SkillVariant,
    testCases: DatasetEntry[]
  ): Promise<FitnessScore> {
    const rubric = this.rubricRegistry.getRubricForSkill(variant.skillName);

    // Aggregate scores and feedback across all test cases
    const allScores: LlmRawScores[] = [];
    const allFeedback: string[] = [];

    for (const testCase of testCases) {
      const result = await this.evaluateTestCase(variant, testCase, rubric);
      allScores.push(result.scores);
      if (result.feedback && result.feedback.trim().length > 0) {
        allFeedback.push(result.feedback);
      }
    }

    // Average scores across test cases
    const averagedScores = this.averageScores(allScores);

    // Convert rubric scores to FitnessComponents
    const components = this.toFitnessComponents(averagedScores);

    // Compute weighted overall score using rubric weights
    const overall = this.computeWeightedOverall(averagedScores, rubric);

    // Aggregate feedback: pick feedback from the lowest-scoring test case
    // (most specific area for improvement)
    const feedback = this.aggregateFeedback(allScores, allFeedback);

    return {
      overall,
      components,
      feedback,
      evaluatedAt: new Date(),
      method: "llm_judge",
      rawScores: averagedScores as unknown as Record<string, number>,
    };
  }

  /**
   * Score the baseline/original skill for comparison with variants.
   * 
   * @param skillName - Name of the skill to score the baseline for
   * @param skillContent - The actual current SKILL.md content
   * @param testCases - Array of DatasetEntry test cases
   * @returns Promise resolving to a FitnessScore for the baseline
   */
  async scoreBaseline(
    skillName: string,
    skillContent: string,
    testCases: DatasetEntry[]
  ): Promise<FitnessScore> {
    const baselineVariant: SkillVariant = {
      id: `baseline-${skillName}`,
      skillName,
      generation: 0,
      content: skillContent,
      mutations: [],
      parents: [],
      createdAt: new Date(),
    };

    return this.scoreVariant(baselineVariant, testCases);
  }

  /**
   * Compare two fitness scores and determine improvement.
   * 
   * @param variant - The variant FitnessScore
   * @param baseline - The baseline FitnessScore
   * @returns Object with improvement percentage and verdict string
   */
  compareFitness(
    variant: FitnessScore,
    baseline: FitnessScore
  ): { improvement: number; verdict: string } {
    const improvement = variant.overall - baseline.overall;

    // Determine verdict based on improvement magnitude
    let verdict: string;
    if (improvement >= 10) {
      verdict = "SIGNIFICANT_IMPROVEMENT: Variant substantially outperforms baseline";
    } else if (improvement >= 3) {
      verdict = "MODERATE_IMPROVEMENT: Variant shows measurable improvement over baseline";
    } else if (improvement >= -3) {
      verdict = "EQUIVALENT: Variant performs similarly to baseline";
    } else if (improvement >= -10) {
      verdict = "MODERATE_REGRESSION: Variant slightly underperforms baseline";
    } else {
      verdict = "SIGNIFICANT_REGRESSION: Variant substantially underperforms baseline";
    }

    return { improvement, verdict };
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Evaluate a single test case using the MiniMax API.
   * Returns scores and optional feedback.
   */
  private async evaluateTestCase(
    variant: SkillVariant,
    testCase: DatasetEntry,
    rubric: import("./rubrics.js").RubricDefinition
  ): Promise<{ scores: LlmRawScores; feedback?: string }> {
    const prompt = this.buildEvaluationPrompt(variant, testCase, rubric);

    const response = await this.callMiniMax(prompt);
    const result = this.parseScoreResponse(response);

    return result;
  }

  /**
   * Build the evaluation prompt for the LLM judge.
   * Uses a two-step simulation approach:
   * 1. Simulate: Imagine an agent following the skill instructions
   * 2. Evaluate: Score the simulated outcome on correctness, procedure_following, conciseness
   */
  private buildEvaluationPrompt(
    variant: SkillVariant,
    testCase: DatasetEntry,
    rubric: import("./rubrics.js").RubricDefinition
  ): string {
    const criteriaDescriptions = rubric.criteria
      .map(
        (c) =>
          `- ${c.name} (weight: ${(c.weight * 100).toFixed(0)}%): ${c.description}\n  Scoring: ${c.scoringGuidelines}`
      )
      .join("\n\n");

    return `You are evaluating whether a skill produces correct agent behavior.

## SKILL INSTRUCTIONS
${variant.content}

## TASK
Input: ${testCase.input}
${testCase.context ? `Context: ${JSON.stringify(testCase.context)}` : ""}

## EXPECTED BEHAVIOR
${testCase.expectedOutput}

## EVALUATION

Step 1 — Simulate: Briefly describe what an agent following these skill instructions would do for this task.

Step 2 — Score the likely outcome:
- correctness (0-100): Would the agent produce correct, accurate output?
- procedure_following (0-100): Would the agent follow the skill's intended procedure?
- conciseness (0-100): Would the response be appropriately concise?

Step 3 — Provide specific, actionable feedback: What in the skill could be improved to better handle this task?

## SCORING CRITERIA
${criteriaDescriptions}

Return ONLY this JSON (no other text):
{"reasoning": "brief simulation of what the agent would do", "correctness": N, "procedure_following": N, "conciseness": N, "feedback": "one sentence of specific improvement suggestion"}`;
  }

  /**
   * Call the MiniMax API.
   * Pattern matches: src/dataset/synthetic-generator.ts callMiniMax()
   */
  private async callMiniMax(prompt: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error("MINIMAX_API_KEY environment variable is not set");
    }

    const response = await fetch(
      `${this.apiBaseUrl}/v1/text/chatcompletion_v2`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: "MiniMax-M2.7",
          messages: [
            {
              role: "system",
              content:
                "You are an expert AI skill evaluator. Always return valid JSON with exact field names.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          temperature: 0.1, // Low temperature for consistent scoring
          max_tokens: 1000,
        }),
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `MiniMax API error: ${response.status} ${response.statusText} - ${errorText}`
      );
    }

    const data = (await response.json()) as MiniMaxResponse;

    // Check MiniMax base_resp status_code
    if (data.base_resp && data.base_resp.status_code !== 0) {
      throw new Error(
        `MiniMax API error: ${data.base_resp.status_msg} (code ${data.base_resp.status_code})`
      );
    }

    if (data.error) {
      throw new Error(`MiniMax API error: ${data.error.message}`);
    }

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("MiniMax API returned empty content");
    }

    return content;
  }

  /**
   * Parse the JSON score response from the LLM.
   * Extracts scores and optional feedback.
   */
  private parseScoreResponse(response: string): { scores: LlmRawScores; feedback?: string } {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch =
      response.match(/```(?:json)?\s*([\s\S]*?)```/) ||
      response.match(/(\{[\s\S]*\})/);
    const jsonStr = jsonMatch ? jsonMatch[1] : response;

    try {
      const parsed = JSON.parse(jsonStr.trim()) as Partial<LlmRawScores & { feedback?: string; reasoning?: string }>;

      // Validate and normalize scores to 0-100 range
      const scores: LlmRawScores = {
        correctness: this.clampScore(parsed.correctness ?? 0),
        procedure_following: this.clampScore(parsed.procedure_following ?? 0),
        conciseness: this.clampScore(parsed.conciseness ?? 0),
      };

      // Extract feedback if present
      const feedback = typeof parsed.feedback === 'string' && parsed.feedback.trim().length > 0
        ? parsed.feedback.trim()
        : undefined;

      return { scores, feedback };
    } catch {
      // Return safe fallback scores
      return {
        scores: { correctness: 50, procedure_following: 50, conciseness: 50 },
        feedback: "Failed to parse evaluation response",
      };
    }
  }

  /**
   * Clamp a score to the valid 0-100 range.
   */
  private clampScore(value: number): number {
    if (value < 0) return 0;
    if (value > 100) return 100;
    return value;
  }

  /**
   * Average scores across multiple test case evaluations.
   */
  private averageScores(allScores: LlmRawScores[]): LlmRawScores {
    if (allScores.length === 0) {
      return {
        correctness: 0,
        procedure_following: 0,
        conciseness: 0,
      };
    }

    const sum = allScores.reduce(
      (acc, s) => ({
        correctness: acc.correctness + s.correctness,
        procedure_following: acc.procedure_following + s.procedure_following,
        conciseness: acc.conciseness + s.conciseness,
      }),
      { correctness: 0, procedure_following: 0, conciseness: 0 }
    );

    const count = allScores.length;
    return {
      correctness: sum.correctness / count,
      procedure_following: sum.procedure_following / count,
      conciseness: sum.conciseness / count,
    };
  }

  /**
   * Aggregate feedback from multiple test case evaluations.
   * Returns feedback from the lowest-scoring test case (most specific area for improvement),
   * or concatenates up to 3 feedbacks if no single low-scoring case stands out.
   */
  private aggregateFeedback(allScores: LlmRawScores[], allFeedback: string[]): string | undefined {
    if (allFeedback.length === 0) {
      return undefined;
    }

    if (allFeedback.length === 1) {
      return allFeedback[0];
    }

    // Find the test case with the lowest average score (most problematic)
    let minIndex = 0;
    let minAvgScore = Infinity;

    for (let i = 0; i < allScores.length; i++) {
      const avg = (allScores[i].correctness + allScores[i].procedure_following + allScores[i].conciseness) / 3;
      if (avg < minAvgScore) {
        minAvgScore = avg;
        minIndex = i;
      }
    }

    // If we have feedback for the lowest-scoring case, use it
    if (minIndex < allFeedback.length) {
      return allFeedback[minIndex];
    }

    // Fallback: concatenate first 3 feedbacks
    return allFeedback.slice(0, 3).join(" ");
  }

  /**
   * Map rubric raw scores to FitnessComponents.
   * 
   * Maps snake_case rubric criterion names to camelCase FitnessComponents:
   * - correctness -> correctness
   * - procedure_following -> procedureFollowing
   * - conciseness -> conciseness
   */
  private toFitnessComponents(scores: LlmRawScores): FitnessComponents {
    return {
      correctness: scores.correctness,
      procedureFollowing: scores.procedure_following,
      conciseness: scores.conciseness,
    };
  }

  /**
   * Compute the weighted overall score using rubric criterion weights.
   */
  private computeWeightedOverall(
    scores: LlmRawScores,
    rubric: import("./rubrics.js").RubricDefinition
  ): number {
    // Build a map of criterion name to weight for fast lookup
    const weightMap = new Map<string, number>();
    for (const criterion of rubric.criteria) {
      weightMap.set(criterion.name, criterion.weight);
    }

    // Compute weighted sum (weights sum to 1.0)
    const overall =
      (scores.correctness * (weightMap.get("correctness") ?? 0.50)) +
      (scores.procedure_following * (weightMap.get("procedure_following") ?? 0.30)) +
      (scores.conciseness * (weightMap.get("conciseness") ?? 0.20));

    return Math.round(overall * 100) / 100;
  }
}
