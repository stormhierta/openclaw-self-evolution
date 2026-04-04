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
 * Maps directly to rubric criterion names.
 */
interface LlmRawScores {
  accuracy: number;
  relevance: number;
  completeness: number;
  tool_selection: number;
  output_quality: number;
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

    // Aggregate scores across all test cases
    const allScores: LlmRawScores[] = [];

    for (const testCase of testCases) {
      const rawScores = await this.evaluateTestCase(variant, testCase, rubric);
      allScores.push(rawScores);
    }

    // Average scores across test cases
    const averagedScores = this.averageScores(allScores);

    // Convert rubric scores to FitnessComponents
    const components = this.toFitnessComponents(averagedScores);

    // Compute weighted overall score using rubric weights
    const overall = this.computeWeightedOverall(averagedScores, rubric);

    return {
      overall,
      components,
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
   */
  private async evaluateTestCase(
    variant: SkillVariant,
    testCase: DatasetEntry,
    rubric: import("./rubrics.js").RubricDefinition
  ): Promise<LlmRawScores> {
    const prompt = this.buildEvaluationPrompt(variant, testCase, rubric);

    const response = await this.callMiniMax(prompt);
    const scores = this.parseScoreResponse(response);

    return scores;
  }

  /**
   * Build the evaluation prompt for the LLM judge.
   */
  private buildEvaluationPrompt(
    variant: SkillVariant,
    testCase: DatasetEntry,
    rubric: import("./rubrics.js").RubricDefinition
  ): string {
    const criteriaDescriptions = rubric.criteria
      .map(
        (c) =>
          `- ${c.name} (weight: ${(c.weight * 100).toFixed(0)}%): ${c.description}`
      )
      .join("\n");

    return `You are an expert evaluator judging whether a skill's instructions are likely to produce the correct output for a given test case.

## SKILL TO EVALUATE
Skill Name: ${variant.skillName}
Generation: ${variant.generation}
Content:
${variant.content}

## TEST CASE
Input: ${testCase.input}
Expected Output: ${testCase.expectedOutput}
${testCase.context ? `Context: ${JSON.stringify(testCase.context)}` : ""}

## EVALUATION RUBRIC
Score each criterion from 0 to ${rubric.maxScore} based on whether the skill's instructions would guide an agent to produce correct, high-quality output for this test case:

${criteriaDescriptions}

## YOUR TASK
Evaluate whether this skill's instructions are likely to lead an agent to produce the expected output for this test case. Provide ONLY a JSON object with scores for each criterion. No explanation or text outside the JSON.

Return this exact JSON structure (replace VALUE_HERE with your numeric scores):
{
  "accuracy": VALUE_HERE,
  "relevance": VALUE_HERE,
  "completeness": VALUE_HERE,
  "tool_selection": VALUE_HERE,
  "output_quality": VALUE_HERE
}

Score honestly based on whether the skill instructions would enable correct behavior, not on the skill content alone.`;
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
   */
  private parseScoreResponse(response: string): LlmRawScores {
    // Extract JSON from response (handle markdown code blocks)
    const jsonMatch =
      response.match(/```(?:json)?\s*([\s\S]*?)```/) ||
      response.match(/(\{[\s\S]*\})/);
    const jsonStr = jsonMatch ? jsonMatch[1] : response;

    const parsed = JSON.parse(jsonStr.trim()) as Partial<LlmRawScores>;

    // Validate and normalize scores to 0-100 range
    return {
      accuracy: this.clampScore(parsed.accuracy ?? 0),
      relevance: this.clampScore(parsed.relevance ?? 0),
      completeness: this.clampScore(parsed.completeness ?? 0),
      tool_selection: this.clampScore(parsed.tool_selection ?? 0),
      output_quality: this.clampScore(parsed.output_quality ?? 0),
    };
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
        accuracy: 0,
        relevance: 0,
        completeness: 0,
        tool_selection: 0,
        output_quality: 0,
      };
    }

    const sum = allScores.reduce(
      (acc, s) => ({
        accuracy: acc.accuracy + s.accuracy,
        relevance: acc.relevance + s.relevance,
        completeness: acc.completeness + s.completeness,
        tool_selection: acc.tool_selection + s.tool_selection,
        output_quality: acc.output_quality + s.output_quality,
      }),
      { accuracy: 0, relevance: 0, completeness: 0, tool_selection: 0, output_quality: 0 }
    );

    const count = allScores.length;
    return {
      accuracy: sum.accuracy / count,
      relevance: sum.relevance / count,
      completeness: sum.completeness / count,
      tool_selection: sum.tool_selection / count,
      output_quality: sum.output_quality / count,
    };
  }

  /**
   * Map rubric raw scores to FitnessComponents.
   * 
   * FitnessComponents (src/types.ts lines 150-157):
   * - correctness: maps from accuracy
   * - formatAdherence: maps from output_quality
   * - efficiency: maps from completeness
   * - robustness: maps from relevance
   * - clarity: maps from tool_selection
   * 
   * Note: This mapping is approximate since rubric criteria and
   * FitnessComponents have different semantic scopes. The rubric criteria
   * are more directly relevant to the LLM judge's evaluation.
   */
  private toFitnessComponents(scores: LlmRawScores): FitnessComponents {
    return {
      correctness: scores.accuracy,
      formatAdherence: scores.output_quality,
      efficiency: scores.completeness,
      robustness: scores.relevance,
      clarity: scores.tool_selection,
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

    // Compute weighted sum
    const overall =
      (scores.accuracy * (weightMap.get("accuracy") ?? 0)) +
      (scores.relevance * (weightMap.get("relevance") ?? 0)) +
      (scores.completeness * (weightMap.get("completeness") ?? 0)) +
      (scores.tool_selection * (weightMap.get("tool_selection") ?? 0)) +
      (scores.output_quality * (weightMap.get("output_quality") ?? 0));

    return Math.round(overall * 100) / 100;
  }
}
