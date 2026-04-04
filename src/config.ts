/**
 * OpenClaw Self-Evolution Pipeline - Configuration Schema
 * 
 * Zod schema for validating the EvolutionConfig type.
 */

import { z } from "zod";
import type { EvolutionConfig } from "./types.js";

// ============================================================================
// Nested Config Schemas
// ============================================================================

/**
 * Trajectory collection configuration schema
 */
export const TrajectoryConfigSchema = z.object({
  enabled: z.boolean().default(true),
  sampleRate: z.number().min(0).max(1).default(1.0),
  maxTurnsPerSession: z.number().int().min(1).default(1000),
}).strict();

/**
 * Evolution engine configuration schema
 */
export const EvolutionEngineConfigSchema = z.object({
  autoRun: z.boolean().default(false),
  maxGenerations: z.number().int().min(1).default(10),
  populationSize: z.number().int().min(2).default(20),
  mutationRate: z.number().min(0).max(1).default(0.3),
  eliteSize: z.number().int().min(0).default(2),
  targetSkills: z.array(z.string()).default([]),
  useDspyBridge: z.boolean().default(false),
  schedule: z.object({
    cron: z.string().default("0 2 * * *"),
  }).strict().default({}),
  // G3: DSPy as primary optimizer (hybrid architecture)
  useDspyPrimary: z.boolean().default(false),
  preWarmGenerations: z.number().int().min(0).default(2),
  dspyIterations: z.number().int().min(1).default(10),
}).strict();

/**
 * Cost control limits schema
 */
export const CostLimitsSchema = z.object({
  maxTokensPerRun: z.number().int().min(1).default(1_000_000),
  maxCostPerRun: z.number().min(0).default(50.0),
  maxConcurrentRuns: z.number().int().min(1).default(2),
}).strict();

/**
 * Storage configuration schema
 */
export const StorageConfigSchema = z.object({
  trajectoryDbPath: z.string().optional(),
  datasetPath: z.string().optional(),
  evolutionLogPath: z.string().optional(),
}).strict();

/**
 * LLM configuration schema for a single component
 */
export const LlmConfigSchema = z.object({
  model: z.string().optional(),
  apiBase: z.string().optional(),
  apiKeyEnvVar: z.string().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().int().optional(),
}).strict();

/**
 * Per-component LLM configuration schema
 */
export const EvolutionLlmConfigSchema = z.object({
  judge: LlmConfigSchema.optional(),
  generator: LlmConfigSchema.optional(),
  labeler: LlmConfigSchema.optional(),
  relevance: LlmConfigSchema.optional(),
  dspy: LlmConfigSchema.optional(),
}).strict();

// ============================================================================
// Main Config Schema
// ============================================================================

/**
 * Full evolution plugin configuration schema
 */
export const SizeLimitsSchema = z.object({
  maxSkillSizeBytes: z.number().int().min(1).optional(),
  maxDescriptionLength: z.number().int().min(1).optional(),
  maxSectionCount: z.number().int().min(1).optional(),
}).strict();

export const EvolutionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  trajectory: TrajectoryConfigSchema.default({}),
  evolution: EvolutionEngineConfigSchema.default({}),
  costLimits: CostLimitsSchema.default({}),
  sizeLimits: SizeLimitsSchema.optional(),
  retentionDays: z.number().int().min(1).default(90),
  storage: StorageConfigSchema.default({}),
  llm: EvolutionLlmConfigSchema.optional(),
}).strict();

// ============================================================================
// Inferred Types from Schemas
// ============================================================================

/** Inferred type for parsed trajectory config */
export type ParsedTrajectoryConfig = z.infer<typeof TrajectoryConfigSchema>;

/** Inferred type for parsed evolution engine config */
export type ParsedEvolutionEngineConfig = z.infer<typeof EvolutionEngineConfigSchema>;

/** Inferred type for parsed cost limits */
export type ParsedCostLimits = z.infer<typeof CostLimitsSchema>;

/** Inferred type for parsed storage config */
export type ParsedStorageConfig = z.infer<typeof StorageConfigSchema>;

/** Inferred type for parsed evolution config */
export type ParsedEvolutionConfig = z.infer<typeof EvolutionConfigSchema>;

/** Inferred type for parsed LLM config */
export type ParsedLlmConfig = z.infer<typeof LlmConfigSchema>;

/** Inferred type for parsed evolution LLM config */
export type ParsedEvolutionLlmConfig = z.infer<typeof EvolutionLlmConfigSchema>;

// ============================================================================
// Config Parsing Functions
// ============================================================================

/**
 * Parse and validate raw configuration into EvolutionConfig
 * @param raw - Unknown configuration object to validate
 * @returns Validated EvolutionConfig
 * @throws ZodError if validation fails
 */
export function parseConfig(raw: unknown): EvolutionConfig {
  return EvolutionConfigSchema.parse(raw) as EvolutionConfig;
}

/**
 * Safely parse raw configuration, returning success/failure result
 * @param raw - Unknown configuration object to validate
 * @returns SafeParseReturnType with data or error
 */
export function safeParseConfig(raw: unknown): z.SafeParseReturnType<unknown, EvolutionConfig> {
  return EvolutionConfigSchema.safeParse(raw) as z.SafeParseReturnType<unknown, EvolutionConfig>;
}

/**
 * Get default configuration values
 * @returns EvolutionConfig with all defaults applied
 */
export function getDefaultConfig(): EvolutionConfig {
  return EvolutionConfigSchema.parse({}) as EvolutionConfig;
}

/**
 * Merge partial config with defaults
 * @param partial - Partial configuration to merge
 * @returns Complete EvolutionConfig with defaults filled in
 */
export function mergeWithDefaults(partial: Partial<EvolutionConfig>): EvolutionConfig {
  return EvolutionConfigSchema.parse(partial) as EvolutionConfig;
}
