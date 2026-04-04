/**
 * OpenClaw Self-Evolution Pipeline - Collection Module
 * 
 * Exports trajectory data collection components:
 * - SessionMiner: Queries OpenClaw session store for historical data
 * - TrajectoryLogger: Persists trajectory data to SQLite
 * - SkillUsageAnalyzer: Analyzes skill usage patterns for evolution targeting
 */

export { SessionMiner } from "./session-miner.js";
export { TrajectoryLogger } from "./trajectory-logger.js";
export { SkillUsageAnalyzer } from "./skill-usage-analyzer.js";
export type {
  SkillUsageStats,
  SkillCandidate,
  InvocationPattern,
} from "./skill-usage-analyzer.js";
