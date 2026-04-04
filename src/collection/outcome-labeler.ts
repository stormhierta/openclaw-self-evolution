/**
 * OpenClaw Self-Evolution Pipeline - Outcome Labeler
 * 
 * Processes batches of unlabeled turns from the trajectory DB and assigns
 * outcome quality scores for RL training data.
 * 
 * Design: Dedicated labeler that extends automatic labeling beyond turns
 * with targetSkill to make the trajectory DB useful as a general RL dataset.
 */

import Database from "better-sqlite3";
import type { EvolutionConfig, TurnRecordRow } from "../types.js";
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

// ============================================================================
// Labeling Result Types
// ============================================================================

export interface LabelingResult {
  turnId: string;
  rewardSignal: number;     // 0-1 score
  outcomeType: 'success' | 'partial' | 'failure';
  feedback?: string;         // Why this outcome
  labeledAt: Date;
}

// ============================================================================
// Outcome Labeler
// ============================================================================

/**
 * OutcomeLabeler processes batches of unlabeled turns from the trajectory DB
 * and assigns outcome quality scores for RL training data.
 * 
 * - Uses LLM-as-judge for turns with targetSkill set
 * - Uses heuristics for turns without targetSkill
 * - Batch processing limited to 20 turns per batch to avoid rate limits
 * 
 * FIX 5: Reuses the database connection from TrajectoryLogger instead of
 * opening its own. Call setDatabase() to inject the shared DB instance.
 */
export class OutcomeLabeler {
  private config: EvolutionConfig;
  private db: Database.Database | null = null;
  private isInitialized = false;
  private apiKey: string;
  private apiBaseUrl: string;
  private externalDb: Database.Database | null = null;

  // Prepared statement for updating reward signals
  private updateTurnStmt: Database.Statement | null = null;

  /**
   * @param config - Plugin config
   * @param sharedDb - Optional: reuse an existing DB connection (e.g. from TrajectoryLogger)
   *                   to avoid dual-connection SQLITE_BUSY contention.
   */
  constructor(config: EvolutionConfig, sharedDb?: Database.Database) {
    this.config = config;
    this.apiKey = process.env.MINIMAX_API_KEY ?? "";
    this.apiBaseUrl = "https://api.minimax.io";
    if (sharedDb) {
      this.externalDb = sharedDb;
      this.db = sharedDb;
    }
  }

  /**
   * Set the shared database instance from TrajectoryLogger.
   * FIX 5: Eliminates the need for OutcomeLabeler to open its own DB connection.
   */
  setDatabase(db: Database.Database): void {
    this.db = db;
    this.externalDb = db;
    this.updateTurnStmt = this.db.prepare(`
      UPDATE evolution_turns 
      SET reward_signal = ? 
      WHERE id = ?
    `);
    this.isInitialized = true;
  }

  /**
   * Get the database path from config or use default.
   */
  private getDbPath(): string {
    return this.config.storage.trajectoryDbPath ?? 
           `${process.env.HOME ?? "."}/.openclaw/evolution/trajectories.db`;
  }

