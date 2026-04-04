/**
 * OpenClaw Self-Evolution Pipeline - Skill Usage Analyzer
 * 
 * Tracks which skills are used when, and builds usage statistics for the
 * evolution pipeline to target.
 * 
 * Design decisions based on:
 - OpenClaw plugin patterns: /home/stormhierta/.npm-global/lib/node_modules/openclaw/dist/extensions/
 - OpenClaw plugin docs: /home/stormhierta/.npm-global/lib/node_modules/openclaw/docs/plugins/
 - Existing types: src/types.ts (TurnRecordRow, EpisodeRecordRow, TimeRangeRow)
 * 
 * Uses better-sqlite3 patterns matching SessionMiner and TrajectoryLogger.
 */

import type {
  EvolutionConfig,
  TurnRecordRow,
  EpisodeRecordRow,
  TimeRangeRow,
} from "../types.js";
import type { SessionMiner } from "./session-miner.js";
import type { TrajectoryLogger } from "./trajectory-logger.js";

// ============================================================================
// Skill Usage Types
// ============================================================================

/**
 * Statistics for a specific skill's usage patterns.
 * Tracks invocation frequency, success metrics, and trigger patterns.
 */
export interface SkillUsageStats {
  /** Name of the skill being analyzed */
  name: string;
  /** Total number of times the skill was invoked */
  invocationCount: number;
  /** Number of unique sessions where the skill was used */
  uniqueSessions: number;
  /** Average reward signal across all invocations (0-1 scale) */
  avgRewardSignal: number;
  /** Percentage of invocations that succeeded (0-1 scale) */
  successRate: number;
  /** ISO timestamp of the most recent usage */
  lastUsedAt: string;
  /** Most common prompt patterns that triggered this skill */
  topTriggerPatterns: InvocationPattern[];
}

/**
 * A skill candidate for evolution prioritization.
 * High usage + lower reward = good candidate for improvement.
 */
export interface SkillCandidate {
  /** Name of the skill */
  skillName: string;
  /** Priority score (higher = more urgent to evolve) */
  priorityScore: number;
  /** Human-readable explanation of why this skill is a candidate */
  reason: string;
}

/**
 * A recurring pattern in user prompts that triggers a skill.
 * Used to identify common use cases and potential skill improvements.
 */
export interface InvocationPattern {
  /** The normalized pattern (e.g., "search for *", "get weather in *") */
  pattern: string;
  /** How many times this pattern was observed */
  frequency: number;
  /** Average reward signal for invocations matching this pattern */
  avgReward: number;
}

// ============================================================================
// Internal Types
// ============================================================================

/** Raw skill usage data from database queries */
interface RawSkillUsage {
  skillName: string;
  invocationCount: number;
  uniqueSessions: number;
  avgReward: number;
  successCount: number;
  failureCount: number;
  errorCount: number;
  lastUsedAt: string;
}

/** Pattern extraction result */
interface ExtractedPattern {
  pattern: string;
  reward: number;
  userMessage: string;
}

// ============================================================================
// Skill Usage Analyzer
// ============================================================================

/**
 * Analyzes skill usage patterns from trajectory data.
 * 
 * Provides statistics on skill invocations, success rates, and identifies
 * high-priority candidates for evolution based on usage frequency and
 * reward signals.
 * 
 * Source: Pattern matching SessionMiner query patterns (src/collection/session-miner.ts)
 * Source: Type definitions from src/types.ts (TurnRecordRow, TimeRangeRow)
 */
export class SkillUsageAnalyzer {
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

  // ============================================================================
  // Public API
  // ============================================================================

  /**
   * Analyze usage statistics for a specific skill.
   * 
   * Returns comprehensive metrics including invocation count, success rate,
   * average reward, and common trigger patterns.
   * 
   * @param skillName - Name of the skill to analyze
   * @param timeRange - Optional time range to limit the analysis
   * @returns Skill usage statistics
   */
  async analyzeSkillUsage(
    skillName: string,
    timeRange?: TimeRangeRow
  ): Promise<SkillUsageStats> {
    // Query turns for this skill
    const turns = await this.querySkillTurns(skillName, timeRange);

    if (turns.length === 0) {
      return {
        name: skillName,
        invocationCount: 0,
        uniqueSessions: 0,
        avgRewardSignal: 0,
        successRate: 0,
        lastUsedAt: new Date(0).toISOString(),
        topTriggerPatterns: [],
      };
    }

    // Calculate basic statistics
    const uniqueSessions = new Set(turns.map((t) => t.session_key));
    const rewardSum = turns.reduce(
      (sum, t) => sum + (t.reward_signal ?? 0),
      0
    );
    const successCount = turns.filter(
      (t) => t.outcome_type === "success"
    ).length;

    // Extract and analyze patterns
    const patterns = this.extractPatternsFromTurns(turns);
    const topPatterns = this.aggregatePatterns(patterns);

    // Find last used timestamp
    const lastUsedAt = turns.reduce((latest, t) => {
      return t.timestamp > latest ? t.timestamp : latest;
    }, turns[0]?.timestamp ?? new Date(0).toISOString());

    return {
      name: skillName,
      invocationCount: turns.length,
      uniqueSessions: uniqueSessions.size,
      avgRewardSignal: turns.length > 0 ? rewardSum / turns.length : 0,
      successRate: turns.length > 0 ? successCount / turns.length : 0,
      lastUsedAt,
      topTriggerPatterns: topPatterns.slice(0, 5),
    };
  }

