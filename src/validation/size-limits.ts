/**
 * Size and Length Limits for Skill Validation
 * 
 * Enforces configurable limits on skill content size, description length,
 * and structural elements to keep evolved skills manageable.
 */

import type { EvolutionConfig } from "../types.js";

// ============================================================================
// SizeLimits Class
// ============================================================================

/**
 * Validates skill content against size and structural limits.
 */
export class SizeLimits {
  // Configurable constants with hardcoded defaults
  readonly maxSkillSizeBytes: number;
  readonly maxDescriptionLength: number;
  readonly maxSectionCount: number;

  constructor(config: EvolutionConfig) {
    const limits = config.sizeLimits ?? {};

    this.maxSkillSizeBytes =
      typeof limits.maxSkillSizeBytes === "number" ? limits.maxSkillSizeBytes : 15_000;
    this.maxDescriptionLength =
      typeof limits.maxDescriptionLength === "number" ? limits.maxDescriptionLength : 500;
    this.maxSectionCount =
      typeof limits.maxSectionCount === "number" ? limits.maxSectionCount : 20;
  }

  /**
   * Check if skill content byte size is within limits.
   */
  checkSkillSize(
    content: string,
  ): {
    valid: boolean;
    sizeBytes: number;
    maxBytes: number;
    error?: string;
  } {
    const sizeBytes = new TextEncoder().encode(content).length;
    const valid = sizeBytes <= this.maxSkillSizeBytes;

    return {
      valid,
      sizeBytes,
      maxBytes: this.maxSkillSizeBytes,
      error: valid
        ? undefined
        : `Skill size (${sizeBytes} bytes) exceeds limit of ${this.maxSkillSizeBytes} bytes`,
    };
  }

  /**
   * Check if description length is within limits.
   */
  checkDescriptionLength(
    description: string,
  ): {
    valid: boolean;
    length: number;
    maxLength: number;
    error?: string;
  } {
    const length = description.length;
    const valid = length <= this.maxDescriptionLength;

    return {
      valid,
      length,
      maxLength: this.maxDescriptionLength,
      error: valid
        ? undefined
        : `Description length (${length}) exceeds limit of ${this.maxDescriptionLength} characters`,
    };
  }

  /**
   * Count the number of markdown sections (## headers) in content.
   */
  private countSections(content: string): number {
    const sectionRegex = /^##\s+.+$/gm;
    const matches = content.match(sectionRegex);
    return matches ? matches.length : 0;
  }

  /**
   * Extract description from YAML frontmatter.
   */
  private extractDescription(content: string): string | undefined {
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/m);
    if (!frontmatterMatch) {
      return undefined;
    }
    const descMatch = frontmatterMatch[1].match(/^description:\s*["']?(.*?)["']?\s*$/m);
    return descMatch ? descMatch[1] : undefined;
  }

  /**
   * Check if content growth vs baseline is within limits.
   * Max growth ratio: 0.5 (50% increase allowed).
   */
  checkGrowth(
    content: string,
    baseline: string,
  ): {
    valid: boolean;
    growthRatio: number;
    maxGrowth: number;
    error?: string;
  } {
    const baselineLength = Math.max(1, baseline.length);
    const growthRatio = (content.length - baselineLength) / baselineLength;
    const maxGrowth = 0.5; // 50% growth limit
    const valid = growthRatio <= maxGrowth;

    return {
      valid,
      growthRatio,
      maxGrowth,
      error: valid
        ? undefined
        : `Growth ${(growthRatio * 100).toFixed(1)}% exceeds max ${(maxGrowth * 100).toFixed(0)}%`,
    };
  }

  /**
   * Run all size and structural checks against skill content.
   */
  checkAll(
    content: string,
  ): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    // Check total byte size
    const sizeResult = this.checkSkillSize(content);
    if (!sizeResult.valid && sizeResult.error) {
      errors.push(sizeResult.error);
    }

    // Count sections
    const sectionCount = this.countSections(content);
    if (sectionCount > this.maxSectionCount) {
      errors.push(
        `Section count (${sectionCount}) exceeds limit of ${this.maxSectionCount}`,
      );
    }

    // Check description length (if frontmatter and description are present)
    const description = this.extractDescription(content);
    if (description !== undefined) {
      const descResult = this.checkDescriptionLength(description);
      if (!descResult.valid && descResult.error) {
        errors.push(descResult.error);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
