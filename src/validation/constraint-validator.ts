/**
 * Constraint Validator
 * 
 * Combines existing validators (SkillValidator, SizeLimits) and adds mid-loop
 * constraint checks for the evolution loop. Rejects invalid variants early
 * to save LLM judge calls.
 * 
 * Reference: Hermes constraints.py - validates evolved artifacts against
 * hard constraints at multiple points in the evolution loop.
 */

import type { SkillVariant, EvolutionConfig } from "../types.js";
import type { SkillValidator } from "./skill-validator.js";
import type { SizeLimits } from "./size-limits.js";

// ============================================================================
// Constraint Check Types
// ============================================================================

/** Result of a single constraint check */
export interface ConstraintCheck {
  name: string;
  passed: boolean;
  message: string;
}

/** Result of constraint validation with all checks */
export interface ConstraintResult {
  valid: boolean;
  checks: ConstraintCheck[];
}

// ============================================================================
// ConstraintValidator Class
// ============================================================================

/**
 * Validates skill variants against hard constraints during evolution.
 * 
 * Runs:
 * - SkillValidator.validate() — checks frontmatter, sections, unsafe patterns
 * - SizeLimits.checkAll() — checks size limits
 * - Growth check — if baselineContent provided, reject if content grew >50%
 */
export class ConstraintValidator {
  constructor(
    private skillValidator: SkillValidator,
    private sizeLimits: SizeLimits,
    private config: EvolutionConfig,
  ) {}

  /**
   * Validate a variant against all constraints.
   * 
   * @param variant - The skill variant to validate
   * @param baselineContent - Optional baseline content for growth check
   * @returns ConstraintResult with all checks and overall validity
   */
  validateVariant(
    variant: SkillVariant,
    baselineContent?: string,
  ): ConstraintResult {
    const checks: ConstraintCheck[] = [];

    // 1. Skill structure validation (frontmatter, sections, unsafe patterns)
    const skillResult = this.skillValidator.validate(variant);
    checks.push({
      name: "skill_structure",
      passed: skillResult.valid,
      message: skillResult.valid
        ? "Skill structure valid"
        : `Skill structure errors: ${skillResult.errors.join("; ")}`,
    });

    // 2. Size limits check
    const sizeResult = this.sizeLimits.checkAll(variant.content);
    checks.push({
      name: "size_limits",
      passed: sizeResult.valid,
      message: sizeResult.valid
        ? "Size within limits"
        : `Size limit errors: ${sizeResult.errors.join("; ")}`,
    });

    // 3. Growth check (if baseline provided)
    if (baselineContent !== undefined) {
      const growthResult = this.sizeLimits.checkGrowth(variant.content, baselineContent);
      checks.push({
        name: "growth_limit",
        passed: growthResult.valid,
        message: growthResult.valid
          ? `Growth OK: ${(growthResult.growthRatio * 100).toFixed(1)}% (max ${(growthResult.maxGrowth * 100).toFixed(0)}%)`
          : growthResult.error ?? "Growth limit exceeded",
      });
    }

    // 4. Non-empty check
    const isNonEmpty = variant.content.trim().length > 0;
    checks.push({
      name: "non_empty",
      passed: isNonEmpty,
      message: isNonEmpty ? "Content is non-empty" : "Content is empty",
    });

    const allPassed = checks.every((c) => c.passed);

    return {
      valid: allPassed,
      checks,
    };
  }

  /**
   * Quick check if a variant passes minimum bar for scoring.
   * Use this to filter variants before expensive LLM judge calls.
   * 
   * @param variant - The skill variant to check
   * @returns true if the variant is scorable
   */
  isScorable(variant: SkillVariant): boolean {
    // Must have non-empty content
    if (!variant.content || variant.content.trim().length === 0) {
      return false;
    }

    // Must have valid frontmatter (starts with ---)
    if (!variant.content.trim().startsWith("---")) {
      return false;
    }

    // Must have name field in frontmatter
    const frontmatterMatch = variant.content.match(/^---\n([\s\S]*?)\n---/m);
    if (!frontmatterMatch || !frontmatterMatch[1].match(/^name:\s*["']?(.+?)["']?\s*$/m)) {
      return false;
    }

    return true;
  }
}
