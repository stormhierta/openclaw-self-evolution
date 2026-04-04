/**
 * OpenClaw Self-Evolution Pipeline - Evaluation Rubrics
 * 
 * Defines evaluation rubric definitions for scoring skill variants.
 * 
 * Types referenced:
 * - EvolutionConfig from src/types.ts (lines 25-35)
 * - FitnessComponents from src/types.ts (lines 157-163)
 * 
 * Rubric design:
 * - Criteria weights sum to 1.0 for normalized scoring
 * - Each criterion has scoring guidelines for LLM reference
 */

import type { EvolutionConfig } from "../../types.js";

// ============================================================================
// Rubric Types
// ============================================================================

/**
 * A single evaluation criterion within a rubric.
 * Weights should sum to 1.0 across all criteria in a rubric.
 * 
 * Referenced by: RubricDefinition.criteria
 */
export interface EvaluationCriterion {
  /** Unique name identifying this criterion */
  name: string;
  /** Human-readable description of what this criterion evaluates */
  description: string;
  /** Weight of this criterion (0.0 to 1.0), all weights in rubric sum to 1.0 */
  weight: number;
  /** Guidelines for the LLM judge to determine scores (0 to maxScore) */
  scoringGuidelines: string;
}

/**
 * A complete evaluation rubric definition.
 * Contains criteria with weights that sum to 1.0.
 * 
 * Referenced by: RubricRegistry.getDefaultRubric(), getRubricForSkill()
 */
export interface RubricDefinition {
  /** Unique identifier for this rubric */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of what this rubric evaluates */
  description: string;
  /** List of weighted criteria (weights must sum to 1.0) */
  criteria: EvaluationCriterion[];
  /** Maximum possible score for this rubric (typically 100 or 1.0) */
  maxScore: number;
}

/**
 * Registry for managing evaluation rubrics.
 * Provides access to default and skill-specific rubrics.
 */
export class RubricRegistry {
  private config: EvolutionConfig;
  private rubrics: Map<string, RubricDefinition> = new Map();

  /**
   * Create a new RubricRegistry.
   * 
   * @param config - EvolutionConfig from src/types.ts
   */
  constructor(config: EvolutionConfig) {
    this.config = config;
    // Register the default rubric on construction
    this.registerRubric(this.buildDefaultRubric());
  }

