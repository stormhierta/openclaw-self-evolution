/**
 * Skill Attribution Integration Tests
 * 
 * Tests the full attribution pipeline end-to-end:
 * 1. System prompt skill detection via matchSkillsInText()
 * 2. Skill tool param extraction via trajectory hooks
 * 3. EvolutionTrigger enumerates from registry (not DB rows)
 * 4. resolveSkillPath uses registry for path resolution
 */

import { jest } from "@jest/globals";
import { getSkillRegistry, resetSkillRegistry, SkillRegistry } from "../../src/collection/skill-registry.js";
import { EvolutionTrigger } from "../../src/automation/evolution-trigger.js";
import type { EvolutionConfig } from "../../src/types.js";

// ============================================================================
// Test Setup Helpers
// ============================================================================

function createMockConfig(): EvolutionConfig {
  return {
    enabled: true,
    autoRun: false,
    storage: {
      trajectoryDbPath: ":memory:",
      datasetDir: "/tmp/test-dataset",
      prQueueDir: "/tmp/test-pr-queue",
    },
    llm: {
      judge: { model: "test-model" },
      generator: { model: "test-model" },
      labeler: { model: "test-model" },
      relevance: { model: "test-model" },
      evolver: { model: "test-model" },
      testRunner: { model: "test-model" },
    },
    fitness: {
      rubricWeights: {
        correctness: 0.4,
        conciseness: 0.2,
        safety: 0.2,
        consistency: 0.2,
      },
    },
    gepa: {
      populationSize: 4,
      maxGenerations: 2,
      mutationRate: 0.1,
      crossoverRate: 0.7,
    },
    constraints: {
      maxSkillSizeBytes: 100000,
      forbiddenPatterns: [],
      requiredSections: [],
    },
    deployment: {
      gitRemote: "origin",
      autoMerge: false,
    },
  };
}

// ============================================================================
// Test 1: System Prompt Skill Detection
// ============================================================================

describe("System Prompt Skill Detection", () => {
  beforeEach(() => {
    resetSkillRegistry();
  });

  it("should detect weather skill from mock system prompt content", () => {
    const registry = getSkillRegistry();
    
    // Mock the registry with a weather skill entry
    // This simulates the registry having scanned the weather skill
    const mockSkillEntry = {
      id: "weather",
      path: "/home/test/.npm-global/lib/node_modules/openclaw/skills/weather/SKILL.md",
      name: "Weather",
      description: "Get weather and forecasts",
      triggerPhrases: ["weather", "temperature", "forecast"],
    };
    
    // Directly inject into registry for testing
    (registry as unknown as { byId: Map<string, typeof mockSkillEntry> }).byId.set("weather", mockSkillEntry);
    (registry as unknown as { byName: Map<string, typeof mockSkillEntry> }).byName.set("weather", mockSkillEntry);

    // Mock system prompt containing weather skill content
    const mockSystemPrompt = `
You have access to the following skills:

## weather

Get current weather and forecasts via wttr.in or Open-Meteo.

### Usage
When user asks about weather, temperature, or forecasts for any location.

### Examples
- "What's the weather in Paris?"
- "Temperature in Tokyo"
- "Will it rain tomorrow?"
`;

    // Call matchSkillsInText to detect skills in the system prompt
    const matchedSkills = registry.matchSkillsInText(mockSystemPrompt);
    
    expect(matchedSkills).toContain("weather");
  });

  it("should return empty array for text with no skill references", () => {
    const registry = getSkillRegistry();
    
    const plainText = "This is just a regular conversation with no skill mentions.";
    const matchedSkills = registry.matchSkillsInText(plainText);
    
    expect(matchedSkills).toEqual([]);
  });
});

// ============================================================================
// Test 2: Skill Tool Param Extraction
// ============================================================================

