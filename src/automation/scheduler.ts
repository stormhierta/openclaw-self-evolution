/**
 * OpenClaw Self-Evolution Pipeline - Evolution Scheduler
 * 
 * P3-C: Scheduled auto-evolution that closes the autonomous loop.
 * 
 * Runs on a configurable interval and:
 * 1. Labels any unlabeled trajectories via OutcomeLabeler
 * 2. Checks all skills via EvolutionTrigger.checkAllSkills()
 * 3. For each skill that needs evolution (up to maxConcurrentRuns), 
 *    triggers an evolution run via EvolutionOptimizer.optimizeSkill()
 * 4. Creates PR records via PrBuilder.buildPr() for completed runs
 */

import type { EvolutionConfig } from "../types.js";
import type { EvolutionTrigger, TriggerDecision } from "./evolution-trigger.js";
import type { OutcomeLabeler } from "../collection/outcome-labeler.js";
import type { PrBuilder } from "../deployment/pr-builder.js";
import type { DatasetManager } from "../dataset/manager.js";
import { GEPAEvolver } from "../evolution/gepa/evolver.js";
import { EvolutionOptimizer } from "../evolution/optimizer.js";
import { DatasetBuilder } from "../dataset/builder.js";
import { RubricRegistry } from "../evolution/fitness/rubrics.js";
import { LlmJudge } from "../evolution/fitness/llm-judge.js";
import { SizeLimits } from "../validation/size-limits.js";
import { SkillValidator } from "../validation/skill-validator.js";
import { ConstraintValidator } from "../validation/constraint-validator.js";
import { DatasetSessionMiner } from "../dataset/session-miner.js";
import { SyntheticGenerator } from "../dataset/synthetic-generator.js";
import { GoldenSetLoader } from "../dataset/golden-sets.js";
import { SessionMiner } from "../collection/session-miner.js";
import { TrajectoryLogger } from "../collection/trajectory-logger.js";
import { TrajectoryHookHandler } from "../hooks/trajectory-hooks.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// Configuration Types
// ============================================================================

export interface SchedulerConfig {
  enabled: boolean;
  intervalMs: number;         // How often to check (default: 30 min = 1_800_000)
  minNewTurnsToTrigger: number; // Min labeled turns needed since last run (default: 20)
  maxSkillsPerCycle: number;  // Max skills to evolve per scheduler cycle (default: 1)
}

export interface SchedulerCycleResult {
  newLabels: number;
  skillsNeedingEvolution: number;
  skillsTriggered: string[];
  evolutionRunIds: string[];
  prIds: string[];
  errors: string[];
}

interface SkillLastRunInfo {
  timestamp: number;
  labeledTurnCount: number;
}

// ============================================================================
// EvolutionScheduler Class
// ============================================================================

export class EvolutionScheduler {
  private config: EvolutionConfig;
  private evolutionTrigger: EvolutionTrigger;
  private outcomeLabeler: OutcomeLabeler;
  private prBuilder: PrBuilder;
  private datasetManager: DatasetManager;
  
  // Scheduler state
  private schedulerConfig: SchedulerConfig;
  private isRunningFlag = false;
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private cycleInProgress = false;
  
  // Track last run info per skill for minNewTurnsToTrigger
  private lastRunInfo: Map<string, SkillLastRunInfo> = new Map();
  
  // Active evolution runs count for concurrency control
  private activeRuns = 0;

  constructor(
    config: EvolutionConfig,
    evolutionTrigger: EvolutionTrigger,
    outcomeLabeler: OutcomeLabeler,
    prBuilder: PrBuilder,
    datasetManager: DatasetManager
  ) {
    this.config = config;
    this.evolutionTrigger = evolutionTrigger;
    this.outcomeLabeler = outcomeLabeler;
    this.prBuilder = prBuilder;
    this.datasetManager = datasetManager;
    
    // Default scheduler config
    this.schedulerConfig = {
      enabled: false,
      intervalMs: 1_800_000, // 30 minutes
      minNewTurnsToTrigger: 20,
      maxSkillsPerCycle: 1,
    };
  }

