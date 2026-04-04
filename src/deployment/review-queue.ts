/**
 * OpenClaw Self-Evolution Pipeline - Review Queue
 *
 * Phase 7D: Human-in-the-loop approval workflow for evolved skill variants.
 *
 * Consumes the SQLite database managed by PrBuilder (Phase 7C) to:
 * - List pending PRs (from evolution runs awaiting human review)
 * - Approve PRs (marks approved in DB; caller applies the change)
 * - Reject PRs (marks rejected in DB + deletes the git branch)
 * - Track review history and queue statistics
 *
 * The approval/rejection itself does NOT apply the variant — that is the
 * caller's responsibility (e.g. a deployment orchestrator that watches for
 * approved PRs and merges them).
 */

import Database from "better-sqlite3";

import type {
  EvolutionConfig,
  PrRecord,
  ReviewQueueItem,
} from "../types.js";
import type { GitManager } from "./git-manager.js";
import type { PrBuilder } from "./pr-builder.js";

/**
 * ReviewQueue manages the human review workflow for evolved skill variants.
 *
 * It shares the same SQLite database as PrBuilder (prs.db), adding only
 * a priority column to the pr_records table during initialize().
 */
export class ReviewQueue {
  private db: Database.Database | null = null;

  constructor(
    private readonly config: EvolutionConfig,
    private readonly prBuilder: PrBuilder,
    private readonly gitManager: GitManager
  ) {}

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  /**
   * Initialize the review queue.
   *
   * Ensures the PR database is ready (delegates to PrBuilder.initialize)
   * and adds the priority column to pr_records if it doesn't exist.
   */
  async initialize(): Promise<void> {
    // Ensure PrBuilder's DB is initialized
    await this.prBuilder.initialize();

    // Reuse PrBuilder's DB connection to avoid double-connecting to the same file
    this.db = this.prBuilder.getDb();

    // WAL mode is already set by PrBuilder — do not re-apply

    // Add priority column if it doesn't already exist (SQLite doesn't support
    // IF NOT EXISTS for columns, so check first with PRAGMA table_info)
    const columns = this.db
      .prepare("PRAGMA table_info(pr_records)")
      .all() as Array<{ name: string }>;
    const hasPriority = columns.some((c) => c.name === "priority");
    if (!hasPriority) {
      this.db.exec(
        "ALTER TABLE pr_records ADD COLUMN priority INTEGER NOT NULL DEFAULT 0"
      );
    }
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
    priority: number;
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

  private rowToReviewQueueItem(row: {
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
    priority: number;
  }): ReviewQueueItem {
    return {
      pr: this.rowToPrRecord(row),
      queuedAt: row.created_at,
      priority: row.priority,
    };
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Get all pending PRs in the queue, ordered by priority (desc) then
   * created_at (asc — oldest first).
   */
  async getPending(): Promise<ReviewQueueItem[]> {
    if (!this.db) {
      throw new Error("ReviewQueue not initialized");
    }

    const stmt = this.db.prepare(`
      SELECT
        id, skill_name, run_id, branch_name, commit_sha, pushed,
        title, body, status, created_at, reviewed_at, review_note, priority
      FROM pr_records
      WHERE status = 'pending'
      ORDER BY priority DESC, created_at ASC
    `);

    const rows = stmt.all() as Array<{
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
      priority: number;
    }>;

    return rows.map((row) => this.rowToReviewQueueItem(row));
  }

  /**
   * Approve a PR — marks it as approved in the database.
   *
   * Note: This does NOT apply the variant. The caller is responsible for
   * watching approved PRs and merging/applying them.
   */
  async approve(prId: string, reviewNote?: string): Promise<PrRecord> {
    // Get the PR first
    const existing = await this.prBuilder.getPr(prId);
    if (!existing) throw new Error(`PR not found: ${prId}`);
    if (existing.status !== "pending") {
      throw new Error(`Cannot approve PR ${prId}: status is "${existing.status}", expected "pending"`);
    }
    await this.prBuilder.updatePrStatus(prId, "approved", reviewNote);
    const updated = await this.prBuilder.getPr(prId);
    if (!updated) {
      throw new Error(`PR not found after approval: ${prId}`);
    }
    return updated;
  }

  /**
   * Reject a PR — marks it as rejected in the database and deletes the
   * corresponding git branch via GitManager.
   */
  async reject(prId: string, reviewNote?: string): Promise<PrRecord> {
    // Get the PR to find the branch name
    const pr = await this.prBuilder.getPr(prId);
    if (!pr) {
      throw new Error(`PR not found: ${prId}`);
    }
    if (pr.status !== "pending") {
      throw new Error(`Cannot reject PR ${prId}: status is "${pr.status}", expected "pending"`);
    }

    // Update status in DB
    await this.prBuilder.updatePrStatus(prId, "rejected", reviewNote);

    // Delete the branch
    try {
      await this.gitManager.deleteBranch(pr.branchName);
    } catch (err) {
      // Log but don't fail — PR is already marked rejected
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[ReviewQueue] Failed to delete branch ${pr.branchName} for rejected PR ${prId}: ${msg}`
      );
    }

    // Return the updated record
    const updated = await this.prBuilder.getPr(prId);
    if (!updated) {
      throw new Error(`PR not found after rejection: ${prId}`);
    }
    return updated;
  }

  /**
   * Get queue statistics: number of pending PRs and age of the oldest one.
   */
  async getStats(): Promise<{ pendingCount: number; oldestPendingAgeMs: number | null }> {
    if (!this.db) {
      throw new Error("ReviewQueue not initialized");
    }

    const stmt = this.db.prepare(`
      SELECT
        COUNT(*) as pending_count,
        MIN(created_at) as oldest_created_at
      FROM pr_records
      WHERE status = 'pending'
    `);

    const row = stmt.get() as { pending_count: number; oldest_created_at: string | null };

    let oldestPendingAgeMs: number | null = null;
    if (row.oldest_created_at) {
      oldestPendingAgeMs = Date.now() - new Date(row.oldest_created_at).getTime();
    }

    return {
      pendingCount: row.pending_count,
      oldestPendingAgeMs,
    };
  }

  /**
   * Get full review history — all PRs regardless of status, ordered by
   * created_at DESC (latest first).
   */
  async getHistory(limit?: number): Promise<PrRecord[]> {
    if (!this.db) {
      throw new Error("ReviewQueue not initialized");
    }

    const sqlLimit = limit ?? 100;

    const rows = this.db
      .prepare(
        `
        SELECT
          id, skill_name, run_id, branch_name, commit_sha, pushed,
          title, body, status, created_at, reviewed_at, review_note, priority
        FROM pr_records
        ORDER BY created_at DESC
        LIMIT ?
      `
      )
      .all(sqlLimit) as Array<{
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
      priority: number;
    }>;

    return rows.map((row) => this.rowToPrRecord(row));
  }

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  /**
   * Discard the DB reference. Does NOT close the connection — PrBuilder owns it.
   */
  close(): void {
    this.db = null;
  }
}