  /**
   * Get top skill candidates for evolution.
   * 
   * Skills are ranked by a priority score that considers:
   * - High usage frequency (more invocations = higher impact)
   * - Lower reward signals (room for improvement)
   * - Lower success rates (problematic skills)
   * 
   * @param limit - Maximum number of candidates to return (default: 10)
   * @returns Array of skill candidates ranked by priority
   */
  async getTopSkillCandidates(limit = 10): Promise<SkillCandidate[]> {
    const invocationMap = await this.buildSkillInvocationMap();
    const candidates: SkillCandidate[] = [];

    for (const [skillName, invocationCount] of invocationMap.entries()) {
      // Skip skills with too few invocations to be meaningful
      if (invocationCount < 5) {
        continue;
      }

      const stats = await this.analyzeSkillUsage(skillName);

      // Calculate priority score:
      // - High usage increases priority (more impact)
      // - Low reward increases priority (room for improvement)
      // - Low success rate increases priority (problematic)
      const usageScore = Math.min(invocationCount / 100, 1.0); // Cap at 100 invocations
      const rewardPenalty = 1 - stats.avgRewardSignal; // Lower reward = higher penalty
      const failurePenalty = 1 - stats.successRate; // Lower success = higher penalty

      // Weighted combination: usage matters, but poor performance matters more
      const priorityScore =
        usageScore * 0.3 + rewardPenalty * 0.4 + failurePenalty * 0.3;

      // Generate reason string
      const reasons: string[] = [];
      if (invocationCount > 50) {
        reasons.push(`high usage (${invocationCount} invocations)`);
      }
      if (stats.avgRewardSignal < 0.5) {
        reasons.push(`low reward (${(stats.avgRewardSignal * 100).toFixed(1)}%)`);
      }
      if (stats.successRate < 0.7) {
        reasons.push(`low success rate (${(stats.successRate * 100).toFixed(1)}%)`);
      }

      if (reasons.length > 0) {
        candidates.push({
          skillName,
          priorityScore: Math.round(priorityScore * 1000) / 1000,
          reason: reasons.join(", "),
        });
      }
    }

    // Sort by priority score descending
    candidates.sort((a, b) => b.priorityScore - a.priorityScore);

    return candidates.slice(0, limit);
  }

  /**
   * Build a map of skill names to their invocation counts.
   * 
   * @returns Map from skill name to number of invocations
   */
  async buildSkillInvocationMap(): Promise<Map<string, number>> {
    const turns = await this.queryAllTurns();
    const skillCounts = new Map<string, number>();

    for (const turn of turns) {
      // Parse skills_used JSON array
      let skills: string[] = [];
      try {
        skills = JSON.parse(turn.skills_used) as string[];
      } catch {
        // If parsing fails, treat as single skill
        skills = turn.skills_used ? [turn.skills_used] : [];
      }

      // Also include target_skill if present
      if (turn.target_skill && !skills.includes(turn.target_skill)) {
        skills.push(turn.target_skill);
      }

      for (const skill of skills) {
        const normalizedSkill = skill.toLowerCase().trim();
        if (normalizedSkill) {
          const current = skillCounts.get(normalizedSkill) ?? 0;
          skillCounts.set(normalizedSkill, current + 1);
        }
      }
    }

    return skillCounts;
  }

  /**
   * Detect recurring invocation patterns for a specific skill.
   * 
   * Analyzes user messages to find common patterns that trigger the skill,
   * which can inform skill improvements or documentation updates.
   * 
   * @param skillName - Name of the skill to analyze
   * @returns Array of invocation patterns sorted by frequency
   */
  async detectSkillPatterns(skillName: string): Promise<InvocationPattern[]> {
    const turns = await this.querySkillTurns(skillName);
    const extracted = this.extractPatternsFromTurns(turns);
    return this.aggregatePatterns(extracted);
  }

  // ============================================================================
  // Private Helpers
  // ============================================================================

