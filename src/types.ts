/**
 * OpenClaw Self-Evolution Pipeline - Core Type Definitions
 * 
 * Phase 1/2 types only - minimal set needed for trajectory logging
 * and evolution pipeline foundation.
 */

// ============================================================================
// Configuration Types
// ============================================================================

/** Trajectory collection configuration */
export interface TrajectoryConfig {
  enabled: boolean;
  sampleRate: number;
  maxTurnsPerSession: number;
}

/** Evolution engine configuration */
export interface EvolutionEngineConfig {
  autoRun: boolean;
  maxGenerations: number;
  populationSize: number;
  mutationRate: number;
  eliteSize: number;
  targetSkills: string[];
  useDspyBridge: boolean;
  schedule: {
    cron: string;
  };
  // G3: DSPy as primary optimizer (hybrid architecture)
  useDspyPrimary?: boolean;        // Default false — use DSPy GEPA as main loop
  preWarmGenerations?: number;     // Generations before DSPy (default 2)
  dspyIterations?: number;         // GEPA max_steps (default 10)
}

/** Cost control limits for evolution runs */
export interface CostLimits {
  maxTokensPerRun: number;
  maxCostPerRun: number;
  maxConcurrentRuns: number;
}

/** Size and length limits for skill content */
export interface SizeLimitsConfig {
  maxSkillSizeBytes?: number;   // default 15_000
  maxDescriptionLength?: number; // default 500
  maxSectionCount?: number;      // default 20
}

/** Storage configuration paths */
export interface StorageConfig {
  trajectoryDbPath?: string;
  datasetPath?: string;
  evolutionLogPath?: string;
}

/**
 * LLM configuration for a single component.
 * All fields are optional; defaults maintain backward compatibility.
 */
export interface LlmConfig {
  /** Model name (default: "MiniMax-M2.7") */
  model?: string;
  /** API base URL (default: "https://api.minimax.io") */
  apiBase?: string;
  /** Environment variable name for API key (default: "MINIMAX_API_KEY") */
  apiKeyEnvVar?: string;
  /** Temperature for generation (default: component-specific) */
  temperature?: number;
  /** Max tokens for generation (default: component-specific) */
  maxTokens?: number;
}

/**
 * Per-component LLM configuration for the evolution pipeline.
 */
export interface EvolutionLlmConfig {
  /** LLM judge for fitness scoring (src/evolution/fitness/llm-judge.ts) */
  judge?: LlmConfig;
  /** Synthetic test case generator (src/dataset/synthetic-generator.ts) */
  generator?: LlmConfig;
  /** Trajectory outcome labeler (src/collection/outcome-labeler.ts) */
  labeler?: LlmConfig;
  /** Relevance filter for external importers (src/dataset/external-importers/relevance-filter.ts) */
  relevance?: LlmConfig;
  /** DSPy bridge configuration (python/dspy_bridge.py) */
  dspy?: LlmConfig;
}

/** Main plugin configuration interface */
export interface EvolutionConfig {
  enabled: boolean;
  trajectory: TrajectoryConfig;
  evolution: EvolutionEngineConfig;
  costLimits: CostLimits;
  sizeLimits?: SizeLimitsConfig;
  retentionDays: number;
  storage: StorageConfig;
  /** Per-component LLM configuration (optional, defaults to MiniMax-M2.7) */
  llm?: EvolutionLlmConfig;
}

// ============================================================================
// Trajectory & Episode Types (Runtime)
// ============================================================================

/** Represents a single turn/interaction in an agent session */
export interface TurnRecord {
  id: string;
  sessionKey: string;
  turnNumber: number;
  episodeId: string;
  timestamp: Date;
  systemPrompt?: string;
  userMessage: string;
  contextJson?: Record<string, unknown>;
  actionType: 'tool_call' | 'response' | 'error' | 'subagent_spawn';
  actionJson: Record<string, unknown>;
  outcomeType: 'success' | 'failure' | 'partial' | 'error';
  outcomeJson: Record<string, unknown>;
  rewardSignal?: number;
  skillsUsed: string[];
  targetSkill?: string;
}

/** Represents a complete episode (task execution) consisting of multiple turns */
export interface EpisodeRecord {
  id: string;
  sessionKey: string;
  startedAt: Date;
  completedAt?: Date;
  turns: TurnRecord[];
  outcome: 'success' | 'failure' | 'partial';
  skillsInvolved: string[];
  totalReward: number;
}

/** A trajectory is a sequence of episodes used for training */
export interface Trajectory {
  id: string;
  source: string;
  recordedAt: Date;
  episodes: EpisodeRecord[];
  metadata: {
    episodeCount: number;
    totalTurns: number;
    skillsObserved: string[];
    averageReward: number;
  };
}

// ============================================================================
// Persisted Row Types (DB shapes - no Date objects)
// ============================================================================

/**
 * Turn record as stored in the database.
 * Dates are ISO strings for JSON serialization.
 */
