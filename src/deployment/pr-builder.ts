/**
 * OpenClaw Self-Evolution Pipeline - PR Builder
 *
 * Phase 7C: Orchestrates the full PR creation flow for evolution variants.
 *
 * Given a completed evolution run with a best variant, it:
 * 1. Uses GitManager to create a branch + commit the variant
 * 2. Uses MetricsReporter to generate the PR description
 * 3. Stores the PR record in SQLite for the review queue (Phase 7D)
 * 4. Returns a PrRecord with all the info
 *
 * Since we're not integrating with GitHub/GitLab API (local plugin),
 * the PR "creation" is purely local: branch + commit + SQLite record.
 */

import Database from "better-sqlite3";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";

import type {
  EvolutionConfig,
  EvolutionRun,
  PrRecord,
} from "../types.js";
import type { GitManager } from "./git-manager.js";
import type { MetricsReporter } from "./metrics-reporter.js";

/**
 * PR Builder for Evolution Variants
 *
 * Orchestrates branch creation, commit, and PR record persistence.
 * Uses SQLite for PR record storage (consumed by Phase 7D review queue).
 */
export class PrBuilder {
  private db: Database.Database | null = null;
  private isInitialized = false;

  // Prepared statements
  private insertPrStmt: Database.Statement | null = null;
  private getPrStmt: Database.Statement | null = null;
  private listPrsStmt: Database.Statement | null = null;
  private listPrsSkillStatusStmt: Database.Statement | null = null;
  private listPrsSkillOnlyStmt: Database.Statement | null = null;
  private listPrsStatusOnlyStmt: Database.Statement | null = null;
  private updatePrStatusStmt: Database.Statement | null = null;

  constructor(
    private readonly config: EvolutionConfig,
    private readonly gitManager: GitManager,
    private readonly metricsReporter: MetricsReporter
  ) {}

  // -------------------------------------------------------------------------
  // Path helpers
  // -------------------------------------------------------------------------

  /**
   * Get the base evolution storage path from config or use default.
   */
  private getEvolutionBasePath(): string {
    return (
      this.config.storage.evolutionLogPath ??
      `${homedir()}/.openclaw/evolution/`
    );
  }

  /**
   * Get the PR database file path.
   * Sibling to evolutionLogPath: <evolutionLogPath>/../evolution-prs.db
   * Or default: ~/.openclaw/evolution/prs.db
   */
  /** Get the database instance. Exposed for ReviewQueue (Phase 7D) to share the connection. */
  getDb(): Database.Database {
    if (!this.db) {
      throw new Error("Database not initialized");
    }
    return this.db;
  }

  /** Get the PR database file path. Exposed for ReviewQueue (Phase 7D). */
  getDbPath(): string {
    const base = this.getEvolutionBasePath();
    // If evolutionLogPath is a file path (e.g. "evolution.db"), use sibling "evolution-prs.db"
    // Otherwise treat as a directory and append "prs.db"
    if (base.endsWith(".db")) {
      return base.replace(/\.db$/, "-prs.db");
    }
    return join(base, "prs.db");
  }

  // -------------------------------------------------------------------------
  // DB initialization
  // -------------------------------------------------------------------------

