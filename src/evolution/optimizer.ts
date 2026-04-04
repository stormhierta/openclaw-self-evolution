/**
 * OpenClaw Self-Evolution Pipeline - Evolution Optimizer
 *
 * Orchestrates the full evolution cycle for a skill.
 *
 * Types referenced:
 * - EvolutionConfig, EvolutionRun, EvolutionRunRow, EvolutionStatus,
 *   EvolutionResult, EvolutionProgress, SkillVariant, EvolutionEngineConfig
 *   from src/types.ts
 * - GEPAEvolver, EvolutionResult from src/evolution/gepa/evolver.ts
 * - DatasetManager from src/dataset/manager.ts
 * - DatasetBuilder from src/dataset/builder.ts
 *
 * SQLite storage pattern: same as DatasetManager (src/dataset/manager.ts)
 * using better-sqlite3 with prepared statements.
 */

import Database from "better-sqlite3";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

import type {
  EvolutionConfig,
  EvolutionRun,
  EvolutionRunRow,
  EvolutionStatus,
  EvolutionProgress,
  SkillVariant,
  EvolutionEngineConfig,
  DatasetEntry,
} from "../types.js";
import type { GEPAEvolver, EvolutionResult } from "./gepa/evolver.js";
import type { DatasetManager } from "../dataset/manager.js";
import type { DatasetBuilder } from "../dataset/builder.js";

// ============================================================================
// OptimizeOptions
// ============================================================================

/**
 * Options for the optimizeSkill() method.
 *
 * All fields are optional and fall back to config.evolution values.
 */
export interface OptimizeOptions {
  /** Maximum number of generations (default: config.evolution.maxGenerations) */
  maxGenerations?: number;
  /** Size of the population (default: config.evolution.populationSize) */
  populationSize?: number;
  /** Stop evolution if this score is reached (default: 0.9) */
  targetScore?: number;
  /** Use an existing dataset if provided (default: build new) */
  datasetId?: string;
  /** Build a new dataset if no datasetId provided (default: true) */
  buildNewDataset?: boolean;
  /** Required for applyBestVariant to confirm the write (default: false) */
  confirm?: boolean;
}

// ============================================================================
// EvolutionOptimizer
// ============================================================================

/**
 * EvolutionOptimizer orchestrates the full evolution cycle for a skill.
 *
 * Responsibilities:
 * 1. Manage evolution run lifecycle (create, track, complete)
 * 2. Build or load datasets for evaluation
 * 3. Execute evolution via GEPAEvolver
 * 4. Persist run records to SQLite
 * 5. Apply best variant back to skill file
 *
 * Storage: manages its own SQLite database for evolution run records,
 * stored at config.storage.evolutionLogPath or default path.
 * Pattern matches: DatasetManager (src/dataset/manager.ts)
 */
export class EvolutionOptimizer {
  private config: EvolutionConfig;
  private evolver: GEPAEvolver;
  private datasetManager: DatasetManager;
  private datasetBuilder: DatasetBuilder;
  private db: Database.Database | null = null;
  private isInitialized = false;

  // Prepared statements
  private insertRunStmt: Database.Statement | null = null;
  private getRunStmt: Database.Statement | null = null;
  private listRunsStmt: Database.Statement | null = null;