export interface TurnRecordRow {
  id: string;
  session_key: string;
  turn_number: number;
  episode_id: string;
  timestamp: string; // ISO 8601
  system_prompt?: string;
  user_message: string;
  context_json?: string; // JSON string
  action_type: 'tool_call' | 'response' | 'error' | 'subagent_spawn';
  action_json: string; // JSON string
  outcome_type: 'success' | 'failure' | 'partial' | 'error';
  outcome_json: string; // JSON string
  reward_signal?: number;
  skills_used: string; // JSON array string
  target_skill?: string;
}

/**
 * Episode record as stored in the database.
 * Dates are ISO strings for JSON serialization.
 */
export interface EpisodeRecordRow {
  id: string;
  session_key: string;
  started_at: string; // ISO 8601
  completed_at?: string; // ISO 8601
  outcome: 'success' | 'failure' | 'partial';
  skills_involved: string; // JSON array string
  total_reward: number;
}

/**
 * Trajectory metadata as stored in the database.
 * Dates are ISO strings for JSON serialization.
 */
export interface TrajectoryRow {
  id: string;
  source: string;
  recorded_at: string; // ISO 8601
  episode_count: number;
  total_turns: number;
  skills_observed: string; // JSON array string
  average_reward: number;
}

// ============================================================================
// Evolution & Variant Types (Phase 2)
// ============================================================================

/** Represents a variant of a skill being evolved */
export interface SkillVariant {
  id: string;
  skillName: string;
  generation: number;
  content: string;
  mutations: Mutation[];
  fitnessScore?: FitnessScore;
  parents: string[];
  createdAt: Date;
}

/** Represents a single mutation applied to a skill */
export interface Mutation {
  type: 'prompt_rewrite' | 'example_add' | 'example_remove' | 'parameter_tweak' | 'structure_change';
  description: string;
  location?: string;
  original?: string;
  modified?: string;
}

/** Evolution run status */
export type EvolutionStatus = 
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** Represents an evolution run (a complete optimization process) */
export interface EvolutionRun {
  id: string;
  skillName: string;
  skillPath?: string;
  status: EvolutionStatus;
  config: EvolutionEngineConfig;
  currentGeneration: number;
  maxGenerations: number;
  variants: SkillVariant[];
  bestVariant?: SkillVariant;
  progress: EvolutionProgress;
  startedAt: Date;
  completedAt?: Date;
  errorMessage?: string;
}

/** Evolution progress tracking */
export interface EvolutionProgress {
  currentGeneration: number;
  totalGenerations: number;
  variantsEvaluated: number;
  totalVariants: number;
  bestFitnessScore: number;
  averageFitnessScore: number;
  estimatedTimeRemaining?: number;
}

/** Fitness score for a skill variant */
export interface FitnessScore {
  /** 0-100 scale (weighted sum of rubric criterion scores) */
  overall: number;
  components: FitnessComponents;
  /** Actionable feedback for GEPA's reflective analysis */
  feedback?: string;
  evaluatedAt: Date;
  method: 'llm_judge' | 'automated_test' | 'human_review';
  rawScores: Record<string, number>;
}

/** Component scores for fitness evaluation (outcome-focused, matching Hermes) */
export interface FitnessComponents {
  correctness: number;          // 0-100: Did the agent produce correct output?
  procedureFollowing: number;   // 0-100: Did it follow the skill's procedure?
  conciseness: number;          // 0-100: Was it appropriately concise?
}

// ============================================================================
// Persisted Evolution Row Types (DB shapes - no Date objects)
// ============================================================================

/** Skill variant as stored in the database */
export interface SkillVariantRow {
  id: string;
  skill_name: string;
  generation: number;
  content: string;
  mutations: string; // JSON string
  fitness_overall?: number;
  parents: string; // JSON array string
  created_at: string; // ISO 8601
}

/** Evolution run as stored in the database */
export interface EvolutionRunRow {
  id: string;
  skill_name: string;
  skill_path?: string;
  status: EvolutionStatus;
  config: string; // JSON string
  current_generation: number;
  max_generations: number;
  best_variant_id?: string;
  best_variant_content?: string;
  progress: string; // JSON string
  started_at: string; // ISO 8601
  completed_at?: string; // ISO 8601
  error_message?: string;
}

/** Fitness score as stored in the database */
export interface FitnessScoreRow {
  variant_id: string;
  overall: number;
  components: string; // JSON string
  evaluated_at: string; // ISO 8601
  method: 'llm_judge' | 'automated_test' | 'human_review';
  raw_scores: string; // JSON string
}

// ============================================================================
// Utility Types
// ============================================================================

/** Result type for operations that can fail */
export interface Result<T, E = Error> {
  success: boolean;
  data?: T;
  error?: E;
}

/** Paginated query result */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** Time range for queries */
export interface TimeRange {
  start: Date;
  end: Date;
}

/** Time range for persisted queries (ISO strings) */
export interface TimeRangeRow {
  start: string; // ISO 8601
  end: string; // ISO 8601
}