  /**
   * Parse a simple minute-based cron expression (e.g., "* /30 * * * *") to milliseconds.
   * Falls back to 30 minutes if the cron is complex or invalid.
   * Note: space in "* /" is to avoid closing the comment.
   */
  private parseIntervalFromCron(cron: string): number {
    // Handle simple "*/N * * * *" pattern (every N minutes)
    // Regex: ^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$
    const match = cron.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
    if (match) {
      return parseInt(match[1], 10) * 60 * 1000;
    }
    return 30 * 60 * 1000; // default 30 min
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Start the scheduler with optional custom configuration.
   * Uses self-scheduling setTimeout pattern (same as startPeriodicFlush).
   */
  start(schedulerConfig?: Partial<SchedulerConfig>): void {
    // Merge provided config with defaults
    if (schedulerConfig) {
      this.schedulerConfig = {
        ...this.schedulerConfig,
        ...schedulerConfig,
      };
    }
    
    // Use cron config to determine interval if not explicitly provided
    const cronInterval = this.parseIntervalFromCron(this.config.evolution.schedule?.cron ?? "*/30 * * * *");
    this.schedulerConfig.intervalMs = schedulerConfig?.intervalMs ?? cronInterval;
    
    // Don't start if not enabled
    if (!this.schedulerConfig.enabled) {
      console.log("[evolution-scheduler] Scheduler not started: enabled=false");
      return;
    }
    
    // Don't start if already running
    if (this.isRunningFlag) {
      console.log("[evolution-scheduler] Scheduler already running");
      return;
    }
    
    this.isRunningFlag = true;
    console.log(`[evolution-scheduler] Starting scheduler (interval: ${this.schedulerConfig.intervalMs}ms)`);
    
    // Schedule first cycle
    this.scheduleNextCycle();
  }

  /**
   * Stop the scheduler.
   * Clears any pending timeout and sets isRunning to false.
   */
  stop(): void {
    this.isRunningFlag = false;
    
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    
    console.log("[evolution-scheduler] Scheduler stopped");
  }

  /**
   * Run one scheduler cycle manually (for testing/CLI).
   * This is the testable unit: label → check → evolve → PR.
   */
  async runCycle(): Promise<SchedulerCycleResult> {
    const result: SchedulerCycleResult = {
      newLabels: 0,
      skillsNeedingEvolution: 0,
      skillsTriggered: [],
      evolutionRunIds: [],
      prIds: [],
      errors: [],
    };

    // Prevent overlapping cycles
    if (this.cycleInProgress) {
      result.errors.push("Cycle already in progress");
      return result;
    }

    this.cycleInProgress = true;

    try {
      // Step 1: Label any unlabeled trajectories
      try {
        const unlabeledTurns = await this.outcomeLabeler.getUnlabeledTurns(undefined, 100);
        if (unlabeledTurns.length > 0) {
          const labelResults = await this.outcomeLabeler.labelBatch(unlabeledTurns);
          result.newLabels = labelResults.length;
          console.log(`[evolution-scheduler] Labeled ${result.newLabels} turns`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Labeling failed: ${msg}`);
        console.error(`[evolution-scheduler] Labeling error: ${msg}`);
      }

      // Step 2: Check all skills via EvolutionTrigger
      let skillsNeedingEvolution: TriggerDecision[] = [];
      try {
        skillsNeedingEvolution = await this.evolutionTrigger.checkAllSkills();
        result.skillsNeedingEvolution = skillsNeedingEvolution.length;
        console.log(`[evolution-scheduler] ${skillsNeedingEvolution.length} skills need evolution`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`Skill check failed: ${msg}`);
        console.error(`[evolution-scheduler] Skill check error: ${msg}`);
      }

      // Step 3: Filter skills based on minNewTurnsToTrigger
      const eligibleSkills = this.filterSkillsByNewTurns(skillsNeedingEvolution);
      
      // Step 4: Respect maxConcurrentRuns and maxSkillsPerCycle limits
      const maxConcurrent = this.config.costLimits.maxConcurrentRuns;
      const availableSlots = Math.max(0, maxConcurrent - this.activeRuns);
      const skillsToEvolve = eligibleSkills.slice(0, Math.min(availableSlots, this.schedulerConfig.maxSkillsPerCycle));

      console.log(`[evolution-scheduler] Will evolve ${skillsToEvolve.length} skills (slots: ${availableSlots}, maxPerCycle: ${this.schedulerConfig.maxSkillsPerCycle})`);

      // Step 5: Trigger evolution for each skill
      for (const decision of skillsToEvolve) {
        try {
          const evolutionResult = await this.triggerEvolution(decision);
          if (evolutionResult) {
            result.skillsTriggered.push(decision.skillName);
            result.evolutionRunIds.push(evolutionResult.runId);
            if (evolutionResult.prId) {
              result.prIds.push(evolutionResult.prId);
            }
            
            // Update last run info for this skill
            this.lastRunInfo.set(decision.skillName, {
              timestamp: Date.now(),
              labeledTurnCount: decision.currentPerformance.totalTurns,
            });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          result.errors.push(`Evolution failed for ${decision.skillName}: ${msg}`);
          console.error(`[evolution-scheduler] Evolution error for ${decision.skillName}: ${msg}`);
        }
      }

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`Cycle failed: ${msg}`);
      console.error(`[evolution-scheduler] Cycle error: ${msg}`);
    } finally {
      this.cycleInProgress = false;
    }

    return result;
  }

  /**
   * Check if the scheduler is currently running (scheduled).
   */
  isRunning(): boolean {
    return this.isRunningFlag;
  }

  /**
   * Check if a cycle is currently in progress.
   */
  isCycleInProgress(): boolean {
    return this.cycleInProgress;
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Schedule the next cycle using setTimeout.
   * Self-scheduling pattern - re-schedules itself after each cycle.
   */
  private scheduleNextCycle(): void {
    if (!this.isRunningFlag) {
      return;
    }

    this.timeoutId = setTimeout(async () => {
      if (!this.isRunningFlag) {
        return;
      }

      // Run the cycle
      await this.runCycle();

      // Schedule next cycle (if still running)
      this.scheduleNextCycle();
    }, this.schedulerConfig.intervalMs);
  }

  /**
   * Filter skills based on minNewTurnsToTrigger requirement.
   * Only includes skills that have accumulated enough new labeled turns
   * since their last evolution run.
   */
  private filterSkillsByNewTurns(decisions: TriggerDecision[]): TriggerDecision[] {
    return decisions.filter(decision => {
      const lastInfo = this.lastRunInfo.get(decision.skillName);
      
      // If never run, check if we have minNewTurnsToTrigger turns
      if (!lastInfo) {
        return decision.currentPerformance.totalTurns >= this.schedulerConfig.minNewTurnsToTrigger;
      }
      
      // Calculate new turns since last run
      const newTurns = decision.currentPerformance.totalTurns - lastInfo.labeledTurnCount;
      return newTurns >= this.schedulerConfig.minNewTurnsToTrigger;
    });
  }

  /**
   * Trigger evolution for a skill.
   * Creates the optimizer with all dependencies, runs evolution, and builds PR.
   * 
   * Note: We create a fresh optimizer per evolution run to avoid shared state issues.
   */
  private async triggerEvolution(decision: TriggerDecision): Promise<{ runId: string; prId?: string } | null> {
    const skillName = decision.skillName;
    const skillPath = this.resolveSkillPath(skillName);

    // Verify skill file exists
    if (!existsSync(skillPath)) {
      throw new Error(`Skill file not found: ${skillPath}`);
    }

    console.log(`[evolution-scheduler] Triggering evolution for ${skillName} (urgency: ${decision.urgency})`);

    // Increment active runs counter
    this.activeRuns++;

    // Trajectory logger for cleanup in finally block
    let trajectoryLogger: TrajectoryLogger | null = null;

    try {
      // Create fresh optimizer instance for this run
      // We need to instantiate the full dependency chain
      const rubricRegistry = new RubricRegistry(this.config);
      const llmJudge = new LlmJudge(this.config, rubricRegistry);
      const sizeLimits = new SizeLimits(this.config);
      const skillValidator = new SkillValidator(this.config, sizeLimits);
      const constraintValidator = new ConstraintValidator(skillValidator, sizeLimits, this.config);
      const evolver = new GEPAEvolver(this.config, llmJudge, rubricRegistry, constraintValidator);

      // Build dataset builder dependencies
      const sessionMinerCollection = new SessionMiner(this.config);
      
      // Create trajectory handler and logger for dataset building
      const trajectoryHandler = new TrajectoryHookHandler(this.config);
      trajectoryLogger = new TrajectoryLogger(this.config, trajectoryHandler);
      await trajectoryLogger.initialize();
      
      const datasetSessionMiner = new DatasetSessionMiner(
        this.config,
        sessionMinerCollection,
        trajectoryLogger
      );
      const syntheticGenerator = new SyntheticGenerator(this.config);
      const goldenSetLoader = new GoldenSetLoader(this.config);
      
      const datasetBuilder = new DatasetBuilder(
        this.config,
        this.datasetManager,
        datasetSessionMiner,
        syntheticGenerator,
        goldenSetLoader
      );

      // Create fresh optimizer
      const optimizer = new EvolutionOptimizer(
        this.config,
        evolver,
        this.datasetManager,
        datasetBuilder
      );

      // Run evolution
      const run = await optimizer.optimizeSkill(skillName, skillPath, {
        buildNewDataset: true,
      });

      console.log(`[evolution-scheduler] Evolution completed for ${skillName}: ${run.id}`);

      // Build PR for completed run
      if (run.status === "completed" && run.bestVariant) {
        const pr = await this.prBuilder.buildPr(run, run.bestVariant.content);
        console.log(`[evolution-scheduler] PR created for ${skillName}: ${pr.id}`);
        return { runId: run.id, prId: pr.id };
      }

      return { runId: run.id };
    } catch (err) {
      console.error(`[evolution-scheduler] Evolution failed for ${skillName}:`, err);
      throw err;
    } finally {
      // Decrement active runs counter
      this.activeRuns = Math.max(0, this.activeRuns - 1);
      
      // Clean up: stop periodic flush and flush any remaining data
      if (trajectoryLogger) {
        try {
          trajectoryLogger.stopPeriodicFlush?.();
          await trajectoryLogger.flush();
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  }

  /**
   * Resolve the skill file path for a given skill name.
   */
  private resolveSkillPath(skillName: string): string {
    const skillsDir = `${process.env.HOME ?? "."}/.openclaw/skills`;
    return join(skillsDir, skillName, "SKILL.md");
  }
}