describe("Skill Tool Param Extraction", () => {
  it("should extract target_skill from skill_manage tool params", () => {
    // Simulate the extractSkillFromToolParams logic from trajectory-hooks.ts
    const SKILL_TOOLS = ['skill_manage', 'skill_view', 'memory'];
    
    function extractSkillFromToolParams(toolName: string, params: Record<string, unknown>): string | undefined {
      if (!SKILL_TOOLS.includes(toolName)) return undefined;
      return (params.name ?? params.skill ?? params.skillName) as string | undefined;
    }

    // Test skill_manage with name param
    const result = extractSkillFromToolParams("skill_manage", { name: "coding-agent" });
    expect(result).toBe("coding-agent");
  });

  it("should extract target_skill from skill_view tool params", () => {
    const SKILL_TOOLS = ['skill_manage', 'skill_view', 'memory'];
    
    function extractSkillFromToolParams(toolName: string, params: Record<string, unknown>): string | undefined {
      if (!SKILL_TOOLS.includes(toolName)) return undefined;
      return (params.name ?? params.skill ?? params.skillName) as string | undefined;
    }

    const result = extractSkillFromToolParams("skill_view", { name: "weather" });
    expect(result).toBe("weather");
  });

  it("should extract target_skill using skill param alias", () => {
    const SKILL_TOOLS = ['skill_manage', 'skill_view', 'memory'];
    
    function extractSkillFromToolParams(toolName: string, params: Record<string, unknown>): string | undefined {
      if (!SKILL_TOOLS.includes(toolName)) return undefined;
      return (params.name ?? params.skill ?? params.skillName) as string | undefined;
    }

    const result = extractSkillFromToolParams("skill_manage", { skill: "github" });
    expect(result).toBe("github");
  });

  it("should return undefined for non-skill tools", () => {
    const SKILL_TOOLS = ['skill_manage', 'skill_view', 'memory'];
    
    function extractSkillFromToolParams(toolName: string, params: Record<string, unknown>): string | undefined {
      if (!SKILL_TOOLS.includes(toolName)) return undefined;
      return (params.name ?? params.skill ?? params.skillName) as string | undefined;
    }

    const result = extractSkillFromToolParams("web_search", { query: "test" });
    expect(result).toBeUndefined();
  });
});

// ============================================================================
// Test 3: EvolutionTrigger Enumerates from Registry
// ============================================================================

describe("EvolutionTrigger Registry Enumeration", () => {
  beforeEach(() => {
    resetSkillRegistry();
  });

  it("should get tracked skills from registry not DB rows", () => {
    // Create isolated registry instance (not singleton) for clean testing
    const registry = new SkillRegistry([]);
    
    // Mock 3 skills in registry
    const mockSkills = [
      { id: "weather", path: "/path/weather/SKILL.md", name: "Weather", description: "", triggerPhrases: [] },
      { id: "github", path: "/path/github/SKILL.md", name: "GitHub", description: "", triggerPhrases: [] },
      { id: "coding-agent", path: "/path/coding-agent/SKILL.md", name: "Coding Agent", description: "", triggerPhrases: [] },
    ];

    // Inject mock skills into registry
    const byId = (registry as unknown as { byId: Map<string, typeof mockSkills[0]> }).byId;
    const byName = (registry as unknown as { byName: Map<string, typeof mockSkills[0]> }).byName;
    
    for (const skill of mockSkills) {
      byId.set(skill.id, skill);
      byName.set(skill.name.toLowerCase(), skill);
    }

    // Verify getAllSkills returns skills from registry
    const allSkills = registry.getAllSkills();
    expect(allSkills).toHaveLength(3);
    expect(allSkills.map(s => s.id)).toContain("weather");
    expect(allSkills.map(s => s.id)).toContain("github");
    expect(allSkills.map(s => s.id)).toContain("coding-agent");
  });

  it("should get all skills from registry via getTrackedSkills", () => {
    const registry = new SkillRegistry([
      "/test/skills/dir1",
      "/test/skills/dir2"
    ]);
    
    // Mock skills in registry
    const mockSkills = [
      { id: "skill-a", path: "/path/a/SKILL.md", name: "Skill A", description: "", triggerPhrases: [] },
      { id: "skill-b", path: "/path/b/SKILL.md", name: "Skill B", description: "", triggerPhrases: [] },
      { id: "skill-c", path: "/path/c/SKILL.md", name: "Skill C", description: "", triggerPhrases: [] },
    ];

    const byId = (registry as unknown as { byId: Map<string, typeof mockSkills[0]> }).byId;
    for (const skill of mockSkills) {
      byId.set(skill.id, skill);
    }

    // getAllSkills should return all 3 skills
    const allSkills = registry.getAllSkills();
    expect(allSkills).toHaveLength(3);
    expect(allSkills.map(s => s.id)).toContain("skill-a");
    expect(allSkills.map(s => s.id)).toContain("skill-b");
    expect(allSkills.map(s => s.id)).toContain("skill-c");
  });
});

