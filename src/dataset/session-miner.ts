/**
 * OpenClaw Self-Evolution Pipeline - Dataset Session Miner
 *
 * Extracts training data from session trajectories for skill evolution.
 *
 * Design decisions based on:
 * - src/collection/session-miner.ts: SessionMiner queries raw session data
 * - src/collection/trajectory-logger.ts: TrajectoryLogger persists to SQLite
 * - src/dataset/manager.ts: DatasetManager stores DatasetEntry[]
 * - src/types.ts: DatasetEntry, TurnRecordRow, TimeRangeRow types
 *
 * This is DIFFERENT from collection/session-miner.ts:
 * - collection/session-miner.ts: collects raw trajectory data from OpenClaw sessions
 * - dataset/session-miner.ts: extracts TRAINING DATA (DatasetEntry) from sessions
 */

import type {
  EvolutionConfig,
  DatasetEntry,
  DatasetEntryMetadata,
  TurnRecordRow,
  TimeRangeRow,
} from "../types.js";
import type { SessionMiner } from "../collection/session-miner.js";
import type { TrajectoryLogger } from "../collection/trajectory-logger.js";

/**
 * Options for mining dataset entries from sessions.
 */
export interface MineOptions {
  /** Maximum number of entries to return */
  maxEntries?: number;
  /** Minimum reward signal threshold (0-1) */
  minRewardSignal?: number;
  /** Time range to filter sessions */
  timeRange?: TimeRangeRow;
  /** Include partial/incomplete turns */
  includePartialTurns?: boolean;
}

/**
 * DatasetSessionMiner extracts training examples from agent session data.
 *
 * Converts raw trajectory data into DatasetEntry objects suitable for
 * training and skill evolution. Works with SessionMiner (for querying
 * sessions) and TrajectoryLogger (for accessing persisted trajectories).
 *
 * Source: OpenClaw session storage patterns from collection/session-miner.ts
 * Output: DatasetEntry[] compatible with dataset/manager.ts
 */
export class DatasetSessionMiner {
  private config: EvolutionConfig;
  private sessionMiner: SessionMiner;
  private trajectoryLogger: TrajectoryLogger;

  constructor(
    config: EvolutionConfig,
    sessionMiner: SessionMiner,
    trajectoryLogger: TrajectoryLogger
  ) {
    this.config = config;
    this.sessionMiner = sessionMiner;
    this.trajectoryLogger = trajectoryLogger;
  }

  /**
   * Mine sessions for examples where a specific skill was successfully used.
   *
   * Extracts user requests and the corresponding successful skill invocations
   * as training examples. Filters for successful outcomes and optionally
   * by reward signal threshold.
   *
   * Falls back to SessionMiner if TrajectoryLogger returns empty results.
   *
   * @param skillName - Name of the skill to mine examples for
   * @param options - Mining options (maxEntries, minRewardSignal, timeRange, includePartialTurns)
   * @returns Array of DatasetEntry objects for training
   */
  async mineForSkill(
    skillName: string,
    options?: MineOptions
  ): Promise<DatasetEntry[]> {
    // Query turns from trajectory logger first (persisted, processed data)
    let turns = await this.trajectoryLogger.query({
      skillName,
      outcomeType: "success",
      minReward: options?.minRewardSignal,
      timeRange: options?.timeRange
        ? {
            start: new Date(options.timeRange.start),
            end: new Date(options.timeRange.end),
          }
        : undefined,
    });

    // Fallback to SessionMiner if trajectory logger returns empty
    if (turns.length === 0) {
      turns = await this.sessionMiner.queryTurns({
        skillName,
        outcomeType: "success",
        minReward: options?.minRewardSignal,
        timeRange: options?.timeRange
          ? {
              start: new Date(options.timeRange.start),
              end: new Date(options.timeRange.end),
            }
          : undefined,
      });
    }

    if (turns.length === 0) {
      return [];
    }

    const entries: DatasetEntry[] = [];
    const maxEntries = options?.maxEntries ?? 1000;

    for (const turn of turns) {
      // Skip partial turns unless explicitly included
      if (turn.outcome_type === "partial" && !options?.includePartialTurns) {
        continue;
      }

      // Parse action JSON to get the skill invocation details
      let actionData: Record<string, unknown>;
      try {
        actionData = JSON.parse(turn.action_json) as Record<string, unknown>;
      } catch {
        actionData = {};
      }

      // Parse outcome JSON for additional context
      let outcomeData: Record<string, unknown>;
      try {
        outcomeData = JSON.parse(turn.outcome_json) as Record<string, unknown>;
      } catch {
        outcomeData = {};
      }

      // Parse context JSON for session info
      let contextData: Record<string, unknown>;
      try {
        contextData = turn.context_json
          ? (JSON.parse(turn.context_json) as Record<string, unknown>)
          : {};
      } catch {
        contextData = {};
      }

      // Determine difficulty based on input length heuristic
      const difficulty = this.assessDifficulty(turn.user_message);

      // Build the dataset entry
      const metadata: DatasetEntryMetadata = {
        source: 'openclaw',
        difficulty,
        outcomeType: turn.outcome_type,
        rewardSignal: turn.reward_signal,
      };

      const entry: DatasetEntry = {
        id: `${turn.id}_dataset`,
        datasetId: "mined", // Will be set when added to a dataset
        input: turn.user_message,
        expectedOutput: this.buildExpectedOutput(turn, actionData, outcomeData),
        context: {
          skillName,
          sessionKey: turn.session_key,
          episodeId: turn.episode_id,
          turnNumber: turn.turn_number,
          actionType: turn.action_type,
          ...contextData,
        },
        score: this.scoreEntryFromTurn(turn),
        metadata,
        createdAt: new Date(turn.timestamp),
      };

      entries.push(entry);

      if (entries.length >= maxEntries) {
        break;
      }
    }

    return entries;
  }

