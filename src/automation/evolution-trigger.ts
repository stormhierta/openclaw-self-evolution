/**
 * OpenClaw Self-Evolution Pipeline - Evolution Trigger
 * 
 * Monitors skill performance and decides when to trigger evolution.
 * Part of P3-A: Self-triggered evolution.
 */

import type { EvolutionConfig, SkillCreationRecommendation } from "../types.js";
import Database from "better-sqlite3";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { TaskPatternDetector } from "../collection/task-pattern-detector.js";

// ============================================================================
// Types
// ============================================================================

export interface SkillPerformanceStats {
  skillName: string;
  totalTurns: number;
  successRate: number; // 0-1 from reward signals
  avgRewardSignal: number;
  lastEvaluated: Date;
  turnsInWindow: number; // turns in the last evaluation window
}

export interface TriggerDecision {
  shouldEvolve: boolean;
  skillName: string;
  reason: string;
  urgency: "low" | "medium" | "high";
  currentPerformance: SkillPerformanceStats;
}

interface WindowStats {
  avgReward: number;
  turnCount: number;
}

/** Result of checking all skills including pattern-based recommendations */
export interface EvolutionTriggerResult {
  triggers: TriggerDecision[];
  skillCreationRecommendations: SkillCreationRecommendation[];
}

// ============================================================================
// EvolutionTrigger Class
// ============================================================================

export class EvolutionTrigger {
  private config: EvolutionConfig;
  private db: Database.Database | null = null;
  private isInitialized = false;

  // Trigger criteria thresholds
  private readonly SUCCESS_RATE_THRESHOLD = 0.6;
  private readonly LONG_TERM_SUCCESS_THRESHOLD = 0.7;
  private readonly MIN_TURNS_FOR_TRIGGER = 20;
  private readonly LONG_TERM_MIN_TURNS = 50;
  private readonly WINDOW_SIZE = 10;

  constructor(config: EvolutionConfig) {
    this.config = config;
  }

  /**
   * Get the database path from config or use default.
   */
  private getDbPath(): string {
    return (
      this.config.storage.trajectoryDbPath ??
      `${process.env.HOME ?? "."}/.openclaw/evolution/trajectories.db`
    );
  }

