/**
 * OpenClaw Self-Evolution Pipeline - Benchmark Gate
 *
 * Final quality gate that evaluates a skill variant against configurable
 * thresholds before it can be applied to the real skill file.
 */

import type { EvolutionConfig, SkillVariant } from "../types.js";
import type { ValidationResult } from "./skill-validator.js";
import type { TestRunResult } from "./test-runner.js";

// ============================================================================
// Configuration Types
// ============================================================================

export interface BenchmarkGateConfig {
  /** Minimum test pass rate (default: 0.7) */
  minPassRate?: number;
  /** Minimum fitness score from variant.fitnessScore?.overall. Scale 0-100 (matches LlmJudge output). Default: 60 */
  minFitnessScore?: number;
  /** If true, ValidationResult.valid must be true (default: true) */
  requireValidation?: boolean;
  /** If true, variant must have a fitness score (default: true) */
  requireFitnessScore?: boolean;
}

// ============================================================================
// Result Types
// ============================================================================

export interface GateResult {
  /** True only if ALL enabled checks pass */
  passed: boolean;
  /** List of reasons for failure (empty if passed) */
  reasons: string[];
  /** The actual scores observed */
  scores: {
    passRate: number;
    /** 0-100 scale, or null if variant has not been scored */
    fitnessScore: number | null;
    validationPassed: boolean;
  };
}

// ============================================================================
// Benchmark Gate Class
// ============================================================================

/**
 * Final quality gate in the evolution pipeline.
 *
 * Evaluates a skill variant against configurable thresholds:
 * - minPassRate: minimum test pass rate (default 0.7)
 * - minFitnessScore: minimum fitness score from variant.fitnessScore?.overall, 0-100 scale (default 60)
 * - requireValidation: if true, ValidationResult.valid must be true (default true)
 *
 * A variant can only be applied if ALL enabled checks pass.
 */
export class BenchmarkGate {
  private readonly minPassRate: number;
  private readonly minFitnessScore: number;
  private readonly requireValidation: boolean;
  private readonly requireFitnessScore: boolean;

  constructor(config: EvolutionConfig, gateConfig?: BenchmarkGateConfig) {
    this.minPassRate = gateConfig?.minPassRate ?? 0.7;
    this.minFitnessScore = gateConfig?.minFitnessScore ?? 60;
    this.requireValidation = gateConfig?.requireValidation ?? true;
    this.requireFitnessScore = gateConfig?.requireFitnessScore ?? true;
  }

  /**
   * Evaluate a skill variant against the configured thresholds.
   *
   * @param variant - The SkillVariant to evaluate
   * @param validationResult - Result from SkillValidator
   * @param testRunResult - Result from TestRunner
   * @returns GateResult with pass/fail decision and scores
   */
  evaluate(
    variant: SkillVariant,
    validationResult: ValidationResult,
    testRunResult: TestRunResult
  ): GateResult {
    const reasons: string[] = [];

    // Extract actual scores
    const passRate = testRunResult.passRate;
    const fitnessScore = variant.fitnessScore?.overall ?? null;
    const validationPassed = validationResult.valid;

    // Check validation (if required)
    if (this.requireValidation && !validationPassed) {
      reasons.push(
        `Validation failed: ${validationResult.errors.length > 0 ? validationResult.errors.join("; ") : "unknown validation error"}`
      );
    }

    // Check pass rate
    if (testRunResult.totalTests === 0 || !(passRate >= this.minPassRate)) {
      reasons.push(
        `Pass rate ${Number.isNaN(passRate) ? "N/A (no tests run)" : passRate.toFixed(2)} is below minimum ${this.minPassRate.toFixed(2)}`
      );
    }

    // Check fitness score
    if (fitnessScore === null) {
      if (this.requireFitnessScore) {
        reasons.push("Fitness score is missing (variant has not been scored)");
      }
    } else if (fitnessScore < this.minFitnessScore) {
      reasons.push(
        `Fitness score ${fitnessScore.toFixed(2)} is below minimum ${this.minFitnessScore.toFixed(2)}`
      );
    }

    const passed = reasons.length === 0;

    return {
      passed,
      reasons,
      scores: {
        passRate,
        fitnessScore,
        validationPassed,
      },
    };
  }

  /**
   * Convenience method to check if a variant can be applied.
   * Returns true if the variant passes all gates.
   *
   * @param variant - The SkillVariant to check
   * @param validationResult - Result from SkillValidator
   * @param testRunResult - Result from TestRunner
   * @returns true if the variant passes all gates
   */
  canApply(
    variant: SkillVariant,
    validationResult: ValidationResult,
    testRunResult: TestRunResult
  ): boolean {
    return this.evaluate(variant, validationResult, testRunResult).passed;
  }
}
