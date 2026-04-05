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
import type { EvolutionConfig, TurnRecordRow, EpisodeRecordRow, TrajectoryFilter, LlmConfig } from "../types.js";
import type { TrajectoryHookHandler } from "../hooks/trajectory-hooks.js";
import type { OutcomeLabeler } from "./outcome-labeler.js";
import { containsSecretInAny } from "./secret-detector.js";
import { saveTrajectory } from "./trajectory-exporter.js";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

// ============================================================================
// MiniMax API Types
// ============================================================================

interface MiniMaxResponse {
  id?: string;
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  base_resp?: {
    status_code: number;
    status_msg: string;
  };
  error?: {
    message: string;
  };
}

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
  private flushInterval: ReturnType<typeof setTimeout> | null = null;
  private isInitialized = false;
  private isFlushing = false;
  private apiKey: string;
  private apiBaseUrl: string;
  private model: string;
  private apiKeyEnvVar: string;
  private temperature: number;
  private maxTokens: number;
  private outcomeLabeler: OutcomeLabeler | null = null;

  // Prepared statements for performance
  private insertTurnStmt: Database.Statement | null = null;
  private insertEpisodeStmt: Database.Statement | null = null;
  private queryTurnsStmt: Database.Statement | null = null;

  constructor(config: EvolutionConfig, handler: TrajectoryHookHandler, outcomeLabeler?: OutcomeLabeler, llmConfig?: LlmConfig) {
    this.config = config;
    this.handler = handler;

    // Use provided config or fall back to defaults
    this.model = llmConfig?.model ?? "MiniMax-M2.7";
    this.apiBaseUrl = llmConfig?.apiBase ?? "https://api.minimax.io";
    this.apiKeyEnvVar = llmConfig?.apiKeyEnvVar ?? "MINIMAX_API_KEY";
    this.temperature = llmConfig?.temperature ?? 0.1;
    this.maxTokens = llmConfig?.maxTokens ?? 500;

    this.apiKey = process.env[this.apiKeyEnvVar] ?? "";
    this.outcomeLabeler = outcomeLabeler ?? null;
  }

  /**
   * Set the outcome labeler for background labeling.
   * Called after construction when labeler is available.
   * FIX 5: Passes the shared DB instance to the labeler.
   */
  setOutcomeLabeler(labeler: OutcomeLabeler): void {
    this.outcomeLabeler = labeler;
    // FIX 5: If DB is already initialized, share it with the labeler
    if (this.db && this.isInitialized) {
      labeler.setDatabase(this.db);
    }
  }

  /**
   * Get the database path from config or use default.
   */
  private getDbPath(): string {
    return this.config.storage.trajectoryDbPath ?? 
           `${process.env.HOME ?? "."}/.openclaw/evolution/trajectories.db`;
  }

  /**
   * Evaluate the outcome of a turn using LLM-as-judge.
   * Returns a quality score between 0.0 and 1.0 based on actual task outcome.
   * 
   * Pattern from: reference/hermes-agent-self-evolution/evolution/core/external_importers.py
   */
  private async evaluateOutcome(
    userMessage: string,
    outcomeJson: Record<string, unknown>,
    targetSkill?: string
  ): Promise<number> {
    // If no outcome data or no user message, return neutral score
    if (!userMessage || !outcomeJson || typeof outcomeJson !== 'object' || Object.keys(outcomeJson).length === 0) {
      return 0.5;
    }

    const outcomeStr = JSON.stringify(outcomeJson, null, 2);

    const prompt = `Evaluate whether an AI agent successfully completed a task.

## TASK
${userMessage}

## AGENT OUTPUT
${outcomeStr}

${targetSkill ? `## SKILL BEING EVALUATED\n${targetSkill}\n` : ""}

## YOUR TASK
Rate the quality of the agent's output on a scale from 0.0 to 1.0:
- 1.0 = Task fully and correctly completed
- 0.7-0.9 = Task mostly completed with minor issues
- 0.4-0.6 = Task partially completed
- 0.1-0.3 = Task attempted but mostly failed
- 0.0 = Task not completed or completely wrong

Return ONLY a JSON object: {"score": N, "reason": "brief explanation"}`;

    try {
      const response = await this.callMiniMax(prompt);
      const parsed = JSON.parse(response) as { score?: number; reason?: string };
      const score = typeof parsed.score === "number" ? parsed.score : parseFloat(String(parsed.score));
      return isNaN(score) ? 0.5 : Math.max(0, Math.min(1, score));
    } catch {
      return 0.5; // neutral fallback
    }
  }

  /**
   * Call the MiniMax API.
   * Pattern matches: src/evolution/fitness/llm-judge.ts callMiniMax()
   */
  private async callMiniMax(prompt: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error(`${this.apiKeyEnvVar} environment variable is not set`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000); // 12s timeout

    try {
      const response = await fetch(
        `${this.apiBaseUrl}/v1/text/chatcompletion_v2`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            messages: [
              {
                role: "system",
                content:
                  "You are an expert AI task evaluator. Always return valid JSON with exact field names.",
              },
              {
                role: "user",
                content: prompt,
              },
            ],
            temperature: this.temperature,
            max_tokens: this.maxTokens,
          }),
          signal: controller.signal,
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `MiniMax API error: ${response.status} ${response.statusText} - ${errorText}`
        );
      }

      const data = (await response.json()) as MiniMaxResponse;

      // Check MiniMax base_resp status_code
      if (data.base_resp && data.base_resp.status_code !== 0) {
        throw new Error(
          `MiniMax API error: ${data.base_resp.status_msg} (code ${data.base_resp.status_code})`
        );
      }

      if (data.error) {
        throw new Error(`MiniMax API error: ${data.error.message}`);
      }

      const content = data.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("MiniMax API returned empty content");
      }

      return content;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Compute reward signal using fallback heuristic (token efficiency).
   * Used when targetSkill is not set or LLM evaluation fails.
   * 
   * DEPRECATED: Use evaluateOutcome() for actual task outcome scoring.
   */
  private computeFallbackRewardSignal(turn: TurnRecordRow): number | undefined {
    // Try to extract usage data from outcome_json
    try {
      const outcome = JSON.parse(turn.outcome_json) as { usage?: { input?: number; output?: number; total?: number } };
      if (outcome.usage) {
        const totalTokens = (outcome.usage.input ?? 0) + (outcome.usage.output ?? 0);
        // Simple heuristic: reward efficient responses
        return Math.max(0, 1 - (totalTokens / 10000));
      }
    } catch {
      // Ignore parse errors
    }

    // Try to extract duration from outcome data
    try {
      const outcome = JSON.parse(turn.outcome_json) as { durationMs?: number; error?: string };
      if (outcome.durationMs !== undefined && !outcome.error) {
        return Math.max(0, 1 - (outcome.durationMs / 5000));
      }
    } catch {
      // Ignore parse errors
    }

    return undefined;
  }

  /**
   * Compute reward signal for a turn.
   * Uses LLM-as-judge when targetSkill is set, falls back to heuristic otherwise.
   */
  async computeRewardSignal(turn: TurnRecordRow): Promise<number | undefined> {
    // Only use LLM evaluation when targetSkill is set (we're measuring skill performance)
    // This controls costs - don't evaluate every single turn
    if (turn.target_skill) {
      try {
        const outcomeJson = JSON.parse(turn.outcome_json) as Record<string, unknown>;
        const score = await this.evaluateOutcome(
          turn.user_message,
          outcomeJson,
          turn.target_skill
        );
        return score;
      } catch {
        // LLM evaluation failed, fall through to heuristic
      }
    }

    // Fallback to heuristic when no target_skill or LLM call failed
    return this.computeFallbackRewardSignal(turn);
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

      // FIX 5: Share DB with outcome labeler if already set
      if (this.outcomeLabeler) {
        this.outcomeLabeler.setDatabase(this.db);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to initialize trajectory database at ${dbPath}: ${message}`, { cause: error });
    }
  }

  /**
   * Process labeling chunks in background (fire-and-forget).
   * Processes turns in chunks of 20 to avoid rate limits.
   */
  private async processLabelingChunks(turns: TurnRecordRow[]): Promise<void> {
    if (!this.outcomeLabeler) return;

    const chunkSize = 20;
    for (let i = 0; i < turns.length; i += chunkSize) {
      const chunk = turns.slice(i, i + chunkSize);
      await this.outcomeLabeler.labelBatch(chunk);
    }
  }

  /**
   * Export episodes to JSONL format for training data collection.
   * Converts turns to ShareGPT format and appends to trajectory files.
   */
  private async exportEpisodesToJsonl(
    episodes: EpisodeRecordRow[],
    committedTurnIds: Set<string>,
    turns: TurnRecordRow[]
  ): Promise<void> {
    for (const episode of episodes) {
      // Get turns for this episode that were committed in this flush
      const episodeTurns = turns
        .filter(t => t.episode_id === episode.id && committedTurnIds.has(t.id))
        .sort((a, b) => a.turn_number - b.turn_number);

      // Skip episodes with no turns
      if (episodeTurns.length === 0) {
        continue;
      }

      // Build ShareGPT-format conversation
      const trajectory: Array<{ role: string; content: string }> = [];
      let model = this.model; // default to logger's model

      for (const turn of episodeTurns) {
        // User message -> role: 'human'
        if (turn.user_message) {
          trajectory.push({
            role: "human",
            content: turn.user_message,
          });
        }

        // Assistant response from action_json -> role: 'gpt'
        try {
          const actionJson = JSON.parse(turn.action_json) as Record<string, unknown>;
          const content = actionJson.content as string | undefined;
          if (content) {
            trajectory.push({
              role: "gpt",
              content,
            });
          }

          // Extract model from action_json if available
          const turnModel = actionJson.model as string | undefined;
          if (turnModel) {
            model = turnModel;
          }
        } catch {
          // If action_json doesn't parse, skip the assistant turn
        }
      }

      // Only export if we have at least one turn
      if (trajectory.length > 0) {
        const completed = episode.outcome === "success";
        await saveTrajectory(trajectory, model, completed);
      }
    }
  }

  /**
   * Flush buffered trajectory data to SQLite.
   * 
   * Drains buffer from hook handler, writes to SQLite, returns count written.
   * Uses prepared statements for efficiency.
   * 
   * FIX 1: Snapshots turns before processing to avoid race condition where
   * new turns added during async operations get lost when clearing buffer.
   * 
   * FIX 1 (P3-B): Removed inline LLM calls from flush(). Reward signals are
   * computed asynchronously via OutcomeLabeler after DB commit (fire-and-forget).
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

    // FIX 1: Snapshot the current turns and episodes — only commit THESE
    // This prevents race condition where turns added during operations are lost
    const rawTurns = this.handler.getFinalizedTurns();
    const episodes = this.handler.getCompletedEpisodes();

    // Filter out turns containing secrets before processing
    const turns: typeof rawTurns = [];
    for (const turn of rawTurns) {
      // Check all text fields for secrets
      const hasSecret = containsSecretInAny(
        turn.user_message,
        turn.system_prompt,
        turn.context_json,
        turn.action_json,
        turn.outcome_json,
        turn.skills_used,
        turn.target_skill
      );
      
      if (hasSecret) {
        console.warn(`[trajectory-logger] Skipping turn ${turn.id} - potential secret detected`);
        continue;
      }
      turns.push(turn);
    }

    if (turns.length === 0 && episodes.length === 0) {
      return 0;
    }

    // FIX 1: Track which specific turns we're committing (by ID)
    const committedTurnIds = new Set(turns.map(t => t.id));
    const committedEpisodeIds = new Set(episodes.map(e => e.id));

    let writtenCount = 0;

    // Use a transaction for atomicity - any error rolls back all changes
    const transaction = this.db.transaction(() => {
      // Insert turns (reward_signal is NULL by default - will be labeled later)
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
          turn.reward_signal ?? null,  // NULL if not set (Fix 3)
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

      // FIX 1: Only remove the specific turns/episodes we committed (not any new ones added during await)
      this.handler.removeFinalizedTurns(committedTurnIds);
      this.handler.removeCompletedEpisodes(committedEpisodeIds);

      // Export episodes to JSONL for training data collection
      await this.exportEpisodesToJsonl(episodes, committedTurnIds, turns);

      // FIX 1 (P3-B): Fire-and-forget background labeling for turns with target_skill
      // This happens AFTER DB commit so flush() doesn't block on LLM calls
      const targetSkillTurns = turns.filter(t => t.target_skill && committedTurnIds.has(t.id));
      if (targetSkillTurns.length > 0 && this.outcomeLabeler) {
        this.processLabelingChunks(targetSkillTurns).catch(err => {
          console.warn("[trajectory-logger] Background labeling error:", err);
        });
      }
    } catch (error) {
      console.error("[trajectory-logger] Transaction failed:", error);
      // Buffers are NOT cleared - data is preserved for next flush attempt
      throw error;
    }

    return writtenCount;
  }

  /**
   * Start periodic background flush.
   * 
   * FIX 3: Uses self-scheduling setTimeout pattern with flush lock to prevent
   * overlapping flush calls.
   * 
   * @param intervalMs - Flush interval in milliseconds (default: 60000 = 1 minute)
   */
  startPeriodicFlush(intervalMs = 60000): void {
    if (this.flushInterval) {
      // Already running
      return;
    }

    const scheduleNext = (): void => {
      this.flushInterval = setTimeout(async () => {
        if (!this.isFlushing) {
          this.isFlushing = true;
          try {
            const count = await this.flush();
            if (count > 0) {
              console.log(`[trajectory-logger] Periodic flush: ${count} records written`);
            }
          } catch (error) {
            console.error("[trajectory-logger] Periodic flush failed:", error);
          } finally {
            this.isFlushing = false;
          }
        }
        scheduleNext(); // always schedule next, regardless of outcome
      }, intervalMs);

      // Ensure the timeout doesn't prevent process exit
      if (this.flushInterval.unref) {
        this.flushInterval.unref();
      }
    };

    scheduleNext();
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
