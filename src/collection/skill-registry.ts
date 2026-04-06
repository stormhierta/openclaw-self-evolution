/**
 * SkillRegistry - Runtime index of all known OpenClaw skills
 * 
 * Provides lookup and enumeration of skills from SKILL.md files
 * stored in ~/.openclaw/skills/ and workspace skill directories.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

export interface SkillEntry {
  id: string;
  path: string;
  name: string;
  description: string;
  triggerPhrases: string[];
}

interface ParsedFrontmatter {
  name?: string;
  description?: string;
  triggers?: string[];
}

export class SkillRegistry {
  private skillsDirs: string[];
  private byId: Map<string, SkillEntry> = new Map();      // keyed by directory basename (id)
  private byName: Map<string, SkillEntry> = new Map();    // keyed by frontmatter name (lowercased)
  private pathIndex: Map<string, SkillEntry> = new Map();

  constructor(skillsDirs?: string[]) {
    const home = homedir();
    // Skill sources derived from OpenClaw skills-C4NiYd5P.js:
    // managedSkillsDir = path.join(CONFIG_DIR, "skills")  → ~/.openclaw/skills/ (line ~361)
    // workspaceSkillsDir = path.resolve(workspaceDir, "skills") (line ~362)
    // ~/.agents/skills/ (line ~391)
    // extraDirs (bundled) → ~/.npm-global/lib/node_modules/openclaw/skills/ (line ~363, resolved via resolveBundledSkillsDir)
    this.skillsDirs = skillsDirs ?? this.getDefaultSkillsDirs(home);
  }

  private getDefaultSkillsDirs(home: string): string[] {
    const dirs: string[] = [
      join(home, ".openclaw", "skills"),           // managed skills
      join(home, ".openclaw", "workspace", "*", "skills"),  // workspace skills
      join(home, ".agents", "skills"),             // personal agent skills (line ~391)
    ];

    // Detect npm global path for bundled skills (line ~363)
    const npmPrefix = process.env.npm_config_prefix;
    if (npmPrefix) {
      dirs.push(join(npmPrefix, "lib", "node_modules", "openclaw", "skills"));
    } else {
      // Fallback to common npm global locations
      dirs.push(join(home, ".npm-global", "lib", "node_modules", "openclaw", "skills"));
      dirs.push("/usr/local/lib/node_modules/openclaw/skills");
    }

    return dirs;
  }

  scan(): void {
    this.byId.clear();
    this.byName.clear();
    this.pathIndex.clear();

    for (const dirPattern of this.skillsDirs) {
      const dirs = this.expandDirPattern(dirPattern);
      for (const dir of dirs) {
        this.scanDirectory(dir);
      }
    }
  }

  private expandDirPattern(pattern: string): string[] {
    if (pattern.includes("*")) {
      const parts = pattern.split("*");
      const baseDir = parts[0].replace(/\/$/, "");
      const suffix = parts[1] ?? "";

      try {
        const entries = readdirSync(baseDir, { withFileTypes: true });
        return entries
          .filter((e) => e.isDirectory())
          .map((e) => join(baseDir, e.name, suffix));
      } catch {
        return [];
      }
    }
    return [pattern];
  }

  private scanDirectory(dir: string): void {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillDir = join(dir, entry.name);
        const skillPath = join(skillDir, "SKILL.md");

        try {
          statSync(skillPath);
          const skillEntry = this.parseSkill(entry.name, skillPath);
          this.byId.set(skillEntry.id, skillEntry);
          this.byName.set(skillEntry.name.toLowerCase(), skillEntry);
          this.pathIndex.set(skillEntry.path, skillEntry);
        } catch {
          // No SKILL.md in this directory, skip silently
        }
      }
    } catch {
      // Directory doesn't exist or isn't readable, skip silently
    }
  }

  private parseSkill(id: string, path: string): SkillEntry {
    let content: string;
    try {
      content = readFileSync(path, "utf-8");
    } catch (err) {
      console.warn(`[SkillRegistry] Failed to read SKILL.md at ${path}: ${err}`);
      return {
        id,
        path: resolve(path),
        name: id,
        description: "",
        triggerPhrases: [],
      };
    }

    const frontmatter = this.parseFrontmatter(content);

    return {
      id,
      path: resolve(path),
      name: frontmatter.name ?? id,
      description: frontmatter.description ?? "",
      triggerPhrases: frontmatter.triggers ?? [],
    };
  }

  private parseFrontmatter(content: string): ParsedFrontmatter {
    const result: ParsedFrontmatter = {};

    const trimmed = content.trimStart();
    if (!trimmed.startsWith("---")) {
      return result;
    }

    const endMatch = trimmed.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!endMatch) {
      return result;
    }

    const frontmatterText = endMatch[1];
    const lines = frontmatterText.split("\n");

    let currentKey: string | null = null;
    let currentValue: string[] = [];
    let inTriggers = false;

    for (const rawLine of lines) {
      const line = rawLine.trimEnd();

      if (line.trim().startsWith("- ") && inTriggers) {
        const item = line.trim().substring(2).trim();
        const cleanItem = item.replace(/^["'](.*)["']$/, "$1");
        if (!result.triggers) result.triggers = [];
        result.triggers.push(cleanItem);
        continue;
      }

      const keyMatch = line.match(/^(\w+):\s*(.*)$/);
      if (keyMatch) {
        if (currentKey && currentValue.length > 0) {
          this.setFrontmatterValue(result, currentKey, currentValue.join("\n"));
        }

        currentKey = keyMatch[1];
        const value = keyMatch[2].trim();

        if (currentKey === "triggers") {
          inTriggers = true;
          result.triggers = [];
          if (value.startsWith("[") && value.endsWith("]")) {
            try {
              const inlineItems = value
                .slice(1, -1)
                .split(",")
                .map((s) => s.trim().replace(/^["'](.*)["']$/, "$1"));
              result.triggers = inlineItems.filter((s) => s.length > 0);
            } catch {
              // Ignore parse errors
            }
            inTriggers = false;
            currentKey = null;
          }
        } else {
          inTriggers = false;
          if (value) {
            this.setFrontmatterValue(result, currentKey, value);
            currentKey = null;
          } else {
            currentValue = [];
          }
        }
      } else if (currentKey && !inTriggers) {
        currentValue.push(line);
      }
    }

    if (currentKey && currentValue.length > 0) {
      this.setFrontmatterValue(result, currentKey, currentValue.join("\n"));
    }

    return result;
  }

  private setFrontmatterValue(result: ParsedFrontmatter, key: string, value: string): void {
    const trimmed = value.trim();
    if (key === "name") {
      result.name = trimmed;
    } else if (key === "description") {
      result.description = trimmed;
    }
  }

  getSkillByName(name: string): SkillEntry | undefined {
    const lowerName = name.toLowerCase();
    // 1. Try byId (directory basename)
    const byIdMatch = this.byId.get(lowerName);
    if (byIdMatch) return byIdMatch;
    // 2. Try byName (frontmatter name, lowercased)
    const byNameMatch = this.byName.get(lowerName);
    if (byNameMatch) return byNameMatch;
    return undefined;
  }

  getSkillByPath(path: string): SkillEntry | undefined {
    const normalizedPath = resolve(path);
    return this.pathIndex.get(normalizedPath);
  }

  getAllSkills(): SkillEntry[] {
    return Array.from(this.byId.values());
  }

  getSkillPath(id: string): string | undefined {
    return this.byId.get(id)?.path;
  }

  matchSkillsInText(text: string): string[] {
    const matchedIds = new Set<string>();
    const lowerText = text.toLowerCase();

    for (const entry of this.byId.values()) {
      const skillIdPattern = new RegExp(`\\b${entry.id.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      if (skillIdPattern.test(lowerText)) {
        matchedIds.add(entry.id);
        continue;
      }

      if (entry.name) {
        const namePattern = new RegExp(`\\b${entry.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        if (namePattern.test(lowerText)) {
          matchedIds.add(entry.id);
          continue;
        }
      }

      for (const trigger of entry.triggerPhrases) {
        if (trigger) {
          const triggerPattern = new RegExp(`\\b${trigger.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
          if (triggerPattern.test(lowerText)) {
            matchedIds.add(entry.id);
            break;
          }
        }
      }

      const pathPattern = new RegExp(`\\b${entry.path.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
      if (pathPattern.test(lowerText)) {
        matchedIds.add(entry.id);
        continue;
      }
    }

    return Array.from(matchedIds);
  }
}

let skillRegistryInstance: SkillRegistry | null = null;

export function getSkillRegistry(): SkillRegistry {
  if (!skillRegistryInstance) {
    skillRegistryInstance = new SkillRegistry();
    skillRegistryInstance.scan();
  }
  return skillRegistryInstance;
}

export function resetSkillRegistry(): void {
  skillRegistryInstance = null;
}