  /**
   * Initialize the database connection (legacy - use setDatabase for shared DB).
   * Kept for backward compatibility when no shared DB is provided.
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

      // Prepare statement for updating turn reward signals
      this.updateTurnStmt = this.db.prepare(`
        UPDATE evolution_turns 
        SET reward_signal = ? 
        WHERE id = ?
      `);

      this.isInitialized = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to initialize outcome labeler database at ${dbPath}: ${message}`, { cause: error });
    }
  }

  /**
   * Get unlabeled turns from DB (reward_signal IS NULL or = 0.5 default).
   * 
   * @param skillName - Optional skill name to filter by
   * @param limit - Maximum number of turns to return (default 20)
   * @returns Array of unlabeled turn records
   */
  async getUnlabeledTurns(
    skillName?: string,
    limit = 20
  ): Promise<TurnRecordRow[]> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.db) {
      throw new Error("Database not initialized");
    }

    let query: string;
    let params: (string | number)[] = [];

    if (skillName) {
      query = `
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
        WHERE reward_signal IS NULL
          AND (target_skill = ? OR skills_used LIKE ?)
        ORDER BY timestamp DESC
        LIMIT ?
      `;
      params = [skillName, `%${skillName}%`, limit];
    } else {
      query = `
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
        WHERE reward_signal IS NULL
        ORDER BY timestamp DESC
        LIMIT ?
      `;
      params = [limit];
    }

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
   * Label a single turn with an outcome quality score.
   * 
   * Uses LLM-as-judge for turns with targetSkill, heuristics otherwise.
   * 
   * @param turn - The turn to label
   * @param skillContent - Optional skill content for context
   * @returns The labeling result
   */
  async labelTurn(
    turn: TurnRecordRow,
    skillContent?: string
  ): Promise<LabelingResult> {
    // Use LLM evaluation for turns with targetSkill
    if (turn.target_skill) {
      try {
        const result = await this.labelWithLLM(turn, skillContent);
        await this.persistLabel(turn.id, result.rewardSignal);
        return result;
      } catch (err) {
        // Fall through to heuristic on LLM failure
        console.warn(`[outcome-labeler] LLM labeling failed for turn ${turn.id}, using heuristic:`, err);
      }
    }

    // Use heuristic for turns without targetSkill or when LLM fails
    const result = this.labelWithHeuristic(turn);
    await this.persistLabel(turn.id, result.rewardSignal);
    return result;
  }

  /**
   * Label a batch of turns that don't yet have reward signals.
   * 
   * FIX 2: Processes ALL turns in chunks of 20 to avoid rate limits.
   * Previously, turns beyond batch limit were silently dropped.
   * 
   * @param turns - The turns to label
   * @param skillContent - Optional skill content for context
   * @returns Array of labeling results
   */
  async labelBatch(
    turns: TurnRecordRow[],
    skillContent?: string
  ): Promise<LabelingResult[]> {
    const results: LabelingResult[] = [];
    
    // FIX 2: Process in chunks of 20 instead of dropping turns beyond limit
    for (let i = 0; i < turns.length; i += 20) {
      const chunk = turns.slice(i, i + 20);
      const chunkResults = await Promise.all(
        chunk.map(turn => this.labelTurn(turn, skillContent).catch(err => {
          console.error(`[outcome-labeler] Failed to label turn ${turn.id}:`, err);
          return null;
        }))
      );
      // Filter out failed labels (nulls)
      results.push(...chunkResults.filter((r): r is LabelingResult => r !== null));
    }

    return results;
  }

  /**
   * Label a turn using LLM-as-judge.
   * 
   * Pattern from TrajectoryLogger.evaluateOutcome()
   */
  private async labelWithLLM(
    turn: TurnRecordRow,
    skillContent?: string
  ): Promise<LabelingResult> {
    const outcomeJson = JSON.parse(turn.outcome_json) as Record<string, unknown>;
    
    const prompt = `Evaluate whether an AI agent successfully completed a task.

## TASK
${turn.user_message}

## AGENT OUTPUT
${JSON.stringify(outcomeJson, null, 2)}

${turn.target_skill ? `## SKILL BEING EVALUATED\n${turn.target_skill}\n` : ""}
${skillContent ? `## SKILL CONTENT\n${skillContent}\n` : ""}

## YOUR TASK
Rate the quality of the agent's output on a scale from 0.0 to 1.0:
- 1.0 = Task fully and correctly completed
- 0.7-0.9 = Task mostly completed with minor issues
- 0.4-0.6 = Task partially completed
- 0.1-0.3 = Task attempted but mostly failed
- 0.0 = Task not completed or completely wrong

Return ONLY a JSON object: {"score": N, "reason": "brief explanation", "outcome": "success|partial|failure"}`;

    const response = await this.callMiniMax(prompt);
    
    try {
      const parsed = JSON.parse(response) as { 
        score?: number; 
        reason?: string; 
        outcome?: 'success' | 'partial' | 'failure';
      };
      
      const score = typeof parsed.score === "number" ? parsed.score : parseFloat(String(parsed.score));
      const normalizedScore = isNaN(score) ? 0.5 : Math.max(0, Math.min(1, score));
      
      // Map score to outcome type if not provided
      let outcomeType: 'success' | 'partial' | 'failure';
      if (parsed.outcome && ['success', 'partial', 'failure'].includes(parsed.outcome)) {
        outcomeType = parsed.outcome;
      } else {
        outcomeType = this.scoreToOutcomeType(normalizedScore);
      }

      return {
        turnId: turn.id,
        rewardSignal: normalizedScore,
        outcomeType,
        feedback: parsed.reason,
        labeledAt: new Date(),
      };
    } catch {
      // Fallback if parsing fails
      return {
        turnId: turn.id,
        rewardSignal: 0.5,
        outcomeType: 'partial',
        feedback: "Failed to parse LLM response",
        labeledAt: new Date(),
      };
    }
  }

  /**
   * Label a turn using heuristics (no LLM call).
   * 
   * Heuristics:
   * - Tool call success/failure from outcome_type
   * - Response length as proxy for effort
   * - Error keywords in outcome JSON → failure
   * 
   * FIX 4: Check outcome_type BEFORE keyword matching to avoid
   * penalizing turns with explicit success outcome_type.
   */
  private labelWithHeuristic(turn: TurnRecordRow): LabelingResult {
    let score = 0.5;
    let outcomeType: 'success' | 'partial' | 'failure' = 'partial';
    let feedback = "";

    // Parse outcome JSON
    let outcome: Record<string, unknown> = {};
    try {
      outcome = JSON.parse(turn.outcome_json);
    } catch {
      // Use default values if parsing fails
    }

    // 1. Check outcome_type from the turn record FIRST
    // FIX 4: If outcome_type is explicitly success, don't penalize based on keywords
    if (turn.outcome_type === 'success') {
      score = 0.8;
      outcomeType = 'success';
      feedback = "Outcome type indicates success";
      
      // But still check for error indicators that might override
      const outcomeStr = JSON.stringify(outcome).toLowerCase();
      const errorKeywords = ['error', 'exception', 'failed', 'failure', 'timeout', 'abort', 'cancelled'];
      const hasErrorKeyword = errorKeywords.some(kw => outcomeStr.includes(kw));
      if (hasErrorKeyword) {
        score = 0.4; // downgrade but still partial, not full failure
        outcomeType = 'partial';
        feedback += ", error keywords detected in outcome";
      }
      
      return {
        turnId: turn.id,
        rewardSignal: Math.max(0, Math.min(1, score)),
        outcomeType,
        feedback: feedback || "Heuristic labeling based on outcome analysis",
        labeledAt: new Date(),
      };
    }

    switch (turn.outcome_type) {
      case 'failure':
      case 'error':
        score = 0.2;
        outcomeType = 'failure';
        feedback = "Outcome type indicates failure/error";
        break;
      case 'partial':
        score = 0.5;
        outcomeType = 'partial';
        feedback = "Outcome type indicates partial success";
        break;
    }

    // 2. Check for error keywords in outcome JSON (for non-success outcomes)
    const outcomeStr = JSON.stringify(outcome).toLowerCase();
    const errorKeywords = ['error', 'exception', 'failed', 'failure', 'timeout', 'abort', 'cancelled'];
    const hasErrorKeyword = errorKeywords.some(kw => outcomeStr.includes(kw));
    
    if (hasErrorKeyword) {
      score = Math.min(score, 0.3);
      outcomeType = 'failure';
      feedback += feedback ? ", error keywords detected in outcome" : "Error keywords detected in outcome";
    }

    // 3. Use response length as proxy for effort (only for partial outcomes)
    // Note: 'success' outcome_type returns early, so we only check 'partial' here
    if (outcomeType === 'partial') {
      const content = outcomeStr;
      // Reward moderate-length responses (not too short, not too long)
      if (content.length > 100 && content.length < 5000) {
        score = Math.min(score + 0.1, 1.0);
        feedback += feedback ? ", appropriate response length" : "Appropriate response length";
      } else if (content.length < 50) {
        score = Math.max(score - 0.1, 0.0);
        feedback += feedback ? ", very short response" : "Very short response";
      }
    }

    // 4. Check for explicit success indicators
    const successKeywords = ['success', 'completed', 'done', 'result'];
    const hasSuccessKeyword = successKeywords.some(kw => outcomeStr.includes(kw));
    
    if (hasSuccessKeyword && !hasErrorKeyword) {
      score = Math.min(score + 0.1, 1.0);
      feedback += feedback ? ", success indicators present" : "Success indicators present";
    }

    return {
      turnId: turn.id,
      rewardSignal: Math.max(0, Math.min(1, score)),
      outcomeType,
      feedback: feedback || "Heuristic labeling based on outcome analysis",
      labeledAt: new Date(),
    };
  }

  /**
   * Convert a score to an outcome type.
   */
  private scoreToOutcomeType(score: number): 'success' | 'partial' | 'failure' {
    if (score >= 0.7) return 'success';
    if (score >= 0.4) return 'partial';
    return 'failure';
  }

  /**
   * Persist the label to the database.
   */
  private async persistLabel(turnId: string, rewardSignal: number): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.db || !this.updateTurnStmt) {
      throw new Error("Database not initialized");
    }

    this.updateTurnStmt.run(rewardSignal, turnId);
  }

  /**
   * Call the MiniMax API.
   * Pattern matches: TrajectoryLogger.callMiniMax()
   */
  private async callMiniMax(prompt: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error("MINIMAX_API_KEY environment variable is not set");
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
            model: "MiniMax-M2.7",
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
            temperature: 0.1, // Low temperature for consistent scoring
            max_tokens: 500,
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
   * Close the database connection.
   */
  close(): void {
    // Only close if we own the DB (not a shared external connection)
    if (this.db && !this.externalDb) {
      this.db.close();
    }
    this.db = null;
    this.isInitialized = false;
    this.updateTurnStmt = null;
  }
}