  /**
   * Extract examples of successful tool calls as training data.
   *
   * Mines turns where tools were invoked successfully, creating
   * input/output pairs showing the user request and the correct
   * tool call parameters.
   *
   * Falls back to SessionMiner if TrajectoryLogger returns empty results.
   *
   * @param limit - Maximum number of examples to extract
   * @returns Array of DatasetEntry objects for tool call training
   */
  async mineSuccessfulToolCalls(limit?: number): Promise<DatasetEntry[]> {
    // Query from trajectory logger first
    let turns = await this.trajectoryLogger.query({
      outcomeType: "success",
    });

    // Fallback to SessionMiner if trajectory logger returns empty
    if (turns.length === 0) {
      turns = await this.sessionMiner.queryTurns({
        outcomeType: "success",
      });
    }

    // Filter to only tool_call actions
    const toolCallTurns = turns.filter((turn) => turn.action_type === "tool_call");

    if (toolCallTurns.length === 0) {
      return [];
    }

    const entries: DatasetEntry[] = [];
    const maxEntries = limit ?? 1000;

    for (const turn of toolCallTurns.slice(0, maxEntries)) {
      // Parse action JSON to get tool call details
      let actionData: Record<string, unknown>;
      try {
        actionData = JSON.parse(turn.action_json) as Record<string, unknown>;
      } catch {
        actionData = {};
      }

      // Parse outcome JSON for result details
      let outcomeData: Record<string, unknown>;
      try {
        outcomeData = JSON.parse(turn.outcome_json) as Record<string, unknown>;
      } catch {
        outcomeData = {};
      }

      // Parse skills_used to get the tool name
      let skillsUsed: string[] = [];
      try {
        skillsUsed = JSON.parse(turn.skills_used) as string[];
      } catch {
        skillsUsed = [];
      }

      const metadata: DatasetEntryMetadata = {
        source: 'openclaw',
        difficulty: this.assessDifficulty(turn.user_message),
      };

      const entry: DatasetEntry = {
        id: `${turn.id}_toolcall`,
        datasetId: "mined",
        input: turn.user_message,
        expectedOutput: JSON.stringify({
          toolName: actionData.toolName ?? turn.target_skill ?? skillsUsed[0],
          params: actionData.params ?? {},
          result: outcomeData.resultPreview ?? "success",
        }),
        context: {
          toolName: actionData.toolName ?? turn.target_skill,
          sessionKey: turn.session_key,
          episodeId: turn.episode_id,
          skillsUsed,
        },
        score: this.scoreEntryFromTurn(turn),
        metadata,
        createdAt: new Date(turn.timestamp),
      };

      entries.push(entry);
    }

    return entries;
  }

  /**
   * Extract user→assistant exchanges as input/output pairs.
   *
   * Mines conversation turns where the user made a request and
   * the assistant responded (optionally with tool calls). Useful
   * for training conversational skills and response generation.
   *
   * Falls back to SessionMiner if TrajectoryLogger returns empty results.
   *
   * @param filter - Optional filters for skill name and minimum reward
   * @returns Array of DatasetEntry objects for conversational training
   */
  async mineUserAssistantPairs(filter?: {
    skillName?: string;
    minReward?: number;
  }): Promise<DatasetEntry[]> {
    // Query response-type turns from trajectory logger first
    let turns = await this.trajectoryLogger.query({
      skillName: filter?.skillName,
      minReward: filter?.minReward,
    });

    // Fallback to SessionMiner if trajectory logger returns empty
    if (turns.length === 0) {
      turns = await this.sessionMiner.queryTurns({
        skillName: filter?.skillName,
        minReward: filter?.minReward,
      });
    }

    // Filter to response actions (user → assistant exchanges)
    const responseTurns = turns.filter((turn) => turn.action_type === "response");

    if (responseTurns.length === 0) {
      return [];
    }

    const entries: DatasetEntry[] = [];

    for (const turn of responseTurns) {
      // Parse outcome JSON to get assistant response
      let outcomeData: Record<string, unknown>;
      try {
        outcomeData = JSON.parse(turn.outcome_json) as Record<string, unknown>;
      } catch {
        outcomeData = {};
      }

      // Parse skills used
      let skillsUsed: string[] = [];
      try {
        skillsUsed = JSON.parse(turn.skills_used) as string[];
      } catch {
        skillsUsed = [];
      }

      const metadata: DatasetEntryMetadata = {
        source: 'openclaw',
        difficulty: this.assessDifficulty(turn.user_message),
        outcomeType: turn.outcome_type,
      };

      const entry: DatasetEntry = {
        id: `${turn.id}_conversation`,
        datasetId: "mined",
        input: turn.user_message,
        expectedOutput:
          (outcomeData.textPreview as string) ??
          JSON.stringify(outcomeData),
        context: {
          sessionKey: turn.session_key,
          episodeId: turn.episode_id,
          turnNumber: turn.turn_number,
          skillsUsed,
          targetSkill: turn.target_skill,
          hasToolCall: outcomeData.hasToolCall ?? false,
          model: outcomeData.model,
          provider: outcomeData.provider,
        },
        score: this.scoreEntryFromTurn(turn),
        metadata,
        createdAt: new Date(turn.timestamp),
      };

      entries.push(entry);
    }

    return entries;
  }

