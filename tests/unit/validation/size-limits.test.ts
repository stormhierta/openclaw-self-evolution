import { SizeLimits } from "../../../src/validation/size-limits.js";
import type { EvolutionConfig } from "../../../src/types.js";

const defaultConfig: EvolutionConfig = {
  enabled: true,
  trajectory: { enabled: false, sampleRate: 1, maxTurnsPerSession: 100 },
  evolution: {
    autoRun: false,
    maxGenerations: 10,
    populationSize: 10,
    mutationRate: 0.1,
    eliteSize: 2,
    targetSkills: [],
    useDspyBridge: false,
    schedule: { cron: "0 0 * * *" },
  },
  costLimits: { maxTokensPerRun: 1_000_000, maxCostPerRun: 10, maxConcurrentRuns: 1 },
  retentionDays: 30,
  storage: {},
};

describe("SizeLimits", () => {
  describe("checkSkillSize", () => {
    it("returns valid for content within byte limit", () => {
      const limits = new SizeLimits(defaultConfig);
      const result = limits.checkSkillSize("Hello, world!");
      expect(result.valid).toBe(true);
      expect(result.sizeBytes).toBeGreaterThan(0);
      expect(result.sizeBytes).toBeLessThanOrEqual(limits.maxSkillSizeBytes);
      expect(result.error).toBeUndefined();
    });

    it("returns invalid for content exceeding byte limit", () => {
      const limits = new SizeLimits(defaultConfig);
      const hugeContent = "x".repeat(100_000);
      const result = limits.checkSkillSize(hugeContent);
      expect(result.valid).toBe(false);
      expect(result.sizeBytes).toBeGreaterThan(limits.maxSkillSizeBytes);
      expect(result.error).toContain("exceeds limit");
    });

    it("returns valid for content at exactly the byte boundary", () => {
      const config: EvolutionConfig = {
        ...defaultConfig,
        sizeLimits: { maxSkillSizeBytes: 100 },
      };
      const limits = new SizeLimits(config);
      const exactContent = "x".repeat(100);
      const result = limits.checkSkillSize(exactContent);
      expect(result.valid).toBe(true);
      expect(result.sizeBytes).toBe(100);
    });

    it("reports correct byte size for unicode content", () => {
      const limits = new SizeLimits(defaultConfig);
      // Emoji characters can be 4 bytes in UTF-8
      const emojiContent = "🎉🎊🎁";
      const result = limits.checkSkillSize(emojiContent);
      expect(result.valid).toBe(true);
      // Each emoji is ~4 bytes in UTF-8
      expect(result.sizeBytes).toBe(new TextEncoder().encode(emojiContent).length);
    });
  });

  describe("checkDescriptionLength", () => {
    it("returns valid for description within length limit", () => {
      const limits = new SizeLimits(defaultConfig);
      const result = limits.checkDescriptionLength("A reasonable description.");
      expect(result.valid).toBe(true);
      expect(result.length).toBe("A reasonable description.".length);
      expect(result.error).toBeUndefined();
    });

    it("returns invalid for description exceeding length limit", () => {
      const config: EvolutionConfig = {
        ...defaultConfig,
        sizeLimits: { maxDescriptionLength: 10 },
      };
      const limits = new SizeLimits(config);
      const result = limits.checkDescriptionLength("This description is way too long.");
      expect(result.valid).toBe(false);
      expect(result.length).toBeGreaterThan(10);
      expect(result.error).toContain("exceeds limit");
    });

    it("returns valid for empty description", () => {
      const limits = new SizeLimits(defaultConfig);
      const result = limits.checkDescriptionLength("");
      expect(result.valid).toBe(true);
      expect(result.length).toBe(0);
    });
  });

  describe("checkAll", () => {
    it("passes for valid skill content with frontmatter", () => {
      const limits = new SizeLimits(defaultConfig);
      const content = `---
name: test-skill
description: "A short description"
---
## Overview
Some content here.
`;
      const result = limits.checkAll(content);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("fails when size limit is exceeded", () => {
      const config: EvolutionConfig = {
        ...defaultConfig,
        sizeLimits: { maxSkillSizeBytes: 50 },
      };
      const limits = new SizeLimits(config);
      const content = `---
name: test-skill
description: "A short description"
---
## Overview
${"x".repeat(200)}
`;
      const result = limits.checkAll(content);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("exceeds limit"))).toBe(true);
    });

    it("fails when section count exceeds limit", () => {
      const config: EvolutionConfig = {
        ...defaultConfig,
        sizeLimits: { maxSectionCount: 1 },
      };
      const limits = new SizeLimits(config);
      const content = `---
name: test-skill
description: "A short description"
---
## Section One
Content

## Section Two
More content
`;
      const result = limits.checkAll(content);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Section count"))).toBe(true);
    });

    it("fails when description length exceeds limit", () => {
      const config: EvolutionConfig = {
        ...defaultConfig,
        sizeLimits: { maxDescriptionLength: 5 },
      };
      const limits = new SizeLimits(config);
      const content = `---
name: test-skill
description: "This description is far too long"
---
## Overview
Content
`;
      const result = limits.checkAll(content);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Description length"))).toBe(true);
    });

    it("passes when all constraints are satisfied", () => {
      const limits = new SizeLimits(defaultConfig);
      const content = `---
name: test-skill
description: "OK"
---
## Usage
Just right.
`;
      const result = limits.checkAll(content);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("does not fail on description length when frontmatter has no description", () => {
      const config: EvolutionConfig = {
        ...defaultConfig,
        sizeLimits: { maxDescriptionLength: 5 },
      };
      const limits = new SizeLimits(config);
      const content = `---
name: test-skill
---
## Overview
Content
`;
      const result = limits.checkAll(content);
      expect(result.valid).toBe(true);
    });
  });
});
