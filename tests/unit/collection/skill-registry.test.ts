import { SkillRegistry, getSkillRegistry, resetSkillRegistry } from "../../../src/collection/skill-registry.js";
import { describe, it, expect, beforeEach } from "@jest/globals";

describe("SkillRegistry", () => {
  beforeEach(() => {
    resetSkillRegistry();
  });

  it("should scan skills directories and find skills", () => {
    const registry = new SkillRegistry();
    registry.scan();
    
    const skills = registry.getAllSkills();
    expect(skills.length).toBeGreaterThan(0);
  });

  it("should get skill by id using getSkillByName", () => {
    const registry = new SkillRegistry();
    registry.scan();
    
    const skill = registry.getSkillByName("chunk-coder");
    expect(skill).toBeDefined();
    expect(skill?.id).toBe("chunk-coder");
    expect(skill?.name).toBeDefined();
    expect(skill?.path).toContain("SKILL.md");
  });

  it("should get skill path using getSkillPath", () => {
    const registry = new SkillRegistry();
    registry.scan();
    
    const path = registry.getSkillPath("chunk-coder");
    expect(path).toBeDefined();
    expect(path).toContain("SKILL.md");
  });

  it("should match skills in text by id", () => {
    const registry = new SkillRegistry();
    registry.scan();
    
    const text = "Use the chunk-coder skill to break down this task";
    const matched = registry.matchSkillsInText(text);
    
    expect(matched).toContain("chunk-coder");
  });

  it("should match skills in text by name", () => {
    const registry = new SkillRegistry();
    registry.scan();
    
    // Get a skill to know its name
    const skill = registry.getSkillByName("chunk-coder");
    if (skill && skill.name) {
      const text = `Use ${skill.name} for this task`;
      const matched = registry.matchSkillsInText(text);
      expect(matched).toContain("chunk-coder");
    }
  });

  it("should match skills in text by path", () => {
    const registry = new SkillRegistry();
    registry.scan();
    
    const skill = registry.getSkillByName("chunk-coder");
    if (skill) {
      const text = `Loading skill from ${skill.path}`;
      const matched = registry.matchSkillsInText(text);
      expect(matched).toContain("chunk-coder");
    }
  });

  it("should return empty array when no skills match", () => {
    const registry = new SkillRegistry();
    registry.scan();
    
    const text = "This text has no skill references whatsoever";
    const matched = registry.matchSkillsInText(text);
    
    expect(matched).toEqual([]);
  });

  it("should get skill by path", () => {
    const registry = new SkillRegistry();
    registry.scan();
    
    const skill = registry.getSkillByName("chunk-coder");
    if (skill) {
      const foundByPath = registry.getSkillByPath(skill.path);
      expect(foundByPath).toBeDefined();
      expect(foundByPath?.id).toBe("chunk-coder");
    }
  });

  it("should provide singleton via getSkillRegistry", () => {
    const registry1 = getSkillRegistry();
    const registry2 = getSkillRegistry();
    
    expect(registry1).toBe(registry2);
    expect(registry1.getAllSkills().length).toBeGreaterThan(0);
  });
});