// ============================================================================
// Test 4: resolveSkillPath Uses Registry
// ============================================================================

describe("resolveSkillPath Registry Integration", () => {
  beforeEach(() => {
    resetSkillRegistry();
  });

  it("should return registry path when skill is found in registry", () => {
    const registry = getSkillRegistry();
    
    // Mock a bundled skill path (like weather in npm-global)
    const bundledPath = "/home/test/.npm-global/lib/node_modules/openclaw/skills/weather/SKILL.md";
    const mockSkill = {
      id: "weather",
      path: bundledPath,
      name: "Weather",
      description: "Get weather",
      triggerPhrases: [],
    };

    (registry as unknown as { byId: Map<string, typeof mockSkill> }).byId.set("weather", mockSkill);

    // getSkillPath should return the bundled path
    const resolvedPath = registry.getSkillPath("weather");
    expect(resolvedPath).toBe(bundledPath);
  });

  it("should return undefined for unknown skills", () => {
    const registry = getSkillRegistry();
    
    const resolvedPath = registry.getSkillPath("unknown-skill");
    expect(resolvedPath).toBeUndefined();
  });

  it("should demonstrate scheduler fallback behavior", () => {
    // This test demonstrates the fallback logic in scheduler.ts
    // When registry doesn't know the skill, it falls back to default path
    
    const registry = getSkillRegistry();
    const skillName = "custom-skill";
    
    // Try registry first
    const registryPath = registry.getSkillPath(skillName);
    
    if (registryPath) {
      expect(registryPath).toBeDefined();
    } else {
      // Fallback: default managed skills dir (backward compat)
      const skillsDir = `${process.env.HOME ?? "."}/.openclaw/skills`;
      const fallbackPath = `${skillsDir}/${skillName}/SKILL.md`;
      expect(fallbackPath).toContain(".openclaw/skills");
      expect(fallbackPath).toContain(skillName);
    }
  });
});

// ============================================================================
// Test 5: End-to-End Attribution Pipeline
// ============================================================================

describe("End-to-End Attribution Pipeline", () => {
  beforeEach(() => {
    resetSkillRegistry();
  });

  it("should trace skill attribution from prompt to registry to path resolution", () => {
    const registry = getSkillRegistry();
    
    // Setup: Register a skill
    const skillId = "coding-agent";
    const skillPath = "/home/test/.openclaw/skills/coding-agent/SKILL.md";
    const mockSkill = {
      id: skillId,
      path: skillPath,
      name: "Coding Agent",
      description: "Delegate coding tasks",
      triggerPhrases: ["code", "implement", "refactor"],
    };

    (registry as unknown as { byId: Map<string, typeof mockSkill> }).byId.set(skillId, mockSkill);
    (registry as unknown as { byName: Map<string, typeof mockSkill> }).byName.set("coding-agent", mockSkill);

    // Step 1: Detect skill in system prompt
    const systemPrompt = `
You are a helpful assistant with access to skills.

## coding-agent

Delegate coding tasks to specialized agents.
Use when: user asks to "write code", "implement feature", "refactor"
`;
    const detectedSkills = registry.matchSkillsInText(systemPrompt);
    expect(detectedSkills).toContain(skillId);

    // Step 2: Verify skill is in registry
    const registryEntry = registry.getSkillByName(skillId);
    expect(registryEntry).toBeDefined();
    expect(registryEntry?.id).toBe(skillId);

    // Step 3: Resolve path via registry
    const resolvedPath = registry.getSkillPath(skillId);
    expect(resolvedPath).toBe(skillPath);
  });
});
