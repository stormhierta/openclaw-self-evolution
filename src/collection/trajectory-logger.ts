/**
 * OpenClaw Self-Evolution Pipeline - Trajectory Logger
 * 
 * Persists trajectory data from the in-memory buffer to SQLite.
 * 
 * Design decisions based on:
 * - OpenClaw SQLite patterns: /home/stormhierta/.npm-global/lib/node_modules/openclaw/dist/memory-core-host-engine-storage-Dlg-rajS.js
 * - better-sqlite3 synchronous API (already in dependencies)
 * - TurnRecordRow, EpisodeRecordRow types from src/types.ts
 * 
 * Tables: evolution_turns, evolution_episodes
 * Columns match the row types in src/types.ts exactly.
 */

import Database from "better-sqlite3";
import type { EvolutionConfig, TurnRecordRow, EpisodeRecordRow, TrajectoryFilter } from "../types.js";
import type { TrajectoryHookHandler } from "../hooks/trajectory-hooks.js";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * TrajectoryLogger persists trajectory data from the in-memory buffer to SQLite.
 * 
 * Design: Manages its own SQLite database at config.storage.trajectoryDbPath
 * Source: SQLite patterns from memory-core-host-engine-storage-Dlg-rajS.js
 * 
 * Does NOT import from trajectory-hooks.ts directly — accepts handler via constructor.
 */
export class TrajectoryLogger {
  private config: EvolutionConfig;
  private handler: TrajectoryHookHandler;
  private db: Database.Database | null = null;
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private isInitialized = false;

  // Prepared statements for performance
  private insertTurnStmt: Database.Statement | null = null;
  private insertEpisodeStmt: Database.Statement | null = null;
  private queryTurnsStmt: Database.Statement | null = null;

  constructor(config: EvolutionConfig, handler: TrajectoryHookHandler) {
    this.config = config;
    this.handler = handler;
  }

  /**
   * Get the database path from config or use default.
   */
  private getDbPath(): string {
    return this.config.storage.trajectoryDbPath ?? 
           `${process.env.HOME ?? "."}/.openclaw/evolution/trajectories.db`;
  }

