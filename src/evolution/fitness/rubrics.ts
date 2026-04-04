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
   * - correctness: 0.50 - Would an agent following these instructions produce correct output?
   * - procedure_following: 0.30 - Does the skill guide the agent through the right procedure?
   * - conciseness: 0.20 - Would the skill lead to appropriately concise responses?
   */
  private buildDefaultRubric(): RubricDefinition {
    return {
      id: "default-skill-eval",
      name: "Default Skill Evaluation Rubric",
      description:
        "Outcome-focused rubric for evaluating whether skill instructions lead to correct, well-structured task completion.",
      maxScore: 100,
      criteria: [
        {
          name: "correctness",
          description:
            "Would an agent following these instructions produce correct, accurate output for the task?",
          weight: 0.50,
          scoringGuidelines:
            "Score 90-100: Instructions would guide the agent to entirely correct output with no factual or logical errors. " +
            "Score 70-89: Instructions are mostly correct with minor issues that don't significantly impact results. " +
            "Score 50-69: Instructions have moderate errors affecting some aspects of correctness. " +
            "Score 25-49: Instructions contain significant errors or would lead to frequent mistakes. " +
            "Score 0-24: Instructions are mostly or entirely incorrect.",
        },
        {
          name: "procedure_following",
          description:
            "Does the skill guide the agent through the right procedure or steps to complete the task?",
          weight: 0.30,
          scoringGuidelines:
            "Score 90-100: Instructions guide the agent through an optimal, well-structured procedure. " +
            "Score 70-89: Procedure is mostly correct with minor inefficiencies or ordering issues. " +
            "Score 50-69: Procedure has notable gaps or suboptimal ordering but would still work. " +
            "Score 25-49: Procedure is significantly flawed or missing critical steps. " +
            "Score 0-24: No clear procedure or completely wrong approach.",
        },
        {
          name: "conciseness",
          description:
            "Would the skill lead to appropriately concise responses (not verbose, not missing critical info)?",
          weight: 0.20,
          scoringGuidelines:
            "Score 90-100: Instructions would produce appropriately concise, focused responses with all critical info. " +
            "Score 70-89: Minor verbosity or slight omissions, but generally well-balanced. " +
            "Score 50-69: Noticeably verbose or occasionally missing important details. " +
            "Score 25-49: Very verbose or frequently missing critical information. " +
            "Score 0-24: Either extremely verbose rambling or severely incomplete responses.",
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