  /**
   * Compute a quality score for a mined dataset entry.
   *
   * Scores are 0-1 based on:
   * - Outcome type (success = higher)
   * - Reward signal (if available)
   * - Turn completeness
   * - Skill specificity (target_skill present = higher)
   *
   * @param entry - The dataset entry to score
   * @returns Quality score between 0 and 1
   */
  scoreEntry(entry: DatasetEntry): number {
    let score = 0.5; // Base score

    // Outcome type scoring
    const outcomeType = entry.metadata?.outcomeType as string | undefined;
    if (outcomeType === "success") {
      score += 0.3;
    } else if (outcomeType === "partial") {
      score += 0.1;
    } else if (outcomeType === "error" || outcomeType === "failure") {
      score -= 0.3;
    }

    // Reward signal (0-1, weighted 0.2)
    const rewardSignal = entry.metadata?.rewardSignal as number | undefined;
    if (typeof rewardSignal === "number" && !Number.isNaN(rewardSignal)) {
      score += rewardSignal * 0.2;
    }

    // Has target skill specificity
    const context = entry.context ?? {};
    if (context.targetSkill || context.skillName) {
      score += 0.1;
    }

    // Input quality (non-empty, reasonable length)
    if (entry.input && entry.input.length > 10) {
      score += 0.05;
    }
    if (entry.input && entry.input.length > 100) {
      score += 0.05; // Bonus for substantial input
    }

    // Clamp to 0-1
    return Math.max(0, Math.min(1, score));
  }

  /**
   * Build the expected output string from turn data.
   *
   * @param turn - The turn record
   * @param actionData - Parsed action JSON
   * @param outcomeData - Parsed outcome JSON
   * @returns Expected output string
   */
  private buildExpectedOutput(
    turn: TurnRecordRow,
    actionData: Record<string, unknown>,
    outcomeData: Record<string, unknown>
  ): string {
    // For tool calls, include the tool invocation
    if (turn.action_type === "tool_call") {
      return JSON.stringify({
        toolName: actionData.toolName ?? turn.target_skill,
        params: actionData.params ?? {},
        result: outcomeData.resultPreview ?? outcomeData,
      });
    }

    // For responses, use the text preview or full outcome
    return (outcomeData.textPreview as string) ?? JSON.stringify(outcomeData);
  }

  /**
   * Assess difficulty level based on input length heuristic.
   *
   * - Short (< 100 chars) → easy
   * - Long (> 500 chars) → hard
   * - Medium (100-500 chars) → medium
   *
   * @param input - The user input message
   * @returns Difficulty level: 'easy', 'medium', or 'hard'
   */
  private assessDifficulty(input: string): 'easy' | 'medium' | 'hard' {
    const length = input.length;
    if (length < 100) {
      return 'easy';
    }
    if (length > 500) {
      return 'hard';
    }
    return 'medium';
  }

  /**
   * Compute score from a turn record (internal helper).
   *
   * @param turn - The turn record to score
   * @returns Quality score between 0 and 1
   */
  private scoreEntryFromTurn(turn: TurnRecordRow): number {
    let score = 0.5;

    // Outcome type
    if (turn.outcome_type === "success") {
      score += 0.3;
    } else if (turn.outcome_type === "partial") {
      score += 0.1;
    } else if (turn.outcome_type === "error") {
      score -= 0.3;
    }

    // Reward signal
    if (turn.reward_signal !== undefined && turn.reward_signal !== null) {
      score += turn.reward_signal * 0.2;
    }

    // Has target skill
    if (turn.target_skill) {
      score += 0.1;
    }

    // Input quality
    if (turn.user_message.length > 10) {
      score += 0.05;
    }
    if (turn.user_message.length > 100) {
      score += 0.05;
    }

    return Math.max(0, Math.min(1, score));
  }
}