  /**
   * Initialize the SQLite database for PR records.
   * Creates tables and prepares statements.
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    const dbPath = this.getDbPath();

    try {
      // Ensure directory exists
      const dir = dirname(dbPath);
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        // Directory may already exist
      }

      // Open database
      this.db = new Database(dbPath);

      // Enable WAL mode for better concurrency
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("synchronous = NORMAL");

      // Create pr_records table
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS pr_records (
          id TEXT PRIMARY KEY,
          skill_name TEXT NOT NULL,
          run_id TEXT NOT NULL,
          branch_name TEXT NOT NULL,
          commit_sha TEXT NOT NULL,
          pushed INTEGER NOT NULL DEFAULT 0,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'rejected', 'merged')),
          created_at TEXT NOT NULL,
          reviewed_at TEXT,
          review_note TEXT
        )
      `);

      // Create indexes
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_pr_records_skill_name ON pr_records(skill_name);
        CREATE INDEX IF NOT EXISTS idx_pr_records_status ON pr_records(status);
        CREATE INDEX IF NOT EXISTS idx_pr_records_run_id ON pr_records(run_id);
        CREATE INDEX IF NOT EXISTS idx_pr_records_created_at ON pr_records(created_at);
      `);

      // Prepare statements
      this.insertPrStmt = this.db.prepare(`
        INSERT INTO pr_records (
          id, skill_name, run_id, branch_name, commit_sha, pushed,
          title, body, status, created_at, reviewed_at, review_note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      this.getPrStmt = this.db.prepare(`
        SELECT
          id, skill_name, run_id, branch_name, commit_sha, pushed,
          title, body, status, created_at, reviewed_at, review_note
        FROM pr_records
        WHERE id = ?
      `);

      this.listPrsStmt = this.db.prepare(`
        SELECT
          id, skill_name, run_id, branch_name, commit_sha, pushed,
          title, body, status, created_at, reviewed_at, review_note
        FROM pr_records
        ORDER BY created_at DESC
      `);

      // Filtered list (skillName OR status)
      this.listPrsSkillStatusStmt = this.db.prepare(`
        SELECT
          id, skill_name, run_id, branch_name, commit_sha, pushed,
          title, body, status, created_at, reviewed_at, review_note
        FROM pr_records
        WHERE skill_name = ? AND status = ?
        ORDER BY created_at DESC
      `);

      // Skill name only
      this.listPrsSkillOnlyStmt = this.db.prepare(`
        SELECT
          id, skill_name, run_id, branch_name, commit_sha, pushed,
          title, body, status, created_at, reviewed_at, review_note
        FROM pr_records
        WHERE skill_name = ?
        ORDER BY created_at DESC
      `);

      // Status only
      this.listPrsStatusOnlyStmt = this.db.prepare(`
        SELECT
          id, skill_name, run_id, branch_name, commit_sha, pushed,
          title, body, status, created_at, reviewed_at, review_note
        FROM pr_records
        WHERE status = ?
        ORDER BY created_at DESC
      `);

      this.updatePrStatusStmt = this.db.prepare(`
        UPDATE pr_records
        SET status = ?, reviewed_at = ?, review_note = ?
        WHERE id = ?
      `);

      this.isInitialized = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to initialize PR database at ${dbPath}: ${message}`,
        { cause: error }
      );
    }
  }

  // -------------------------------------------------------------------------
  // ID generation
  // -------------------------------------------------------------------------

  private generateId(): string {
    return `pr-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  // -------------------------------------------------------------------------
  // Row conversion
  // -------------------------------------------------------------------------

  private rowToPrRecord(row: {
    id: string;
    skill_name: string;
    run_id: string;
    branch_name: string;
    commit_sha: string;
    pushed: number;
    title: string;
    body: string;
    status: "pending" | "approved" | "rejected" | "merged";
    created_at: string;
    reviewed_at: string | null;
    review_note: string | null;
  }): PrRecord {
    return {
      id: row.id,
      skillName: row.skill_name,
      runId: row.run_id,
      branchName: row.branch_name,
      commitSha: row.commit_sha,
      pushed: row.pushed === 1,
      title: row.title,
      body: row.body,
      status: row.status,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at ?? undefined,
      reviewNote: row.review_note ?? undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Build a PR from a completed evolution run.
   *
   * 1. Extract metrics via MetricsReporter
   * 2. Generate PR title and body
   * 3. Create branch + commit via GitManager
   * 4. Insert PR record to SQLite
   * 5. Return the PrRecord
   */
  async buildPr(
    run: EvolutionRun,
    variantContent: string,
    baselineFitnessScore?: number
  ): Promise<PrRecord> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.db || !this.insertPrStmt) {
      throw new Error("Database not initialized");
    }

    if (run.status !== "completed") {
      throw new Error(`Cannot build PR: evolution run ${run.id} status is "${run.status}", expected "completed"`);
    }
    if (!run.bestVariant) {
      throw new Error(`Cannot build PR: evolution run ${run.id} has no best variant`);
    }

    // 1. Extract metrics
    const metrics = this.metricsReporter.extractMetrics(
      run,
      baselineFitnessScore
    );

    // 2. Generate PR title
    const title = `feat(evolution): evolve ${run.skillName} — ${metrics.improvementPercent} improvement`;

    // 3. Generate PR body
    const metricsMarkdown = this.metricsReporter.formatMarkdown(metrics);
    const variantDiffNote = `\n\n---\n\n**Variant content** has been committed to branch \`evolution/${run.skillName}/${run.id}\`. Review the diff in the skill's SKILL.md file.`;
    const body = metricsMarkdown + variantDiffNote;

    // 4. Apply variant to branch via GitManager
    const branchResult = await this.gitManager.applyVariantToBranch(
      run.skillName,
      run.id,
      variantContent
    );

    // 5. Insert PR record
    const id = this.generateId();
    const now = new Date().toISOString();

    try {
      const transaction = this.db.transaction(() => {
        this.insertPrStmt!.run(
          id,
          run.skillName,
          run.id,
          branchResult.branchName,
          branchResult.commitSha,
          branchResult.pushed ? 1 : 0,
          title,
          body,
          "pending",
          now,
          null,
          null
        );
      });

      transaction();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Attempt branch cleanup to avoid orphaned branches
      try {
        await this.gitManager.deleteBranch(branchResult.branchName);
      } catch {
        // Ignore cleanup failure — log it but don't mask the original error
      }
      throw new Error(`Failed to insert PR record: ${message}`, {
        cause: error,
      });
    }

    // 6. Return the PrRecord
    return {
      id,
      skillName: run.skillName,
      runId: run.id,
      branchName: branchResult.branchName,
      commitSha: branchResult.commitSha,
      pushed: branchResult.pushed,
      title,
      body,
      status: "pending",
      createdAt: now,
    };
  }

  /**
   * Get a PR record by ID.
   */
  async getPr(prId: string): Promise<PrRecord | null> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.db || !this.getPrStmt) {
      throw new Error("Database not initialized");
    }

    const row = this.getPrStmt.get(prId) as
      | {
          id: string;
          skill_name: string;
          run_id: string;
          branch_name: string;
          commit_sha: string;
          pushed: number;
          title: string;
          body: string;
          status: "pending" | "approved" | "rejected" | "merged";
          created_at: string;
          reviewed_at: string | null;
          review_note: string | null;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return this.rowToPrRecord(row);
  }

  /**
   * List PR records, optionally filtered by skillName and/or status.
   */
  async listPrs(
    filter?: { skillName?: string; status?: PrRecord["status"] }
  ): Promise<PrRecord[]> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.db) {
      throw new Error("Database not initialized");
    }

    let rows: {
      id: string;
      skill_name: string;
      run_id: string;
      branch_name: string;
      commit_sha: string;
      pushed: number;
      title: string;
      body: string;
      status: "pending" | "approved" | "rejected" | "merged";
      created_at: string;
      reviewed_at: string | null;
      review_note: string | null;
    }[];

    if (filter?.skillName && filter?.status) {
      // Both filters
      rows = (this.listPrsSkillStatusStmt!.all(
        filter.skillName,
        filter.status
      ) as typeof rows);
    } else if (filter?.skillName) {
      // Skill name only
      rows = (this.listPrsSkillOnlyStmt!.all(filter.skillName) as typeof rows);
    } else if (filter?.status) {
      // Status only
      rows = (this.listPrsStatusOnlyStmt!.all(filter.status) as typeof rows);
    } else {
      // No filter
      rows = this.listPrsStmt!.all() as typeof rows;
    }

    return rows.map((row) => this.rowToPrRecord(row));
  }

  /**
   * Update PR status (for review queue).
   */
  async updatePrStatus(
    prId: string,
    status: PrRecord["status"],
    reviewNote?: string
  ): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.db || !this.updatePrStatusStmt) {
      throw new Error("Database not initialized");
    }

    const now = new Date().toISOString();

    try {
      const transaction = this.db.transaction(() => {
        const result = this.updatePrStatusStmt!.run(
          status,
          now,
          reviewNote ?? null,
          prId
        );

        if (result.changes === 0) {
          throw new Error(`PR record not found: ${prId}`);
        }
      });

      transaction();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to update PR status: ${message}`, {
        cause: error,
      });
    }
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
    this.insertPrStmt = null;
    this.getPrStmt = null;
    this.listPrsStmt = null;
    this.listPrsSkillStatusStmt = null;
    this.listPrsSkillOnlyStmt = null;
    this.listPrsStatusOnlyStmt = null;
    this.updatePrStatusStmt = null;
  }
}