  /**
   * Initialize the database connection.
   */
  private async initialize(): Promise<void> {
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

      // Open database with better-sqlite3 (synchronous API)
      this.db = new Database(dbPath);

      // Enable WAL mode for better concurrency
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("synchronous = NORMAL");

      this.isInitialized = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to initialize trajectory database at ${dbPath}: ${message}`,
        { cause: error }
      );
    }
  }

  /**
   * Ensure database is initialized.
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }
  }

  /**
   * Get performance stats for a skill from trajectory DB.
   * Queries the evolution_turns table for turns targeting this skill.
   */
  async getSkillPerformance(
    skillName: string,
    windowDays = 7
  ): Promise<SkillPerformanceStats | null> {
    await this.ensureInitialized();

    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - windowDays);
    const cutoffIso = cutoffDate.toISOString();

    // Query turns for this skill within the time window
    const query = `
      SELECT 
        COUNT(*) as total_turns,
        AVG(CASE WHEN outcome_type = 'success' THEN 1.0 
                 WHEN outcome_type = 'partial' THEN 0.5 
                 ELSE 0.0 END) as success_rate,
        AVG(reward_signal) as avg_reward,
        MAX(timestamp) as last_turn
      FROM evolution_turns
      WHERE target_skill = ? AND timestamp >= ?
    `;

    const stmt = this.db.prepare(query);
    const row = stmt.get(skillName, cutoffIso) as {
      total_turns: number;
      success_rate: number | null;
      avg_reward: number | null;
      last_turn: string | null;
    } | undefined;

    if (!row || row.total_turns === 0) {
      return null;
    }

    return {
      skillName,
      totalTurns: row.total_turns,
      successRate: row.success_rate ?? 0,
      avgRewardSignal: row.avg_reward ?? 0.5,
      lastEvaluated: row.last_turn ? new Date(row.last_turn) : new Date(),
      turnsInWindow: row.total_turns,
    };
  }

  /**
   * Get windowed stats for detecting declining reward trends.
   * Returns stats for consecutive windows of turns.
   */
  private getWindowedStats(
    skillName: string,
    windowSize: number
  ): WindowStats[] | null {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    // Get recent turns ordered by timestamp (most recent first)
    const query = `
      SELECT reward_signal, outcome_type
      FROM evolution_turns
      WHERE target_skill = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `;

    const stmt = this.db.prepare(query);
    const rows = stmt.all(skillName, windowSize * 2) as Array<{
      reward_signal: number | null;
      outcome_type: "success" | "failure" | "partial" | "error";
    }>;

    if (rows.length < windowSize) {
      return null;
    }

    // Calculate stats for two consecutive windows
    const windows: WindowStats[] = [];

    for (let i = 0; i < 2 && rows.length >= (i + 1) * windowSize; i++) {
      const startIdx = i * windowSize;
      const endIdx = Math.min(startIdx + windowSize, rows.length);
      const windowRows = rows.slice(startIdx, endIdx);

      const avgReward =
        windowRows.reduce((sum, r) => {
          // Use reward_signal if available, otherwise derive from outcome_type
          if (r.reward_signal !== null && r.reward_signal !== undefined) {
            return sum + r.reward_signal;
          }
          // Fallback: success=1, partial=0.5, failure/error=0
          const fallbackReward =
            r.outcome_type === "success"
              ? 1.0
              : r.outcome_type === "partial"
                ? 0.5
                : 0.0;
          return sum + fallbackReward;
        }, 0) / windowRows.length;

      windows.push({
        avgReward,
        turnCount: windowRows.length,
      });
    }

    return windows.length > 0 ? windows : null;
  }

  /**
   * Check if a specific skill should be evolved based on recent trajectories.
   * 
   * Trigger criteria:
   * 1. Success rate < 0.6 over last 20+ turns
   * 2. Average reward signal declining over two consecutive 10-turn windows
   * 3. Any skill with > 50 turns and < 0.7 success rate (long-term underperformer)
   */
  async checkSkill(skillName: string): Promise<TriggerDecision> {
    await this.ensureInitialized();

    const performance = await this.getSkillPerformance(skillName);

    // Default decision: don't evolve
    const defaultDecision: TriggerDecision = {
      shouldEvolve: false,
      skillName,
      reason: "No performance data available for this skill",
      urgency: "low",
      currentPerformance: {
        skillName,
        totalTurns: 0,
        successRate: 0,
        avgRewardSignal: 0,
        lastEvaluated: new Date(),
        turnsInWindow: 0,
      },
    };

    if (!performance || performance.totalTurns === 0) {
      return defaultDecision;
    }

    // Check trigger criteria
    let shouldEvolve = false;
    let reason = "";
    let urgency: "low" | "medium" | "high" = "low";

    // Criterion 1: Success rate < 0.6 over last 20+ turns
    if (
      performance.totalTurns >= this.MIN_TURNS_FOR_TRIGGER &&
      performance.successRate < this.SUCCESS_RATE_THRESHOLD
    ) {
      shouldEvolve = true;
      reason = `Success rate (${(performance.successRate * 100).toFixed(1)}%) below threshold (${(this.SUCCESS_RATE_THRESHOLD * 100).toFixed(0)}%) over ${performance.totalTurns} turns`;
      urgency = performance.successRate < 0.4 ? "high" : "medium";
    }

    // Criterion 2: Declining reward signal over two consecutive windows
    const windowedStats = this.getWindowedStats(skillName, this.WINDOW_SIZE);
    if (
      !shouldEvolve &&
      windowedStats &&
      windowedStats.length >= 2 &&
      windowedStats[0].turnCount >= this.WINDOW_SIZE &&
      windowedStats[1].turnCount >= this.WINDOW_SIZE
    ) {
      const recentAvg = windowedStats[0].avgReward;
      const previousAvg = windowedStats[1].avgReward;
      const decline = previousAvg - recentAvg;

      // Decline of more than 0.15 (15%) is significant
      if (decline > 0.15) {
        shouldEvolve = true;
        reason = `Reward signal declining over two consecutive ${this.WINDOW_SIZE}-turn windows (from ${previousAvg.toFixed(2)} to ${recentAvg.toFixed(2)})`;
        urgency = decline > 0.3 ? "high" : "medium";
      }
    }

    // Criterion 3: Long-term underperformer (> 50 turns, < 0.7 success rate)
    // Use a longer window (90 days) for "long-term" check
    const longTermStats = await this.getSkillPerformance(skillName, 90);
    if (
      !shouldEvolve &&
      longTermStats &&
      longTermStats.totalTurns >= this.LONG_TERM_MIN_TURNS &&
      longTermStats.successRate < this.LONG_TERM_SUCCESS_THRESHOLD
    ) {
      shouldEvolve = true;
      reason = `Long-term underperformer: ${longTermStats.totalTurns} turns with ${(longTermStats.successRate * 100).toFixed(1)}% success rate (threshold: ${(this.LONG_TERM_SUCCESS_THRESHOLD * 100).toFixed(0)}%)`;
      urgency = "medium";
    }

    // If no trigger criteria met, provide a positive status reason
    if (!shouldEvolve) {
      reason = `Performance acceptable: ${(performance.successRate * 100).toFixed(1)}% success rate over ${performance.totalTurns} turns`;
    }

    return {
      shouldEvolve,
      skillName,
      reason,
      urgency,
      currentPerformance: performance,
    };
  }

  /**
   * Get all skills that have trajectory data.
   */
  private getTrackedSkills(): string[] {
    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const query = `
      SELECT DISTINCT target_skill
      FROM evolution_turns
      WHERE target_skill IS NOT NULL
    `;

    const stmt = this.db.prepare(query);
    const rows = stmt.all() as Array<{ target_skill: string }>;

    return rows.map((r) => r.target_skill);
  }

  /**
   * Check all tracked skills, return those needing evolution.
   * Also includes skill creation recommendations for recurring patterns
   * that don't have a corresponding skill.
   */
  async checkAllSkills(): Promise<EvolutionTriggerResult> {
    await this.ensureInitialized();

    if (!this.db) {
      throw new Error("Database not initialized");
    }

    // Check existing skills for evolution triggers
    const skills = this.getTrackedSkills();
    const decisions: TriggerDecision[] = [];

    for (const skillName of skills) {
      const decision = await this.checkSkill(skillName);
      if (decision.shouldEvolve) {
        decisions.push(decision);
      }
    }

    // Sort by urgency (high -> medium -> low)
    const urgencyOrder = { high: 0, medium: 1, low: 2 };
    decisions.sort(
      (a, b) => urgencyOrder[a.urgency] - urgencyOrder[b.urgency]
    );

    // Check for patterns that suggest new skill creation
    const patternDetector = new TaskPatternDetector(this.db);
    const skillCreationRecommendations = patternDetector.analyze();

    return {
      triggers: decisions,
      skillCreationRecommendations,
    };
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
  }
}