  /**
   * Build the default general-purpose rubric for skill evaluation.
   * 
   * Criteria (weights sum to 1.0):
   * - accuracy: 0.25 - Does the skill produce correct outputs?
   * - relevance: 0.20 - Does the output address the user's intent?
   * - completeness: 0.20 - Does the skill fully address the request?
   * - tool_selection: 0.20 - Does the skill use appropriate tools?
   * - output_quality: 0.15 - Is the output well-structured and clear?
   */
  private buildDefaultRubric(): RubricDefinition {
    return {
      id: "default-skill-eval",
      name: "Default Skill Evaluation Rubric",
      description:
        "General-purpose rubric for evaluating any skill's response quality across five dimensions.",
      maxScore: 100,
      criteria: [
        {
          name: "accuracy",
          description:
            "Measures correctness and factuality of the skill's output. " +
            "High accuracy means the output is factually correct, logically sound, and free from errors.",
          weight: 0.25,
          scoringGuidelines:
            "Score 90-100: Output is entirely correct with no factual or logical errors. " +
            "Score 70-89: Minor errors that don't significantly impact the result. " +
            "Score 50-69: Moderate errors affecting some aspects of correctness. " +
            "Score 25-49: Significant errors or frequent mistakes. " +
            "Score 0-24: Mostly or entirely incorrect.",
        },
        {
          name: "relevance",
          description:
            "Measures how well the output addresses the user's actual intent and request. " +
            "High relevance means the skill understood what was being asked.",
          weight: 0.20,
          scoringGuidelines:
            "Score 90-100: Perfectly relevant, directly addresses the user's core intent. " +
            "Score 70-89: Mostly relevant with minor tangential elements. " +
            "Score 50-69: Partially relevant, misses some key aspects. " +
            "Score 25-49: Low relevance, addresses something different from what was asked. " +
            "Score 0-24: Completely irrelevant to the user query.",
        },
        {
          name: "completeness",
          description:
            "Measures whether the skill fully addressed all parts of the request. " +
            "High completeness means no important aspects were omitted.",
          weight: 0.20,
          scoringGuidelines:
            "Score 90-100: All parts of the request are thoroughly addressed. " +
            "Score 70-89: Most parts addressed, minor omissions. " +
            "Score 50-69: Several parts missing or incomplete. " +
            "Score 25-49: Significant portions of the request not addressed. " +
            "Score 0-24: Barely addresses the request at all.",
        },
        {
          name: "tool_selection",
          description:
            "Measures appropriateness of tool/function selection and usage. " +
            "High scores indicate the skill chose the right tools and used them correctly.",
          weight: 0.20,
          scoringGuidelines:
            "Score 90-100: Optimal tool selection with perfect usage. " +
            "Score 70-89: Good tool selection with minor usage issues. " +
            "Score 50-69: Reasonable tools chosen but with notable misuse. " +
            "Score 25-49: Poor tool selection or significant misuse. " +
            "Score 0-24: Completely wrong or no tools used when needed.",
        },
        {
          name: "output_quality",
          description:
            "Measures overall presentation, structure, and clarity of the output. " +
            "High quality means well-organized, clear, and easy to understand.",
          weight: 0.15,
          scoringGuidelines:
            "Score 90-100: Excellent structure, clear, professional. " +
            "Score 70-89: Good quality with minor presentation issues. " +
            "Score 50-69: Adequate but poorly organized or unclear in places. " +
            "Score 25-49: Low quality, confusing or badly structured. " +
            "Score 0-24: Incomprehensible output.",
        },
      ],
    };
  }

  /**
   * Get the default general-purpose rubric for skill evaluation.
   * 
   * @returns The default RubricDefinition
   */
  getDefaultRubric(): RubricDefinition {
    const rubric = this.rubrics.get("default-skill-eval");
    if (!rubric) {
      // Fallback: rebuild and return if not found (shouldn't happen)
      const defaultRubric = this.buildDefaultRubric();
      this.rubrics.set(defaultRubric.id, defaultRubric);
      return defaultRubric;
    }
    return rubric;
  }

  /**
   * Get the rubric for a specific skill, or the default rubric if none exists.
   * 
   * @param skillName - Name of the skill to get a rubric for
   * @returns The RubricDefinition for the skill or the default rubric
   */
  getRubricForSkill(skillName: string): RubricDefinition {
    const skillRubric = this.rubrics.get(skillName);
    if (skillRubric) {
      return skillRubric;
    }
    // Return default if no skill-specific rubric registered
    return this.getDefaultRubric();
  }

  /**
   * Register a custom rubric in the registry.
   * If a rubric with the same id already exists, it will be overwritten.
   * 
   * @param rubric - The RubricDefinition to register
   */
  registerRubric(rubric: RubricDefinition): void {
    // Validate that weights sum to 1.0 (with small tolerance for floating point)
    const totalWeight = rubric.criteria.reduce((sum, c) => sum + c.weight, 0);
    if (Math.abs(totalWeight - 1.0) > 0.001) {
      throw new Error(
        `Rubric "${rubric.id}" criteria weights must sum to 1.0, got ${totalWeight}`
      );
    }

    // Validate that all criteria have valid weights
    for (const criterion of rubric.criteria) {
      if (criterion.weight <= 0 || criterion.weight > 1) {
        throw new Error(
          `Criterion "${criterion.name}" in rubric "${rubric.id}" has invalid weight: ${criterion.weight}`
        );
      }
    }

    this.rubrics.set(rubric.id, rubric);
  }

  /**
   * List all registered rubrics.
   * 
   * @returns Array of all RubricDefinitions in the registry
   */
  listRubrics(): RubricDefinition[] {
    return Array.from(this.rubrics.values());
  }
}
