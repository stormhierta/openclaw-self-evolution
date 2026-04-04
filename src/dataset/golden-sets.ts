/**
 * OpenClaw Self-Evolution Pipeline - Golden Set Loader
 * 
 * Loads hand-curated benchmark test cases from JSON/JSONL files.
 * 
 * References:
 * - DatasetEntry type from src/types.ts (lines 245-255)
 * - EvolutionConfig type from src/types.ts (lines 25-35)
 * - StorageConfig from src/config.ts (lines 62-66)
 * - File patterns from src/dataset/manager.ts (lines 42-56)
 */

import type { DatasetEntry, EvolutionConfig } from "../types.js";
import { join, dirname, basename } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";

/**
 * GoldenSetLoader loads hand-curated benchmark test cases from JSONL files.
 * 
 * Golden set files are stored as `{goldenSetsDir}/{skillName}.jsonl`
 * with one DatasetEntry per line.
 * 
 * Source: File I/O patterns from src/dataset/manager.ts
 */
export class GoldenSetLoader {
  private config: EvolutionConfig;
  private goldenSetsDir: string;

  constructor(config: EvolutionConfig) {
    this.config = config;
    this.goldenSetsDir = this.resolveGoldenSetsDir();
  }

  /**
   * Resolve the golden sets directory path.
   * 
   * Priority:
   * 1. Configured path if explicitly set
   * 2. `config.storage.datasetPath/../golden-sets/`
   * 3. Default fallback: `~/.openclaw/evolution/golden-sets/`
   * 
   * Source: Same pattern as DatasetManager.getDatasetPath() in manager.ts
   */
  private resolveGoldenSetsDir(): string {
    // Check if explicitly configured (could be added to StorageConfig)
    const configuredPath = (this.config.storage as Record<string, string | undefined>)
      .goldenSetsPath;
    if (configuredPath) {
      return configuredPath;
    }

    // Derive from datasetPath
    if (this.config.storage.datasetPath) {
      return join(dirname(this.config.storage.datasetPath), "golden-sets");
    }

    // Default fallback
    return join(process.env.HOME ?? ".", ".openclaw", "evolution", "golden-sets");
  }

  /**
   * Get the file path for a skill's golden set.
   */
  private getGoldenSetPath(skillName: string): string {
    return join(this.goldenSetsDir, `${skillName}.jsonl`);
  }

  /**
   * Load golden set entries for a specific skill.
   * 
   * @param skillName - Name of the skill to load golden set for
   * @returns Array of DatasetEntry objects
   * @throws Error if the golden set file doesn't exist or is invalid
   */
  async loadForSkill(skillName: string): Promise<DatasetEntry[]> {
    const filePath = this.getGoldenSetPath(skillName);

    if (!existsSync(filePath)) {
      throw new Error(`Golden set not found for skill: ${skillName} at ${filePath}`);
    }

    const entries: DatasetEntry[] = [];
    const errors: string[] = [];

    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n").filter(line => line.trim().length > 0);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        try {
          const parsed = JSON.parse(line) as Partial<DatasetEntry>;
          const entry = this.normalizeEntry(parsed);
          
          if (this.isValidEntry(entry)) {
            entries.push(entry);
          } else {
            errors.push(`Line ${i + 1}: Invalid entry structure`);
          }
        } catch (parseError) {
          const message = parseError instanceof Error ? parseError.message : String(parseError);
          errors.push(`Line ${i + 1}: JSON parse error - ${message}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to read golden set for ${skillName}: ${message}`);
    }

    if (entries.length === 0 && errors.length > 0) {
      throw new Error(`Golden set for ${skillName} contains no valid entries. Errors: ${errors.join("; ")}`);
    }