  constructor(
    config: EvolutionConfig,
    evolver: GEPAEvolver,
    datasetManager: DatasetManager,
    datasetBuilder: DatasetBuilder
  ) {
    this.config = config;
    this.evolver = evolver;
    this.datasetManager = datasetManager;
    this.datasetBuilder = datasetBuilder;
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Run a complete optimization cycle for a skill.
   *
   * Steps:
   * 1. Create an EvolutionRun record in SQLite
   * 2. If no datasetId, build a dataset via datasetBuilder.buildForSkill()
   * 3. Load test cases from dataset via datasetManager.getEntries()
   * 4. Read current skill content from skillPath
   * 5. Run evolution via evolver.evolveSkill()
   * 6. Store result in run record
   * 7. Return completed EvolutionRun
   *
   * @param skillName - Name of the skill to optimize
   * @param skillPath - Absolute path to the skill's SKILL.md file
   * @param options - Optional optimization parameters
   * @returns The completed EvolutionRun with results
   */
  async optimizeSkill(
    skillName: string,
    skillPath: string,
    options?: OptimizeOptions
  ): Promise<EvolutionRun> {
    await this.initialize();

    if (!this.db || !this.insertRunStmt) {
      throw new Error("Database not initialized");
    }

    // Resolve options with defaults
    const buildNewDataset = options?.buildNewDataset ?? (options?.datasetId ? false : true);
    const engineConfig = this.config.evolution;
    const maxGenerations = options?.maxGenerations ?? engineConfig.maxGenerations;
    const populationSize = options?.populationSize ?? engineConfig.populationSize;

    // Step 1: Create EvolutionRun record (status: pending → running)
    const runId = this.generateRunId();
    const now = new Date();

    const runRecord: EvolutionRun = {
      id: runId,
      skillName,
      status: "running",
      config: engineConfig,
      currentGeneration: 0,
      maxGenerations,
      variants: [],
      progress: {
        currentGeneration: 0,
        totalGenerations: maxGenerations,
        variantsEvaluated: 0,
        totalVariants: 0,
        bestFitnessScore: 0,
        averageFitnessScore: 0,
      },
      startedAt: now,
    };

    // Persist initial run record
    this.insertRunStmt.run(
      runRecord.id,
      runRecord.skillName,
      skillPath, // skill_path for later retrieval
      runRecord.status,
      JSON.stringify(runRecord.config),
      runRecord.currentGeneration,
      runRecord.maxGenerations,
      undefined, // best_variant_id set after evolution
      undefined, // best_variant_content set after evolution
      JSON.stringify(runRecord.progress),
      runRecord.startedAt.toISOString(),
      undefined // completed_at
    );

    try {
      // Step 2: Build or load dataset
      let datasetId = options?.datasetId;
      if (!datasetId) {
        if (buildNewDataset) {
          // Read skill content for dataset building context
          const skillContent = this.readSkillContent(skillPath);
          const skillDescription = this.extractSkillDescription(skillContent);
          const manifest = await this.datasetBuilder.buildForSkill(skillName, skillDescription);
          datasetId = manifest.id;
        }
      }

      if (!datasetId) {
        throw new Error("No datasetId available: either provide datasetId or set buildNewDataset=true");
      }

      // Step 3: Load test cases from dataset
      const testCases = await this.datasetManager.getEntries(datasetId);
      if (testCases.length === 0) {
        throw new Error(`Dataset ${datasetId} has no entries`);
      }

      // Step 4: Read current skill content
      const skillContent = this.readSkillContent(skillPath);

      // Step 5: Run evolution via evolver.evolveSkill()
      // Source: GEPAEvolver.evolveSkill() signature (evolver.ts)
      const evolutionResult = await this.evolver.evolveSkill(
        skillName,
        skillContent,
        testCases,
        {
          maxGenerations,
          populationSize,
          targetScore: options?.targetScore,
        }
      );

      // Step 6: Store result in run record
      const finalProgress: EvolutionProgress = {
        currentGeneration: evolutionResult.generationsCompleted,
        totalGenerations: maxGenerations,
        variantsEvaluated: evolutionResult.totalVariantsEvaluated,
        totalVariants: evolutionResult.totalVariantsEvaluated,
        bestFitnessScore: evolutionResult.bestScore.overall,
        averageFitnessScore:
          evolutionResult.generationHistory.length > 0
            ? evolutionResult.generationHistory[evolutionResult.generationHistory.length - 1]
                .averageOverallScore
            : 0,
      };

      const completedAt = new Date();
      const finalStatus: EvolutionStatus = evolutionResult.stoppedEarly ? "completed" : "completed";

      // Update DB with best variant ID, content, and completion info
      // Use direct UPDATE rather than prepared statement for this specific update
      this.db
        .prepare(
          `UPDATE evolution_runs
             SET status = ?,
                 current_generation = ?,
                 best_variant_id = ?,
                 best_variant_content = ?,
                 completed_at = ?,
                 error_message = ?
             WHERE id = ?`
        )
        .run(
          finalStatus,
          evolutionResult.generationsCompleted,
          evolutionResult.bestVariant.id,
          evolutionResult.bestVariant.content,
          completedAt.toISOString(),
          evolutionResult.stoppedEarly
            ? `Stopped early: ${evolutionResult.stopReason}`
            : null,
          runId
        );

      // Update progress separately
      this.db
        .prepare(`UPDATE evolution_runs SET progress = ? WHERE id = ?`)
        .run(JSON.stringify(finalProgress), runId);

      // Return the completed EvolutionRun
      return {
        id: runId,
        skillName,
        status: finalStatus,
        config: engineConfig,
        currentGeneration: evolutionResult.generationsCompleted,
        maxGenerations,
        variants: [evolutionResult.bestVariant],
        bestVariant: evolutionResult.bestVariant,
        progress: finalProgress,
        startedAt: now,
        completedAt,
        errorMessage: evolutionResult.stoppedEarly
          ? `Stopped early: ${evolutionResult.stopReason}`
          : undefined,
      };
    } catch (error) {
      // Mark run as failed
      const errorMessage = error instanceof Error ? error.message : String(error);
      const completedAt = new Date();

      try {
        this.db
          .prepare(
            `UPDATE evolution_runs
               SET status = ?, completed_at = ?, error_message = ?
               WHERE id = ?`
          )
          .run("failed", completedAt.toISOString(), errorMessage, runId);
      } catch {
        // Ignore update failure
      }

      throw error;
    }
  }

  /**
   * Check the status of an evolution run by ID.
   *
   * @param runId - The evolution run ID
   * @returns The EvolutionRun or null if not found
   */
  async getRunStatus(runId: string): Promise<EvolutionRun | null> {
    await this.initialize();
    if (!this.db || !this.getRunStmt) {
      throw new Error("Database not initialized");
    }

    const row = this.getRunStmt.get(runId) as EvolutionRunRow | undefined;
    if (!row) {
      return null;
    }

    return this.rowToEvolutionRun(row);
  }

  /**
   * List all evolution runs, optionally filtered.
   *
   * @param filter - Optional filter by skillName or status
   * @returns Array of EvolutionRun objects
   */
  async listRuns(filter?: {
    skillName?: string;
    status?: string;
  }): Promise<EvolutionRun[]> {
    await this.initialize();
    if (!this.db || !this.listRunsStmt) {
      throw new Error("Database not initialized");
    }

    let rows: EvolutionRunRow[];
    if (filter?.skillName || filter?.status) {
      const stmt = this.db.prepare(`
        SELECT * FROM evolution_runs
        WHERE (? IS NULL OR skill_name = ?)
          AND (? IS NULL OR status = ?)
        ORDER BY started_at DESC
      `);
      rows = stmt.all(filter.skillName ?? null, filter.skillName ?? null, filter.status ?? null, filter.status ?? null) as EvolutionRunRow[];
    } else {
      rows = this.listRunsStmt.all() as EvolutionRunRow[];
    }

    return rows.map((row) => this.rowToEvolutionRun(row));
  }

  /**
   * Apply the best variant from an evolution run back to the skill file.
   *
   * This overwrites the skill's SKILL.md with the best evolved variant.
   * Requires explicit confirm: true in options to prevent accidental overwrites.
   *
   * @param runId - The evolution run ID to apply the best variant from
   * @param confirm - Must be true to confirm the write operation
   * @throws Error if confirm !== true
   */
  async applyBestVariant(runId: string, confirm: boolean = false): Promise<void> {
    if (!confirm) {
      throw new Error(
        `applyBestVariant requires explicit confirm: true to prevent accidental overwrites.\n` +
        `To apply, call:\n` +
        `  optimizer.applyBestVariant("${runId}", true)`
      );
    }

    const run = await this.getRunStatus(runId);
    if (!run) {
      throw new Error(`Evolution run not found: ${runId}`);
    }

    if (!run.bestVariant) {
      throw new Error(`Evolution run ${runId} has no best variant to apply`);
    }

    if (run.status !== "completed") {
      throw new Error(`Cannot apply best variant: run status is "${run.status}", expected "completed"`);
    }

    // Use the stored skillPath from the run record instead of deriving it
    if (!run.skillPath) {
      throw new Error(`Evolution run ${runId} has no stored skillPath`);
    }

    // Write the best variant content to the skill file
    const content = run.bestVariant.content;
    if (!content) {
      throw new Error(`Evolution run ${runId} best variant has no content to apply`);
    }
    writeFileSync(run.skillPath, content, "utf-8");
  }

  /**
   * Mark an evolution run as cancelled.
   *
   * @param runId - The evolution run ID to cancel
   */
  async cancelRun(runId: string): Promise<void> {
    await this.initialize();
    if (!this.db || !this.getRunStmt) {
      throw new Error("Database not initialized");
    }

    const row = this.getRunStmt.get(runId) as EvolutionRunRow | undefined;
    if (!row) {
      throw new Error(`Evolution run not found: ${runId}`);
    }

    if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") {
      throw new Error(`Cannot cancel run with status "${row.status}"`);
    }

    this.db
      .prepare(`UPDATE evolution_runs SET status = ? WHERE id = ?`)
      .run("cancelled", runId);
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Get the database path for evolution runs.
   * Uses config.storage.evolutionLogPath or default.
   */
  private getDbPath(): string {
    return (
      this.config.storage.evolutionLogPath ??
      `${process.env.HOME ?? "."}/.openclaw/evolution/runs.db`
    );
  }

  /**
   * Generate a unique run ID.
   */
  private generateRunId(): string {
    return `run-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Initialize the database connection and create tables if needed.
   * Pattern matches: DatasetManager.initialize() (src/dataset/manager.ts)
   */
  private async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    const dbPath = this.getDbPath();

    try {
      const dir = dirname(dbPath);
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        // Directory may already exist
      }

      this.db = new Database(dbPath);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("synchronous = NORMAL");

      // Create evolution_runs table (matches EvolutionRunRow from src/types.ts)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS evolution_runs (
          id TEXT PRIMARY KEY,
          skill_name TEXT NOT NULL,
          skill_path TEXT,
          status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'paused', 'completed', 'failed', 'cancelled')),
          config TEXT NOT NULL,
          current_generation INTEGER NOT NULL DEFAULT 0,
          max_generations INTEGER NOT NULL,
          best_variant_id TEXT,
          best_variant_content TEXT,
          progress TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          error_message TEXT
        )
      `);

      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_runs_skill_name ON evolution_runs(skill_name);
        CREATE INDEX IF NOT EXISTS idx_runs_status ON evolution_runs(status);
        CREATE INDEX IF NOT EXISTS idx_runs_started_at ON evolution_runs(started_at);
      `);

      // Prepare statements
      this.insertRunStmt = this.db.prepare(`
        INSERT INTO evolution_runs (
          id, skill_name, skill_path, status, config, current_generation, max_generations,
          best_variant_id, best_variant_content, progress, started_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      this.getRunStmt = this.db.prepare(`
        SELECT * FROM evolution_runs WHERE id = ?
      `);

      this.listRunsStmt = this.db.prepare(`
        SELECT * FROM evolution_runs ORDER BY started_at DESC
      `);

      this.isInitialized = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to initialize evolution runs database at ${dbPath}: ${message}`, {
        cause: error,
      });
    }
  }

  /**
   * Convert an EvolutionRunRow database row to an EvolutionRun object.
   * Pattern matches: DatasetManager.rowToManifest() (src/dataset/manager.ts)
   */
  private rowToEvolutionRun(row: EvolutionRunRow): EvolutionRun {
    const config = JSON.parse(row.config) as EvolutionEngineConfig;
    const progress = JSON.parse(row.progress) as EvolutionProgress;

    return {
      id: row.id,
      skillName: row.skill_name,
      skillPath: row.skill_path,
      status: row.status,
      config,
      currentGeneration: row.current_generation,
      maxGenerations: row.max_generations,
      variants: [], // Variants array not persisted — only bestVariant is stored
      bestVariant: row.best_variant_id
        ? {
            id: row.best_variant_id,
            skillName: row.skill_name,
            generation: row.current_generation,
            content: row.best_variant_content ?? "", // Read from best_variant_content column
            mutations: [],
            parents: [],
            createdAt: new Date(row.started_at),
          }
        : undefined,
      progress,
      startedAt: new Date(row.started_at),
      completedAt: row.completed_at ? new Date(row.completed_at) : undefined,
      errorMessage: row.error_message ?? undefined,
    };
  }

  /**
   * Read skill content from a file path.
   */
  private readSkillContent(skillPath: string): string {
    if (!existsSync(skillPath)) {
      throw new Error(`Skill file not found: ${skillPath}`);
    }
    return readFileSync(skillPath, "utf-8");
  }

  /**
   * Extract a brief description from skill content for dataset building.
   * Simple heuristic: look for description in frontmatter or first paragraph.
   */
  private extractSkillDescription(skillContent: string): string {
    // Try to find description in YAML frontmatter
    const frontmatterMatch = skillContent.match(/^---\n([\s\S]*?)\n---/);
    if (frontmatterMatch) {
      const descMatch = frontmatterMatch[1].match(/description:\s*["']?(.+?)["']?\s*$/m);
      if (descMatch) {
        return descMatch[1].trim();
      }
    }

    // Fallback: use first non-empty non-heading line
    const lines = skillContent.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("---")) {
        return trimmed.slice(0, 200);
      }
    }

    return "Skill content for evolution";
  }

  /**
   * Resolve the skill file path for a given skill name.
   * Uses OpenClaw's standard skill directory layout.
   */
  private resolveSkillPath(skillName: string): string {
    const skillsDir = `${process.env.HOME ?? "."}/.openclaw/skills`;
    return join(skillsDir, skillName, "SKILL.md");
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.isInitialized = false;
    this.insertRunStmt = null;
    this.getRunStmt = null;
    this.listRunsStmt = null;
  }
}