  /**
   * Initialize the database connection and create tables if they don't exist.
   * 
   * Schema matches TurnRecordRow and EpisodeRecordRow from src/types.ts.
   * Source: Table creation pattern from memory-core-host-engine-storage-Dlg-rajS.js
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

      // Open database with better-sqlite3 (synchronous API)
      this.db = new Database(dbPath);
      
      // Enable WAL mode for better concurrency
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("synchronous = NORMAL");

      // Create evolution_turns table (matches TurnRecordRow type)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS evolution_turns (
          id TEXT PRIMARY KEY,
          session_key TEXT NOT NULL,
          turn_number INTEGER NOT NULL,
          episode_id TEXT NOT NULL,
          timestamp TEXT NOT NULL,
          system_prompt TEXT,
          user_message TEXT NOT NULL,
          context_json TEXT,
          action_type TEXT NOT NULL CHECK(action_type IN ('tool_call', 'response', 'error', 'subagent_spawn')),
          action_json TEXT NOT NULL,
          outcome_type TEXT NOT NULL CHECK(outcome_type IN ('success', 'failure', 'partial', 'error')),
          outcome_json TEXT NOT NULL,
          reward_signal REAL,
          skills_used TEXT NOT NULL,
          target_skill TEXT
        )
      `);

      // Create indexes for common queries
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_turns_session_key ON evolution_turns(session_key);
        CREATE INDEX IF NOT EXISTS idx_turns_episode_id ON evolution_turns(episode_id);
        CREATE INDEX IF NOT EXISTS idx_turns_timestamp ON evolution_turns(timestamp);
        CREATE INDEX IF NOT EXISTS idx_turns_target_skill ON evolution_turns(target_skill);
        CREATE INDEX IF NOT EXISTS idx_turns_outcome_type ON evolution_turns(outcome_type);
      `);

      // Create evolution_episodes table (matches EpisodeRecordRow type)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS evolution_episodes (
          id TEXT PRIMARY KEY,
          session_key TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure', 'partial')),
          skills_involved TEXT NOT NULL,
          total_reward REAL NOT NULL DEFAULT 0
        )
      `);

      // Create indexes for episodes
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_episodes_session_key ON evolution_episodes(session_key);
        CREATE INDEX IF NOT EXISTS idx_episodes_started_at ON evolution_episodes(started_at);
        CREATE INDEX IF NOT EXISTS idx_episodes_outcome ON evolution_episodes(outcome);
      `);

      // Prepare statements for better performance
      this.insertTurnStmt = this.db.prepare(`
        INSERT OR REPLACE INTO evolution_turns (
          id, session_key, turn_number, episode_id, timestamp,
          system_prompt, user_message, context_json, action_type, action_json,
          outcome_type, outcome_json, reward_signal, skills_used, target_skill
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      this.insertEpisodeStmt = this.db.prepare(`
        INSERT OR REPLACE INTO evolution_episodes (
          id, session_key, started_at, completed_at, outcome,
          skills_involved, total_reward
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      this.isInitialized = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to initialize trajectory database at ${dbPath}: ${message}`, { cause: error });
    }
  }

  /**
   * Flush buffered trajectory data to SQLite.
   * 
   * Drains buffer from hook handler, writes to SQLite, returns count written.
   * Uses prepared statements for efficiency.
   * 
   * @returns Number of records written
   */
  async flush(): Promise<number> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.db || !this.insertTurnStmt || !this.insertEpisodeStmt) {
      throw new Error("Database not initialized");
    }

    // FIX 3: Get finalized turns (not in-progress buffer)
    const turns = this.handler.getFinalizedTurns();
    const episodes = this.handler.getCompletedEpisodes();

    if (turns.length === 0 && episodes.length === 0) {
      return 0;
    }

    let writtenCount = 0;

    // FIX 5: Use a transaction for atomicity - any error rolls back all changes
    const transaction = this.db.transaction(() => {
      // Insert turns
      for (const turn of turns) {
        this.insertTurnStmt!.run(
          turn.id,
          turn.session_key,
          turn.turn_number,
          turn.episode_id,
          turn.timestamp,
          turn.system_prompt ?? null,
          turn.user_message,
          turn.context_json ?? null,
          turn.action_type,
          turn.action_json,
          turn.outcome_type,
          turn.outcome_json,
          turn.reward_signal ?? null,
          turn.skills_used,
          turn.target_skill ?? null
        );
        writtenCount++;
      }

      // Insert episodes
      for (const episode of episodes) {
        this.insertEpisodeStmt!.run(
          episode.id,
          episode.session_key,
          episode.started_at,
          episode.completed_at ?? null,
          episode.outcome,
          episode.skills_involved,
          episode.total_reward
        );
        writtenCount++;
      }
    });

    try {
      transaction();
      
      // FIX 5: Only clear buffers AFTER successful transaction commit
      this.handler.clearFinalizedTurns();
      this.handler.clearCompletedEpisodes();
    } catch (error) {
      console.error("[trajectory-logger] Transaction failed:", error);
      // FIX 5: Buffers are NOT cleared - data is preserved for next flush attempt
      throw error;
    }

    return writtenCount;
  }

  /**
   * Start periodic background flush.
   * 
   * @param intervalMs - Flush interval in milliseconds (default: 60000 = 1 minute)
   */
  startPeriodicFlush(intervalMs = 60000): void {
    if (this.flushInterval) {
      // Already running
      return;
    }

    this.flushInterval = setInterval(async () => {
      try {
        const count = await this.flush();
        if (count > 0) {
          console.log(`[trajectory-logger] Periodic flush: ${count} records written`);
        }
      } catch (error) {
        console.error("[trajectory-logger] Periodic flush failed:", error);
      }
    }, intervalMs);

    // Ensure the interval doesn't prevent process exit
    if (this.flushInterval.unref) {
      this.flushInterval.unref();
    }
  }

  /**
   * Stop periodic background flush.
   */
  stopPeriodicFlush(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
  }

  /**
   * Query trajectory data with optional filtering.
   * 
   * @param filter - Optional filter criteria
   * @returns Array of turn records matching the filter
   */
  async query(filter: TrajectoryFilter = {}): Promise<TurnRecordRow[]> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.db) {
      throw new Error("Database not initialized");
    }

    // Build query dynamically based on filter
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filter.skillName) {
      conditions.push("(target_skill = ? OR skills_used LIKE ?)");
      params.push(filter.skillName, `%${filter.skillName}%`);
    }

    if (filter.sessionKey) {
      conditions.push("session_key = ?");
      params.push(filter.sessionKey);
    }

    if (filter.timeRange) {
      conditions.push("timestamp >= ? AND timestamp <= ?");
      params.push(filter.timeRange.start.toISOString(), filter.timeRange.end.toISOString());
    }

    if (filter.outcomeType) {
      conditions.push("outcome_type = ?");
      params.push(filter.outcomeType);
    }

    if (filter.minReward !== undefined) {
      conditions.push("reward_signal >= ?");
      params.push(filter.minReward);
    }

    if (filter.maxReward !== undefined) {
      conditions.push("reward_signal <= ?");
      params.push(filter.maxReward);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    
    const query = `
      SELECT 
        id,
        session_key,
        turn_number,
        episode_id,
        timestamp,
        system_prompt,
        user_message,
        context_json,
        action_type,
        action_json,
        outcome_type,
        outcome_json,
        reward_signal,
        skills_used,
        target_skill
      FROM evolution_turns
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT 10000
    `;

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Array<{
      id: string;
      session_key: string;
      turn_number: number;
      episode_id: string;
      timestamp: string;
      system_prompt?: string;
      user_message: string;
      context_json?: string;
      action_type: 'tool_call' | 'response' | 'error' | 'subagent_spawn';
      action_json: string;
      outcome_type: 'success' | 'failure' | 'partial' | 'error';
      outcome_json: string;
      reward_signal?: number;
      skills_used: string;
      target_skill?: string;
    }>;

    return rows.map(row => ({
      id: row.id,
      session_key: row.session_key,
      turn_number: row.turn_number,
      episode_id: row.episode_id,
      timestamp: row.timestamp,
      system_prompt: row.system_prompt,
      user_message: row.user_message,
      context_json: row.context_json,
      action_type: row.action_type,
      action_json: row.action_json,
      outcome_type: row.outcome_type,
      outcome_json: row.outcome_json,
      reward_signal: row.reward_signal,
      skills_used: row.skills_used,
      target_skill: row.target_skill,
    }));
  }

  /**
   * Query episodes with optional filtering.
   * 
   * @param sessionKey - Optional session key to filter by
   * @returns Array of episode records
   */
  async queryEpisodes(sessionKey?: string): Promise<EpisodeRecordRow[]> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.db) {
      throw new Error("Database not initialized");
    }

    let query: string;
    let params: string[] = [];

    if (sessionKey) {
      query = `
        SELECT 
          id,
          session_key,
          started_at,
          completed_at,
          outcome,
          skills_involved,
          total_reward
        FROM evolution_episodes
        WHERE session_key = ?
        ORDER BY started_at DESC
        LIMIT 1000
      `;
      params = [sessionKey];
    } else {
      query = `
        SELECT 
          id,
          session_key,
          started_at,
          completed_at,
          outcome,
          skills_involved,
          total_reward
        FROM evolution_episodes
        ORDER BY started_at DESC
        LIMIT 1000
      `;
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Array<{
      id: string;
      session_key: string;
      started_at: string;
      completed_at?: string;
      outcome: 'success' | 'failure' | 'partial';
      skills_involved: string;
      total_reward: number;
    }>;

    return rows.map(row => ({
      id: row.id,
      session_key: row.session_key,
      started_at: row.started_at,
      completed_at: row.completed_at,
      outcome: row.outcome,
      skills_involved: row.skills_involved,
      total_reward: row.total_reward,
    }));
  }

  /**
   * Get database statistics.
   * 
   * @returns Object with turn count, episode count, and database path
   */
  async getStats(): Promise<{ turns: number; episodes: number; path: string }> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const turnCount = (this.db.prepare("SELECT COUNT(*) as count FROM evolution_turns").get() as { count: number }).count;
    const episodeCount = (this.db.prepare("SELECT COUNT(*) as count FROM evolution_episodes").get() as { count: number }).count;

    return {
      turns: turnCount,
      episodes: episodeCount,
      path: this.getDbPath(),
    };
  }

  /**
   * Close the database connection.
   * Stops periodic flush if running.
   */
  close(): void {
    this.stopPeriodicFlush();
    
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    
    this.isInitialized = false;
    this.insertTurnStmt = null;
    this.insertEpisodeStmt = null;
    this.queryTurnsStmt = null;
  }

  /**
   * Run retention cleanup to remove old records.
   * 
   * @param daysToKeep - Number of days of data to retain
   * @returns Number of records deleted
   */
  async runRetentionCleanup(daysToKeep: number): Promise<{ turnsDeleted: number; episodesDeleted: number }> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const cutoffIso = cutoffDate.toISOString();

    // Delete old turns
    const turnsResult = this.db.prepare(
      "DELETE FROM evolution_turns WHERE timestamp < ?"
    ).run(cutoffIso);

    // Delete old episodes
    const episodesResult = this.db.prepare(
      "DELETE FROM evolution_episodes WHERE started_at < ?"
    ).run(cutoffIso);

    return {
      turnsDeleted: turnsResult.changes,
      episodesDeleted: episodesResult.changes,
    };
  }
}