/** Filter options for trajectory queries */
export interface TrajectoryFilter {
  skillName?: string;
  sessionKey?: string;
  timeRange?: TimeRange;
  outcomeType?: EpisodeRecord['outcome'];
  minReward?: number;
  maxReward?: number;
}

// ============================================================================
// Dataset Types (for Training Data Management)
// ============================================================================

/** Dataset status lifecycle */
export type DatasetStatus =
  | 'draft'
  | 'ready'
  | 'archived'
  | 'deleted';

/** Metadata for a training dataset */
export interface DatasetMetadata {
  name: string;
  description?: string;
  skillTarget?: string;
  entryCount: number;
  createdAt: Date;
  status: DatasetStatus;
}

/** Metadata for a dataset entry (Hermes-style for GEPA) */
export interface DatasetEntryMetadata {
  // Source tracking
  source?: 'synthetic' | 'golden' | 'claude-code' | 'copilot' | 'openclaw';

  // Hermes-style metadata for GEPA
  difficulty?: 'easy' | 'medium' | 'hard';
  category?: string;
  expectedBehavior?: string;  // Rubric for LLM judge (richer than exact expectedOutput)

  // Legacy fields
  outcomeType?: string;
  rewardSignal?: number;
}

/** A single training example in a dataset */
export interface DatasetEntry {
  id: string;
  datasetId: string;
  input: string;
  expectedOutput: string;
  context?: Record<string, unknown>;
  score?: number;
  metadata?: DatasetEntryMetadata;  // Typed
  createdAt: Date;
}

/** Manifest for a versioned dataset */
export interface DatasetManifest {
  id: string;
  name: string;
  version: number;
  metadata: DatasetMetadata;
  entryCount: number;
  status: DatasetStatus;
  createdAt: Date;
  updatedAt: Date;
}

/** Dataset manifest as stored in the database (ISO dates) */
export interface DatasetManifestRow {
  id: string;
  name: string;
  version: number;
  status: DatasetStatus;
  metadata_json: string; // JSON string
  entry_count: number;
  created_at: string; // ISO 8601
  updated_at: string; // ISO 8601
}

/** Dataset entry as stored in the database (ISO dates) */
export interface DatasetEntryRow {
  id: string;
  dataset_id: string;
  input: string;
  expected_output: string;
  context_json?: string; // JSON string
  score?: number;
  metadata_json?: string; // JSON string
  created_at: string; // ISO 8601
}

// ============================================================================
// Metrics Reporter Types (Phase 7B)
// ============================================================================

/** Human-readable metrics summary for evolution runs */
export interface EvolutionMetrics {
  skillName: string;
  runId: string;
  status: EvolutionStatus;
  generationsCompleted: number;
  maxGenerations: number;
  totalVariantsEvaluated: number;
  bestFitnessScore: number;
  baselineFitnessScore: number;
  improvement: number;
  improvementPercent: string;
  durationMs: number;
  stoppedEarly: boolean;
  stopReason?: string;
}

// ============================================================================
// Git Manager Types (Deployment - Phase 7A)
// ============================================================================

/** Configuration for the GitManager */
export interface GitManagerConfig {
  /** Path to the git repository containing skills (default: ~/.openclaw/skills) */
  repoPath: string;
  /** Remote name for pushing branches (default: "origin") */
  remote?: string;
  /** Base branch to fork evolution branches from (default: "main") */
  baseBranch?: string;
}

/** Result of applying a variant to a branch */
export interface BranchResult {
  branchName: string;
  commitSha: string;
  pushed: boolean;
}

// ============================================================================
// Review Queue Types (Deployment - Phase 7D)
// ============================================================================

/** Review queue item combining PR record with queue metadata */
export interface ReviewQueueItem {
  pr: PrRecord;
  queuedAt: string; // ISO 8601 — when it entered the queue
  priority: number; // higher = more urgent (default 0)
}

// ============================================================================
// PR Builder Types (Deployment - Phase 7C)
// ============================================================================

/** PR record stored in SQLite for the review queue */
export interface PrRecord {
  id: string;
  skillName: string;
  runId: string;
  branchName: string;
  commitSha: string;
  pushed: boolean;
  title: string;
  body: string;
  status: "pending" | "approved" | "rejected" | "merged";
  createdAt: string; // ISO 8601
  reviewedAt?: string; // ISO 8601
  reviewNote?: string; // reviewer comment
}

// ============================================================================
// SDK Hook Result Types
// ============================================================================

/** Result type for before_tool_call hook - allows blocking/approving tool calls */
export interface PluginHookBeforeToolCallResult {
  /** Override parameters for the tool call */
  params?: Record<string, unknown>;
  /** If true, block the tool call */
  block?: boolean;
  /** If blocking, provide a reason */
  blockReason?: string;
  /** Require approval before allowing the tool call */
  requireApproval?: {
    title: string;
    description: string;
    severity?: "info" | "warning" | "critical";
    timeoutMs?: number;
    timeoutBehavior?: "allow" | "deny";
    pluginId?: string;
    onResolution?: (decision: "allow-once" | "allow-always" | "deny" | "timeout" | "cancelled") => Promise<void> | void;
  };
}
