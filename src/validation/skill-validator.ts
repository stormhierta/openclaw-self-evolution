/**
 * Skill Validator
 * 
 * Validates that a skill variant's SKILL.md content conforms to the
 * AgentSkills format understood by OpenClaw.
 */

import type { EvolutionConfig, SkillVariant } from "../types.js";
import { SizeLimits } from "./size-limits.js";

// ============================================================================
// Validation Result Type
// ============================================================================

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  sizeBytes: number;
}

// ============================================================================
// Unsafe Patterns
// ============================================================================

const UNSAFE_PATTERNS: Array<{ pattern: RegExp; message: string }> = [
  {
    pattern: /eval\s*\(/i,
    message: "Usage of 'eval(' is not allowed in skill content",
  },
  {
    pattern: /child_process/i,
    message: "Usage of 'child_process' is not allowed in skill content",
  },
  {
    pattern: /\brm\s+-rf\b/i,
    message: "Usage of 'rm -rf' is not allowed in skill content",
  },
  {
    pattern: /\bsudo\b/i,
    message: "Usage of 'sudo' is not allowed in skill content",
  },
  {
    pattern: /curl\s*\|\s*sh/i,
    message: "Pipe to shell ('curl | sh') is not allowed in skill content",
  },
  {
    pattern: /wget\s*\|\s*sh/i,
    message: "Pipe to shell ('wget | sh') is not allowed in skill content",
  },
];

// ============================================================================
// SkillValidator Class
// ============================================================================

/**
 * Validates skill SKILL.md content against AgentSkills format requirements.
 */
export class SkillValidator {
  private readonly sizeLimits: SizeLimits;

  constructor(config: EvolutionConfig, sizeLimits: SizeLimits) {
    this.sizeLimits = sizeLimits;
  }

  /**
   * Validate a complete skill variant.
   */
  validate(variant: SkillVariant): ValidationResult {
    return this.validateContent(variant.content, variant.skillName);
  }

  /**
   * Validate raw SKILL.md content.
   */
  validateContent(content: string, skillName: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Measure byte size
    const sizeBytes = new TextEncoder().encode(content).length;

    // 1. Check frontmatter
    const frontmatterResult = this.checkFrontmatter(content);
    if (!frontmatterResult.valid) {
      errors.push(...frontmatterResult.errors);
    }

    // 2. Check required sections
    const sectionsResult = this.checkRequiredSections(content);
    if (!sectionsResult.valid) {
      errors.push(...sectionsResult.errors);
    }

    // 3. Check unsafe patterns
    const unsafeResult = this.checkNoUnsafePatterns(content);
    if (!unsafeResult.valid) {
      errors.push(...unsafeResult.errors);
    }

    // 4. Check size limits
    const sizeAllResult = this.sizeLimits.checkAll(content);
    if (!sizeAllResult.valid) {
      errors.push(...sizeAllResult.errors);
    }

    // Warn if no content
    if (content.trim().length === 0) {
      warnings.push("Skill content is empty");
    }

    // Warn if name in frontmatter doesn't match expected skill name
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/m);
    if (frontmatterMatch) {
      const nameMatch = frontmatterMatch[1].match(/^name:\s*["']?(.+?)["']?\s*$/m);
      if (nameMatch && nameMatch[1] !== skillName) {
        warnings.push(
          `Frontmatter name '${nameMatch[1]}' does not match variant skillName '${skillName}'`,
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      sizeBytes,
    };
  }

  /**
   * Check that YAML frontmatter exists and contains required fields.
   * 
   * Expected format (matches real OpenClaw SKILL.md):
   * ---
   * name: <skill-name>
   * description: "<description text>"
   * ...
   * ---
   */
  checkFrontmatter(
    content: string,
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Must start with ---
    if (!content.trim().startsWith("---")) {
      errors.push("Missing YAML frontmatter: content must start with '---'");
      return { valid: false, errors };
    }

    // Find the closing ---
    const endMatch = content.match(/^---\n([\s\S]*?)\n---/m);
    if (!endMatch) {
      errors.push("Missing closing '---' for YAML frontmatter");
      return { valid: false, errors };
    }

    const frontmatterBody = endMatch[1];

    // Check for required 'name' field
    const nameMatch = frontmatterBody.match(/^name:\s*["']?(.+?)["']?\s*$/m);
    if (!nameMatch) {
      errors.push("Frontmatter missing required 'name' field");
    }

    // Check for required 'description' field
    const descMatch = frontmatterBody.match(/^description:\s*["'](.*?)["']\s*$/m);
    if (!descMatch) {
      errors.push("Frontmatter missing required 'description' field");
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Check that content contains at least one markdown section header (##).
   */
  checkRequiredSections(
    content: string,
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    const sectionRegex = /^##\s+.+$/gm;
    const matches = content.match(sectionRegex);

    if (!matches || matches.length === 0) {
      errors.push("Skill content must contain at least one '## ' section header");
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Check that content does not contain unsafe patterns.
   */
  checkNoUnsafePatterns(
    content: string,
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    for (const { pattern, message } of UNSAFE_PATTERNS) {
      if (pattern.test(content)) {
        errors.push(message);
      }
    }

    return { valid: errors.length === 0, errors };
  }
}