  /**
   * Query turns for a specific skill with optional time filtering.
   * 
   * Source: Pattern matching SessionMiner.queryTurns() (src/collection/session-miner.ts)
   */
  private async querySkillTurns(
    skillName: string,
    timeRange?: TimeRangeRow
  ): Promise<TurnRecordRow[]> {
    // Try trajectory logger first (our own database)
    try {
      const filter: {
        skillName: string;
        timeRange?: { start: Date; end: Date };
      } = { skillName };

      if (timeRange) {
        filter.timeRange = {
          start: new Date(timeRange.start),
          end: new Date(timeRange.end),
        };
      }

      const turns = await this.trajectoryLogger.query(filter);
      if (turns.length > 0) {
        return turns;
      }
    } catch {
      // Fall through to session miner
    }

    // Fall back to session miner
    try {
      const filter: {
        skillName: string;
        timeRange?: { start: Date; end: Date };
      } = { skillName };

      if (timeRange) {
        filter.timeRange = {
          start: new Date(timeRange.start),
          end: new Date(timeRange.end),
        };
      }

      return await this.sessionMiner.queryTurns(filter);
    } catch {
      return [];
    }
  }

  /**
   * Query all turns from both data sources.
   */
  private async queryAllTurns(): Promise<TurnRecordRow[]> {
    const turns: TurnRecordRow[] = [];

    // Try trajectory logger first
    try {
      const loggerTurns = await this.trajectoryLogger.query();
      turns.push(...loggerTurns);
    } catch {
      // Ignore errors
    }

    // Also query session miner if we need more data
    if (turns.length < 1000) {
      try {
        const minerTurns = await this.sessionMiner.queryTurns();
        turns.push(...minerTurns);
      } catch {
        // Ignore errors
      }
    }

    return turns;
  }

  /**
   * Extract patterns from user messages in turns.
   * 
   * Uses simple pattern normalization:
   * - Replace quoted strings with wildcards
   * - Replace numbers with wildcards
   * - Normalize whitespace
   */
  private extractPatternsFromTurns(turns: TurnRecordRow[]): ExtractedPattern[] {
    const patterns: ExtractedPattern[] = [];

    for (const turn of turns) {
      const pattern = this.normalizeMessagePattern(turn.user_message);
      patterns.push({
        pattern,
        reward: turn.reward_signal ?? 0,
        userMessage: turn.user_message,
      });
    }

    return patterns;
  }

  /**
   * Normalize a user message into a pattern.
   * 
   * Examples:
   * - "search for cats" -> "search for *"
   * - "get weather in London" -> "get weather in *"
   * - "calculate 2 + 2" -> "calculate * + *"
   */
  private normalizeMessagePattern(message: string): string {
    if (!message) {
      return "";
    }

    let pattern = message.toLowerCase().trim();

    // Replace quoted strings with *
    pattern = pattern.replace(/"[^"]*"/g, '"*"');
    pattern = pattern.replace(/'[^']*'/g, "'*'");

    // Replace numbers with *
    pattern = pattern.replace(/\b\d+\.?\d*\b/g, "*");

    // Replace URLs with *
    pattern = pattern.replace(
      /https?:\/\/[^\s]+/g,
      "*"
    );

    // Replace email addresses with *
    pattern = pattern.replace(
      /\b[\w.-]+@[\w.-]+\.\w+\b/g,
      "*"
    );

    // Replace file paths with *
    pattern = pattern.replace(
      /\b[\w/.-]+\.[a-zA-Z0-9]+\b/g,
      "*"
    );

    // Normalize multiple spaces
    pattern = pattern.replace(/\s+/g, " ");

    // Limit length
    if (pattern.length > 100) {
      pattern = pattern.slice(0, 100) + "...";
    }

    return pattern;
  }

  /**
   * Aggregate extracted patterns into frequency-ranked InvocationPatterns.
   */
  private aggregatePatterns(extracted: ExtractedPattern[]): InvocationPattern[] {
    const patternMap = new Map<
      string,
      { frequency: number; rewardSum: number }
    >();

    for (const { pattern, reward } of extracted) {
      if (!pattern) {
        continue;
      }

      const existing = patternMap.get(pattern);
      if (existing) {
        existing.frequency++;
        existing.rewardSum += reward;
      } else {
        patternMap.set(pattern, { frequency: 1, rewardSum: reward });
      }
    }

    // Convert to array and calculate averages
    const aggregated: InvocationPattern[] = [];
    for (const [pattern, data] of patternMap.entries()) {
      aggregated.push({
        pattern,
        frequency: data.frequency,
        avgReward:
          data.frequency > 0 ? data.rewardSum / data.frequency : 0,
      });
    }

    // Sort by frequency descending
    aggregated.sort((a, b) => b.frequency - a.frequency);

    return aggregated;
  }

  /**
   * Calculate success rate from outcome types.
   */
  private calculateSuccessRate(turns: TurnRecordRow[]): number {
    if (turns.length === 0) {
      return 0;
    }

    const successCount = turns.filter(
      (t) => t.outcome_type === "success"
    ).length;
    return successCount / turns.length;
  }
}