    return entries;
  }

  /**
   * List all skills that have golden sets available.
   * 
   * @returns Array of skill names
   */
  async listAvailableSkills(): Promise<string[]> {
    if (!existsSync(this.goldenSetsDir)) {
      return [];
    }

    const skills: string[] = [];

    try {
      const entries = readdirSync(this.goldenSetsDir);
      
      for (const entry of entries) {
        const fullPath = join(this.goldenSetsDir, entry);
        
        try {
          const stats = statSync(fullPath);
          if (stats.isFile() && entry.endsWith(".jsonl")) {
            // Extract skill name from filename (remove .jsonl extension)
            const skillName = basename(entry, ".jsonl");
            skills.push(skillName);
          }
        } catch {
          // Skip entries that can't be stat'd
        }
      }
    } catch {
      // Directory might not exist or be readable
    }

    return skills.sort();
  }

  /**
   * Validate a golden set file for a skill.
   * 
   * @param skillName - Name of the skill to validate
   * @returns Validation result with counts and errors
   */
  async validateGoldenSet(skillName: string): Promise<{
    valid: number;
    invalid: number;
    errors: string[];
  }> {
    const filePath = this.getGoldenSetPath(skillName);
    
    if (!existsSync(filePath)) {
      return {
        valid: 0,
        invalid: 0,
        errors: [`Golden set file not found: ${filePath}`],
      };
    }

    let valid = 0;
    let invalid = 0;
    const errors: string[] = [];

    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n").filter(line => line.trim().length > 0);

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        try {
          const parsed = JSON.parse(line) as Partial<DatasetEntry>;
          const entry = this.normalizeEntry(parsed);
          
          if (this.isValidEntry(entry)) {
            valid++;
          } else {
            invalid++;
            errors.push(`Line ${i + 1}: Missing required fields`);
          }
        } catch (parseError) {
          invalid++;
          const message = parseError instanceof Error ? parseError.message : String(parseError);
          errors.push(`Line ${i + 1}: ${message}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`File read error: ${message}`);
    }

    return { valid, invalid, errors };
  }

  /**
   * Write or update a golden set file for a skill.
   * 
   * @param skillName - Name of the skill
   * @param entries - Array of DatasetEntry objects to write
   */
  async writeGoldenSet(skillName: string, entries: DatasetEntry[]): Promise<void> {
    // Ensure directory exists
    try {
      mkdirSync(this.goldenSetsDir, { recursive: true });
    } catch {
      // Directory may already exist
    }

    const filePath = this.getGoldenSetPath(skillName);
    const lines: string[] = [];

    for (const entry of entries) {
      // Normalize entry before writing
      const normalized = this.normalizeEntry(entry);
      
      // Write only the essential fields for storage
      const record = {
        id: normalized.id,
        datasetId: normalized.datasetId,
        input: normalized.input,
        expected_output: normalized.expectedOutput,
        context: normalized.context,
        score: normalized.score,
        metadata: normalized.metadata,
        createdAt: normalized.createdAt.toISOString(),
      };
      
      lines.push(JSON.stringify(record));
    }

    try {
      writeFileSync(filePath, lines.join("\n") + (lines.length > 0 ? "\n" : ""));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to write golden set for ${skillName}: ${message}`);
    }
  }

  /**
   * Normalize a partial DatasetEntry to ensure all required fields are present.
   */
  private normalizeEntry(parsed: Partial<DatasetEntry> & { expected_output?: string }): DatasetEntry {
    const now = new Date();
    
    return {
      id: parsed.id ?? `golden-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      datasetId: parsed.datasetId ?? "golden-set",
      input: parsed.input ?? "",
      expectedOutput: parsed.expected_output ?? parsed.expectedOutput ?? "",
      context: parsed.context,
      score: parsed.score,
      metadata: parsed.metadata,
      createdAt: parsed.createdAt instanceof Date 
        ? parsed.createdAt 
        : typeof parsed.createdAt === "string"
          ? new Date(parsed.createdAt)
          : now,
    };
  }

  /**
   * Check if an entry has all required fields.
   * 
   * Required fields per DatasetEntry type (src/types.ts lines 245-255):
   * - id: string
   * - datasetId: string
   * - input: string
   * - expectedOutput: string
   * - createdAt: Date
   */
  private isValidEntry(entry: DatasetEntry): boolean {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      return false;
    }
    
    if (typeof entry.datasetId !== "string" || entry.datasetId.length === 0) {
      return false;
    }
    
    if (typeof entry.input !== "string" || entry.input.length === 0) {
      return false;
    }
    
    if (typeof entry.expectedOutput !== "string" || entry.expectedOutput.length === 0) {
      return false;
    }
    
    if (!(entry.createdAt instanceof Date) || isNaN(entry.createdAt.getTime())) {
      return false;
    }
    
    return true;
  }
}
