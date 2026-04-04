/**
 * OpenClaw Self-Evolution Pipeline - GEPA Evolver
 * 
 * Genetic-Pareto Prompt Evolution: generates variants of a skill,
 * evaluates them with LLM-as-judge, and iteratively selects the best.
 * 
 * Types referenced:
 * - EvolutionConfig from src/types.ts (lines 25-35)
 * - EvolutionEngineConfig from src/types.ts (lines 15-23)
 * - SkillVariant from src/types.ts (lines 104-113)
 * - Mutation from src/types.ts (lines 115-121)
 * - FitnessScore from src/types.ts (lines 140-148)
 * - FitnessComponents from src/types.ts (lines 150-157)
 * - DatasetEntry from src/types.ts (lines 245-255)
 * 
 * Dependencies:
 * - LlmJudge from src/evolution/fitness/llm-judge.ts
 * - RubricRegistry from src/evolution/fitness/rubrics.ts
 * - ConstraintValidator from src/validation/constraint-validator.ts
 * 
 * MiniMax API pattern: same as LlmJudge.callMiniMax() (llm-judge.ts lines 252-289)
 */

import type {
  EvolutionConfig,
  EvolutionEngineConfig,
  SkillVariant,
  Mutation,
  FitnessScore,
  FitnessComponents,
  DatasetEntry,
  EvolutionRun,
  EvolutionStatus,
} from "../../types.js";
import { LlmJudge } from "../fitness/llm-judge.js";
import { RubricRegistry } from "../fitness/rubrics.js";
import { ConstraintValidator } from "../../validation/constraint-validator.js";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";

// ============================================================================
// Result Types
// ============================================================================

/**
 * Result of a complete evolution run.
 * Captures the best variant found, comparison to baseline, and run metadata.
 * 
 * Note: Not defined in src/types.ts; defined here as the output of evolveSkill().
 */
export interface EvolutionResult {
  /** The best skill variant found during evolution */
  bestVariant: SkillVariant;
  /** Score of the best variant */
  bestScore: FitnessScore;
  /** Baseline score before evolution (for comparison) */
  baselineScore: FitnessScore;
  /** Improvement over baseline (bestScore.overall - baselineScore.overall) */
  improvement: number;
  /** Whether evolution stopped early due to targetScore being reached */
  stoppedEarly: boolean;
  /** Reason for stopping: 'target_reached' | 'max_generations' | 'no_improvement' */
  stopReason: "target_reached" | "max_generations" | "no_improvement";
  /** Number of generations completed */
  generationsCompleted: number;
  /** Total variants evaluated across all generations */
  totalVariantsEvaluated: number;
  /** All generations' metadata for analysis */
  generationHistory: GenerationSummary[];
  /** Final status of the evolution run */
  status: EvolutionStatus;
  /** Timestamp when evolution completed */
  completedAt: Date;
}

/**
 * Summary of a single generation for history tracking.
 */
export interface GenerationSummary {
  generation: number;
  variantCount: number;
  bestOverallScore: number;
  averageOverallScore: number;
  bestVariantId: string;
}

// ============================================================================
// Evolve Options
// ============================================================================

/**
 * Options for the evolveSkill() method.
 * All fields are optional and fall back to config.evolution values.
 */
export interface EvolveOptions {
  /** Maximum number of generations (default: config.evolution.maxGenerations) */
  maxGenerations?: number;
  /** Population size per generation (default: config.evolution.populationSize) */
  populationSize?: number;
  /** Probability of mutating a variant (default: config.evolution.mutationRate) */
  mutationRate?: number;
  /** Number of top variants to preserve as elites (default: config.evolution.eliteSize) */
  eliteSize?: number;
  /** Stop evolution if this score is reached (default: 0.9) */
  targetScore?: number;
}

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
// GEPA Evolver
// ============================================================================

/**
 * GEPAEvolver implements the Genetic-Pareto Prompt Evolution algorithm.
 * 
 * Algorithm:
 * 1. Score baseline with LlmJudge.scoreBaseline()
 * 2. Generate initial population of variants via mutation prompts
 * 3. For each generation:
 *    a. Score all variants with LlmJudge.scoreVariant()
 *    b. Select elites (top eliteSize by overall score)
 *    c. Generate new variants from elites via mutation
 *    d. Check stopping conditions (maxGenerations, targetScore)
 * 4. Return EvolutionResult with best variant and metadata
 * 
 * Mutation types (from Mutation.type in src/types.ts):
 * - prompt_rewrite: Rewrite the skill prompt/description
 * - example_add: Add a new example to the skill
 * - example_remove: Remove an example from the skill
 * - parameter_tweak: Adjust parameters/configuration
 * - structure_change: Change the overall structure of the skill
 */
export class GEPAEvolver {
  private config: EvolutionConfig;
  private judge: LlmJudge;
  private rubricRegistry: RubricRegistry;
  private constraintValidator: ConstraintValidator;
  private apiKey: string;
  private apiBaseUrl: string;

  constructor(
    config: EvolutionConfig,
    judge: LlmJudge,
    rubricRegistry: RubricRegistry,
    constraintValidator: ConstraintValidator
  ) {
    this.config = config;
    this.judge = judge;
    this.rubricRegistry = rubricRegistry;
    this.constraintValidator = constraintValidator;
    this.apiKey = process.env.MINIMAX_API_KEY ?? "";
    this.apiBaseUrl = "https://api.minimax.io";
  }

  // ==========================================================================
  // Hybrid Evolution (G3: DSPy as Primary Optimizer)
  // ==========================================================================

  /**
   * Run the hybrid evolution architecture:
   * Phase 1: Pre-warm with genetic evolution (optional)
   * Phase 2: DSPy GEPA as primary optimizer
   * Phase 3: Validation with LlmJudge and BenchmarkGate
   * 
   * @param skillName - Name of the skill to evolve
   * @param skillContent - Current skill content/SKILL.md
   * @param testCases - Array of DatasetEntry test cases for evaluation
   * @param baselineScore - Baseline fitness score
   * @param eliteSize - Number of elite variants to preserve
   * @param targetScore - Target score to stop early
   * @returns Promise resolving to EvolutionResult
   */
  private async runHybridEvolution(
    skillName: string,
    skillContent: string,
    testCases: DatasetEntry[],
    baselineScore: FitnessScore,
    eliteSize: number,
    targetScore: number
  ): Promise<EvolutionResult> {
    const engineConfig = this.config.evolution;
    const preWarmGenerations = engineConfig.preWarmGenerations ?? 2;
    const dspyIterations = engineConfig.dspyIterations ?? 10;

    console.log(`[evolver] Starting hybrid evolution (DSPy primary)`);
    console.log(`[evolver] Pre-warm generations: ${preWarmGenerations}`);
    console.log(`[evolver] DSPy iterations: ${dspyIterations}`);

    // Phase 1: Pre-warm (optional)
    let candidates: SkillVariant[] = [];
    if (preWarmGenerations > 0) {
      console.log(`[evolver] Phase 1: Pre-warm with ${preWarmGenerations} genetic generations`);
      candidates = await this.runPreWarmPhase(skillName, skillContent, testCases, preWarmGenerations);
    } else {
      // No pre-warm: use baseline as single candidate
      candidates = [{
        id: `${skillName}-baseline`,
        skillName,
        generation: 0,
        content: skillContent,
        mutations: [],
        parents: [],
        createdAt: new Date(),
      }];
    }

    // Phase 2: DSPy primary optimization
    console.log(`[evolver] Phase 2: DSPy primary optimization`);
    const dspyResult = await this.runDspyPrimaryPhase(skillName, candidates, testCases, dspyIterations);

    // Phase 3: Validation and result assembly
    let bestVariant: SkillVariant;
    let bestScore: FitnessScore;

    if (dspyResult && dspyResult.success && dspyResult.variant) {
      // DSPy succeeded — validate with full LlmJudge
      console.log(`[evolver] Phase 3: Validating DSPy result`);
      bestVariant = dspyResult.variant;
      bestScore = await this.judge.scoreVariant(bestVariant, testCases);
      
      // Check if DSPy actually improved over baseline
      if (bestScore.overall <= baselineScore.overall) {
        console.warn(`[evolver] DSPy result did not improve over baseline (${bestScore.overall} vs ${baselineScore.overall})`);
        // Fall back to best pre-warm candidate if available
        if (candidates.length > 1) {
          const bestPreWarm = await this.findBestCandidate(skillName, candidates, testCases);
          if (bestPreWarm.score.overall > bestScore.overall) {
            console.log(`[evolver] Using best pre-warm candidate instead`);
            bestVariant = bestPreWarm.variant;
            bestScore = bestPreWarm.score;
          }
        }
      }
    } else {
      // DSPy failed — fall back to best pre-warm candidate
      console.warn(`[evolver] DSPy primary optimization failed, falling back to genetic result`);
      if (candidates.length > 1) {
        const bestPreWarm = await this.findBestCandidate(skillName, candidates, testCases);
        bestVariant = bestPreWarm.variant;
        bestScore = bestPreWarm.score;
      } else {
        // No candidates — return baseline
        bestVariant = candidates[0] || {
          id: `${skillName}-baseline-fallback`,
          skillName,
          generation: 0,
          content: skillContent,
          mutations: [],
          parents: [],
          createdAt: new Date(),
        };
        bestScore = baselineScore;
      }
    }

    const improvement = bestScore.overall - baselineScore.overall;

    return {
      bestVariant,
      bestScore,
      baselineScore,
      improvement: Math.round(improvement * 100) / 100,
      stoppedEarly: false,
      stopReason: "max_generations",
      generationsCompleted: preWarmGenerations,
      totalVariantsEvaluated: candidates.length,
      generationHistory: [{
        generation: 0,
        variantCount: candidates.length,
        bestOverallScore: bestScore.overall,
        averageOverallScore: bestScore.overall,
        bestVariantId: bestVariant.id,
      }],
      status: "completed",
      completedAt: new Date(),
    };
  }

  /**
   * Phase 1: Pre-warm with genetic evolution.
   * Runs a limited number of genetic generations to generate diverse starting variants.
   * 
   * @param skillName - Name of the skill to evolve
   * @param skillContent - Current skill content/SKILL.md
   * @param testCases - Array of DatasetEntry test cases for evaluation
   * @param preWarmGenerations - Number of generations to run
   * @returns Array of top SkillVariants from pre-warm phase
   */
  private async runPreWarmPhase(
    skillName: string,
    skillContent: string,
    testCases: DatasetEntry[],
    preWarmGenerations: number
  ): Promise<SkillVariant[]> {
    const engineConfig = this.config.evolution;
    const populationSize = engineConfig.populationSize;
    const mutationRate = engineConfig.mutationRate;
    const eliteSize = Math.max(1, Math.min(2, populationSize)); // Small elite for pre-warm

    // Generate initial population
    const initialVariants = await this.generateValidVariants(skillContent, populationSize, skillContent);
    let population: SkillVariant[] = initialVariants.map((v) => ({
      ...v,
      skillName,
    }));

    // Run limited genetic generations
    for (let generation = 1; generation <= preWarmGenerations; generation++) {
      console.log(`[evolver] Pre-warm generation ${generation}/${preWarmGenerations}`);

      // Score population
      const scoredVariants = await this.scorePopulation(population, testCases);

      // Select elites
      const elites = this.selectElites(scoredVariants, eliteSize);

      // Generate new variants from elites
      const newVariants: SkillVariant[] = [];
      const mutationsToApply: Mutation[] = [
        { type: "prompt_rewrite", description: "Rewrite skill prompt" },
        { type: "example_add", description: "Add new example" },
        { type: "example_remove", description: "Remove redundant example" },
        { type: "parameter_tweak", description: "Adjust parameters" },
        { type: "structure_change", description: "Change structure" },
      ];

      let attempts = 0;
      const maxAttempts = (populationSize - eliteSize) * 3;

      while (newVariants.length < populationSize - eliteSize && attempts < maxAttempts) {
        attempts++;
        const elite = elites[Math.floor(Math.random() * elites.length)];
        const mutation = mutationsToApply[Math.floor(Math.random() * mutationsToApply.length)];

        if (Math.random() < mutationRate) {
          try {
            const mutatedContent = await this.applyMutation(elite.variant.content, mutation);
            const mutatedVariant: SkillVariant = {
              id: `${skillName}-prewarm-gen${generation}-mutant${attempts}-${Date.now()}`,
              skillName,
              generation,
              content: mutatedContent,
              mutations: [...elite.variant.mutations, mutation],
              parents: [elite.variant.id],
              createdAt: new Date(),
            };

            // Constraint check
            const constraintCheck = this.constraintValidator.validateVariant(mutatedVariant, skillContent);
            if (constraintCheck.valid) {
              newVariants.push(mutatedVariant);
            }
          } catch {
            // Skip failed mutations
            continue;
          }
        } else {
          // Clone elite
          newVariants.push({
            ...elite.variant,
            id: `${skillName}-prewarm-gen${generation}-clone${attempts}-${Date.now()}`,
            generation,
            mutations: [],
            parents: [elite.variant.id],
          });
        }
      }

      // Next generation
      population = [...elites.map((e) => e.variant), ...newVariants];
    }

    // Return all variants from final generation (diverse candidates)
    return population;
  }

  /**
   * Phase 2: DSPy primary optimization.
   * Calls DSPy bridge with best candidates from pre-warm phase.
   * 
   * @param skillName - Name of the skill to evolve
   * @param candidates - Array of candidate variants from pre-warm
   * @param testCases - Array of DatasetEntry test cases for evaluation
   * @param iterations - Number of GEPA iterations
   * @returns Result with optimized variant or null if failed
   */
  private async runDspyPrimaryPhase(
    skillName: string,
    candidates: SkillVariant[],
    testCases: DatasetEntry[],
    iterations: number
  ): Promise<{ success: boolean; variant?: SkillVariant; score?: number; error?: string } | null> {
    // Score candidates to get their fitness scores
    const scoredCandidates = await this.scorePopulation(candidates, testCases);
    
    // Prepare candidates for DSPy bridge
    const candidateData = scoredCandidates.map((scored) => ({
      id: scored.variant.id,
      content: scored.variant.content,
      score: scored.score.overall / 100, // Convert 0-100 to 0-1 scale
    }));

    // Call DSPy bridge with primary optimization action
    const bridgeResult = await this.invokeDspyBridge({
      action: "optimize_skill_primary",
      skillName,
      candidates: candidateData,
      testCases: testCases.map((tc) => ({
        input: tc.input,
        expectedOutput: tc.metadata?.expectedBehavior ?? tc.expectedOutput, // prefer richer rubric
        context: tc.context,
      })),
      config: {
        maxIterations: iterations,
        llm: { dspy: this.config.llm?.dspy ?? {} }
      },
    });

    if (!bridgeResult.success || !bridgeResult.optimizedContent) {
      return {
        success: false,
        error: bridgeResult.error || "DSPy optimization returned no content",
      };
    }

    // Create variant from DSPy result
    const dspyVariant: SkillVariant = {
      id: `${skillName}-dspy-primary-${Date.now()}`,
      skillName,
      generation: candidates[0]?.generation ?? 0,
      content: bridgeResult.optimizedContent,
      mutations: [{ type: "prompt_rewrite", description: "DSPy GEPA primary optimization" }],
      parents: candidates.map((c) => c.id),
      createdAt: new Date(),
    };

    // Validate DSPy output before accepting
    if (this.constraintValidator) {
      const check = this.constraintValidator.validateVariant(dspyVariant, candidates[0]?.content ?? "");
      if (!check.valid) {
        console.warn("[evolver] DSPy output failed constraint validation, using genetic result");
        return null; // caller uses fallback
      }
    }

    return {
      success: true,
      variant: dspyVariant,
      score: (bridgeResult.optimizedScore ?? 0) * 100, // Convert 0-1 to 0-100 scale
    };
  }

  /**
   * Find the best candidate from a list by scoring with LlmJudge.
   */
  private async findBestCandidate(
    skillName: string,
    candidates: SkillVariant[],
    testCases: DatasetEntry[]
  ): Promise<{ variant: SkillVariant; score: FitnessScore }> {
    const scored = await this.scorePopulation(candidates, testCases);
    return scored.reduce((best, curr) =>
      curr.score.overall > best.score.overall ? curr : best
    );
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  /**
   * Run the evolution process for a skill.
   * 
   * @param skillName - Name of the skill to evolve
   * @param skillContent - Current skill content/SKILL.md
   * @param testCases - Array of DatasetEntry test cases for evaluation
   * @param options - Optional evolution parameters (fall back to config)
   * @returns Promise resolving to EvolutionResult with best variant and metadata
   */
  async evolveSkill(
    skillName: string,
    skillContent: string,
    testCases: DatasetEntry[],
    options?: EvolveOptions
  ): Promise<EvolutionResult> {
    const engineConfig = this.config.evolution;

    // Resolve options with defaults from config
    const maxGenerations = options?.maxGenerations ?? engineConfig.maxGenerations;
    const populationSize = options?.populationSize ?? engineConfig.populationSize;
    const mutationRate = options?.mutationRate ?? engineConfig.mutationRate;
    const resolvedEliteSize = options?.eliteSize ?? engineConfig.eliteSize;
    const targetScore = options?.targetScore ?? 0.9;

    // Fix eliteSize: ensure at least 1 to avoid empty elite selection crash
    const safeEliteSize = Math.max(1, Math.min(resolvedEliteSize, populationSize));

    // Step 1: Score baseline
    const baselineScore = await this.judge.scoreBaseline(skillName, skillContent, testCases);

    // G3: DSPy as primary optimizer — hybrid architecture
    if (engineConfig.useDspyPrimary) {
      return this.runHybridEvolution(
        skillName,
        skillContent,
        testCases,
        baselineScore,
        safeEliteSize,
        targetScore
      );
    }

    // Step 2: Generate initial population with constraint validation
    const initialVariants = await this.generateValidVariants(skillContent, populationSize, skillContent);
    const enrichedVariants = initialVariants.map((v) => ({
      ...v,
      skillName,
    }));

    // Track population across generations
    let population: SkillVariant[] = enrichedVariants;
    const generationHistory: GenerationSummary[] = [];
    let totalVariantsEvaluated = 0;
    let bestOverall = baselineScore.overall;
    let stoppedEarly = false;
    let stopReason: EvolutionResult["stopReason"] = "max_generations";

    // Step 3: Evolution loop
    for (
      let generation = 1;
      generation <= maxGenerations;
      generation++
    ) {
      // Score all variants in current population
      const scoredVariants = await this.scorePopulation(
        population,
        testCases
      );
      totalVariantsEvaluated += scoredVariants.length;

      // Guard: if all variants failed constraints, fall back to baseline
      if (scoredVariants.length === 0) {
        console.warn("[evolver] All variants failed constraints in generation, keeping baseline");
        stopReason = "no_improvement";
        break;
      }

      // Find best in this generation
      const genBest = scoredVariants.reduce((best, curr) =>
        curr.score.overall > best.score.overall ? curr : best
      );

      if (genBest.score.overall > bestOverall) {
        bestOverall = genBest.score.overall;
      }

      // Record generation summary
      const avgScore =
        scoredVariants.reduce((sum, v) => sum + v.score.overall, 0) /
        scoredVariants.length;
      generationHistory.push({
        generation,
        variantCount: scoredVariants.length,
        bestOverallScore: genBest.score.overall,
        averageOverallScore: Math.round(avgScore * 100) / 100,
        bestVariantId: genBest.variant.id,
      });

      // Check stopping conditions
      if (genBest.score.overall >= targetScore * 100) {
        stoppedEarly = true;
        stopReason = "target_reached";
        break;
      }

      // Early termination if no improvement in 3 generations
      if (generation >= 3) {
        const recentBest = generationHistory.slice(-3);
        const improving = recentBest[2].bestOverallScore > recentBest[0].bestOverallScore;
        if (!improving && genBest.score.overall <= baselineScore.overall) {
          stoppedEarly = true;
          stopReason = "no_improvement";
          break;
        }
      }

      // Select elites for next generation
      const elites = this.selectElites(scoredVariants, safeEliteSize);

      // Generate new variants from elites via mutation
      const newVariants: SkillVariant[] = [];
      const mutationsToApply: Mutation[] = [
        { type: "prompt_rewrite", description: "Rewrite skill prompt" },
        { type: "example_add", description: "Add new example" },
        { type: "example_remove", description: "Remove redundant or misleading examples" },
        { type: "parameter_tweak", description: "Adjust parameters" },
        { type: "structure_change", description: "Change structure" },
      ];

      let attempts = 0;
      const maxAttempts = (populationSize - safeEliteSize) * 3;

      while (newVariants.length < populationSize - safeEliteSize && attempts < maxAttempts) {
        attempts++;
        // Pick random elite
        const elite = elites[Math.floor(Math.random() * elites.length)];
        
        // Use feedback-guided mutation selection if parent has feedback, otherwise random
        const randomMutationType = mutationsToApply[Math.floor(Math.random() * mutationsToApply.length)];
        const mutationType = elite.score?.feedback
          ? this.selectMutationTypeFromFeedback(elite.score.feedback)
          : randomMutationType.type;
        const mutation: Mutation = {
          type: mutationType,
          description: mutationsToApply.find(m => m.type === mutationType)?.description || "Feedback-guided mutation",
        };

        if (Math.random() < mutationRate) {
          try {
            const parentWithScore = { ...elite.variant, fitnessScore: elite.score };
            const mutatedContent = await this.applyMutation(
              elite.variant.content,
              mutation,
              parentWithScore  // Pass parent variant with score for reflective mutation
            );
            const mutatedVariant: SkillVariant = {
              id: `${skillName}-gen${generation}-mutant${attempts}-${Date.now()}`,
              skillName,
              generation,
              content: mutatedContent,
              mutations: [mutation],
              parents: [elite.variant.id],
              createdAt: new Date(),
            };

            // Constraint check after mutation, before scoring
            const constraintCheck = this.constraintValidator.validateVariant(mutatedVariant, skillContent);
            if (!constraintCheck.valid) {
              const failedChecks = constraintCheck.checks.filter(c => !c.passed).map(c => c.name).join(', ');
              console.warn(`[evolver] Rejected invalid variant after mutation: ${failedChecks}`);
              // Skip this variant - don't add to population for scoring
              continue;
            }

            newVariants.push(mutatedVariant);
            continue; // Move to next slot
          } catch (err) {
            // If mutation fails, fall back to generating a fresh variant with constraint validation
            const fallback = await this.generateSingleVariant(skillContent);
            const fallbackVariant: SkillVariant = {
              ...fallback,
              id: `${skillName}-gen${generation}-fallback${attempts}-${Date.now()}`,
              skillName,
              generation,
              parents: [elite.variant.id],
            };

            // Validate fallback variant
            const fallbackCheck = this.constraintValidator.validateVariant(fallbackVariant, skillContent);
            if (!fallbackCheck.valid) {
              const failedChecks = fallbackCheck.checks.filter(c => !c.passed).map(c => c.name).join(', ');
              console.warn(`[evolver] Fallback variant also invalid: ${failedChecks}`);
              continue;
            }

            newVariants.push(fallbackVariant);
            continue; // Move to next slot
          }
        } else {
          // No mutation, clone elite (elites are already validated)
          newVariants.push({
            ...elite.variant,
            id: `${skillName}-gen${generation}-clone${attempts}-${Date.now()}`,
            generation,
            mutations: [],
            parents: [elite.variant.id],
          });
        }
      }

      // If we couldn't fill all slots, pad with clones of elites
      while (newVariants.length < populationSize - safeEliteSize && elites.length > 0) {
        newVariants.push({ ...elites[newVariants.length % elites.length].variant });
      }

      // Next generation = elites + new variants
      population = [...elites.map((e) => e.variant), ...newVariants];
    }

    // Final scoring of all variants
    const finalScored = await this.scorePopulation(population, testCases);
    totalVariantsEvaluated += finalScored.length;

    // Guard: if population or finalScored is empty, return baseline
    if (population.length === 0 || finalScored.length === 0) {
      // Return baseline variant as result
      const baselineVariant: SkillVariant = {
        id: `${skillName}-baseline`,
        skillName,
        generation: 0,
        content: skillContent,
        mutations: [],
        parents: [],
        createdAt: new Date(),
      };
      return {
        bestVariant: baselineVariant,
        bestScore: baselineScore,
        baselineScore,
        improvement: 0,
        stoppedEarly: true,
        stopReason: "no_improvement",
        generationsCompleted: generationHistory.length,
        totalVariantsEvaluated: 0,
        generationHistory,
        status: "completed",
        completedAt: new Date(),
      };
    }

    // Select the best overall variant
    const best = this.selectBest(
      finalScored.map((s) => s.variant),
      finalScored
    );

    const bestScored = finalScored.find((s) => s.variant.id === best.id)!;
    const improvement = bestScored.score.overall - baselineScore.overall;

    // Optionally run DSPy bridge to potentially find a better variant
    // This runs after genetic evolution for final optimization polish
    let bestVariant = bestScored.variant;
    let bestScore = bestScored.score;
    if (engineConfig.useDspyBridge) {
      const bridgeResult = await this.invokeDspyBridge({
        action: "optimize_skill",
        skillName,
        skillContent: bestScored.variant.content,  // Use best genetic variant, not baseline
        currentBestContent: bestScored.variant.content,
        baselineScore: bestScored.score.overall,
        testCases: testCases.map((tc) => ({
          input: tc.input,
          expectedOutput: tc.expectedOutput,
          context: tc.context,
        })),
        config: {
          llm: { dspy: this.config.llm?.dspy ?? {} }
        }
      });
      if (bridgeResult.success && bridgeResult.optimizedContent && bridgeResult.optimizedScore !== undefined) {
        // DSPy returns score on 0-1 scale, LLM judge uses 0-100 scale
        const dspyScore = (bridgeResult.optimizedScore ?? 0) * 100;
        if (dspyScore > bestScore.overall) {
          bestVariant = {
            id: `${bestScored.variant.id}-dspy-optimized`,
            skillName,
            generation: bestScored.variant.generation,
            content: bridgeResult.optimizedContent,
            mutations: [...bestScored.variant.mutations, { type: "prompt_rewrite", description: "DSPy optimization" }],
            parents: [bestScored.variant.id],
            createdAt: new Date(),
          };
          bestScore = {
            ...bestScored.score,
            overall: dspyScore,
          };
        }
      }
    }

    // Recompute improvement after DSPy block to reflect the actual best score
    const finalImprovement = bestScore.overall - baselineScore.overall;

    return {
      bestVariant,
      bestScore,
      baselineScore,
      improvement: Math.round(finalImprovement * 100) / 100,
      stoppedEarly: stopReason !== "max_generations",
      stopReason,
      generationsCompleted: generationHistory.length,
      totalVariantsEvaluated,
      generationHistory,
      status: "completed",
      completedAt: new Date(),
    };
  }

  /**
   * Generate multiple mutated variants of skill content.
   * Uses MiniMax LLM to produce meaningful variations.
   * 
   * @param skillContent - Original skill content to mutate
   * @param count - Number of variants to generate (default: 5)
   * @returns Array of SkillVariant objects (without skillName set)
   */
  async generateVariants(
    skillContent: string,
    count = 5
  ): Promise<SkillVariant[]> {
    const variants: SkillVariant[] = [];
    for (let i = 0; i < count; i++) {
      const variant = await this.generateSingleVariant(skillContent);
      variants.push({
        ...variant,
        id: `variant-${i}-${Date.now()}`,
      });
    }
    return variants;
  }

  /**
   * Generate valid variants with constraint checking.
   * Rejects invalid variants early to save LLM judge calls.
   * Allows 3x attempts for replacements.
   * 
   * @param skillContent - Original skill content to mutate
   * @param count - Number of valid variants to generate
   * @param baselineContent - Baseline content for growth check
   * @returns Array of valid SkillVariant objects
   */
  async generateValidVariants(
    skillContent: string,
    count: number,
    baselineContent: string,
  ): Promise<SkillVariant[]> {
    const valid: SkillVariant[] = [];
    let attempts = 0;
    const maxAttempts = count * 3; // Allow 3x attempts for valid variants

    while (valid.length < count && attempts < maxAttempts) {
      const variant = await this.generateSingleVariant(skillContent);
      const check = this.constraintValidator.validateVariant(variant, baselineContent);

      if (check.valid) {
        valid.push(variant);
      } else {
        const failedChecks = check.checks.filter(c => !c.passed).map(c => c.name).join(', ');
        console.warn(`[evolver] Rejected invalid initial variant: ${failedChecks}`);
      }
      attempts++;
    }

    if (valid.length < count) {
      console.warn(`[evolver] Only generated ${valid.length}/${count} valid variants after ${maxAttempts} attempts`);
    }

    return valid;
  }

  /**
   * Select the best variant from a population based on overall score.
   * Uses Pareto-efficient selection: prefers variants with higher overall scores.
   * 
   * @param variants - Array of SkillVariant to select from
   * @param scoredVariants - Variants with their FitnessScore
   * @returns The best SkillVariant by overall score
   */
  selectBest(
    variants: SkillVariant[],
    scoredVariants: Array<{ variant: SkillVariant; score: FitnessScore }>
  ): SkillVariant {
    if (variants.length === 0) {
      throw new Error("Cannot select best from empty variant list");
    }
    if (scoredVariants.length === 0) {
      throw new Error("Cannot select best from empty scored variant list");
    }

    // Find variant with highest overall score by iterating scoredVariants
    let bestScored = scoredVariants[0];
    let bestScore = bestScored.score.overall;

    for (const scored of scoredVariants) {
      if (scored.score.overall > bestScore) {
        bestScore = scored.score.overall;
        bestScored = scored;
      }
    }

    return bestScored.variant;
  }

  /**
   * Select mutation type based on fitness feedback.
   * Uses the judge's feedback to determine what kind of mutation is most likely to help.
   * 
   * @param feedback - The fitness feedback string from the LLM judge
   * @returns The mutation type to apply
   */
  private selectMutationTypeFromFeedback(feedback: string): Mutation["type"] {
    const f = feedback.toLowerCase();
    if (f.includes("unclear") || f.includes("confusing") || f.includes("vague")) {
      return "prompt_rewrite";
    }
    if (f.includes("example") || f.includes("demonstrate") || f.includes("illustrat")) {
      return "example_add";
    }
    if (f.includes("too long") || f.includes("verbose") || f.includes("redundant")) {
      return "example_remove";
    }
    if (f.includes("order") || f.includes("structure") || f.includes("reorgani")) {
      return "structure_change";
    }
    // Default: prompt_rewrite (most generally useful)
    return "prompt_rewrite";
  }

  /**
   * Apply a specific mutation to skill content.
   * Uses MiniMax LLM to perform the mutation.
   * 
   * @param skillContent - Original skill content
   * @param mutation - Mutation to apply (from Mutation.type in src/types.ts)
   * @param parentVariant - Optional parent variant with fitness feedback for reflective mutation
   * @returns Mutated skill content as string
   */
  async applyMutation(
    skillContent: string, 
    mutation: Mutation, 
    parentVariant?: SkillVariant
  ): Promise<string> {
    const mutationDescriptions: Record<Mutation["type"], string> = {
      prompt_rewrite:
        "Rewrite the skill's main prompt/description section while preserving the overall structure and goals. Make it clearer, more concise, and more effective.",
      example_add:
        "Add a new instructive example to the skill that demonstrates the skill in action. The example should be realistic and helpful.",
      example_remove:
        "Remove or simplify one of the examples in the skill, keeping only the most valuable ones.",
      parameter_tweak:
        "Adjust the skill's parameters or configuration values to optimize performance. Be specific about what values change.",
      structure_change:
        "Restructure the skill's organization, perhaps regrouping sections, changing the order, or modifying how information is presented. Maintain all valuable content.",
    };

    // Build feedback context for reflective mutation if parent has fitness feedback
    const feedbackContext = parentVariant?.fitnessScore?.feedback
      ? `\n## WHY THE CURRENT SKILL NEEDS IMPROVEMENT\n${parentVariant.fitnessScore.feedback}\n\nAddress this specific issue in your improved version.`
      : "";

    const prompt = `You are an expert at improving AI agent skills through careful mutation.

## ORIGINAL SKILL CONTENT
\`\`\`
${skillContent}
\`\`\`

## MUTATION TO APPLY
${mutationDescriptions[mutation.type]}

${mutation.description ? `Additional context: ${mutation.description}` : ""}${feedbackContext}

## TASK
Apply this mutation to the skill content above. Return ONLY the modified skill content, preserving the same format (Markdown with frontmatter). No explanations or commentary outside the skill content itself.

Return the mutated skill content:`;

    return this.callMiniMax(prompt);
  }

  // ==========================================================================
  // DSPy Bridge
  // ==========================================================================

  /**
   * Invoke the DSPy optimization bridge via Python subprocess.
   *
   * @param request - Bridge request with skill context and test cases
   * @returns Bridge response with optimized content and score
   */
  private async invokeDspyBridge(
    request: object
  ): Promise<{ success: boolean; optimizedContent?: string; optimizedScore?: number; error?: string }> {
    // Find the bridge script relative to project root
    const projectRoot = this.resolveProjectRoot();
    const bridgePath = join(projectRoot, "python", "dspy_bridge.py");

    if (!existsSync(bridgePath)) {
      return { success: false, error: `DSPy bridge not found at ${bridgePath}` };
    }

    return new Promise((resolve) => {
      const timeoutMs = 120000; // 2 minute timeout
      const timer = setTimeout(() => {
        proc.kill();
        resolve({ success: false, error: "DSPy bridge timed out after 2 minutes" });
      }, timeoutMs);

      const proc = spawn("python3", [bridgePath], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          resolve({ success: false, error: `DSPy bridge exited with code ${code}: ${stderr}` });
          return;
        }

        try {
          const result = JSON.parse(stdout.trim());
          resolve(result);
        } catch {
          resolve({ success: false, error: `Failed to parse DSPy bridge response: ${stdout}` });
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        resolve({ success: false, error: `DSPy bridge spawn error: ${err.message}` });
      });

      // Write request to stdin and close it
      proc.stdin.write(JSON.stringify(request));
      proc.stdin.end();
    });
  }

  /**
   * Resolve the project root directory.
   */
  private resolveProjectRoot(): string {
    // Try to find project root by looking for package.json
    let dir = __dirname;
    while (dir !== "/" && dir !== "." && dir !== "") {
      if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "python", "dspy_bridge.py"))) {
        return dir;
      }
      dir = dirname(dir);
    }
    // Fallback: assume evolver.ts is at src/evolution/gepa/evolver.ts
    // so project root is 3 levels up
    return join(__dirname, "..", "..", "..");
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Generate a single variant using MiniMax LLM.
   */
  private async generateSingleVariant(skillContent: string): Promise<SkillVariant> {
    const prompt = `You are an expert at improving AI agent skills by creating effective variants.

## ORIGINAL SKILL CONTENT
\`\`\`
${skillContent}
\`\`\`

## TASK
Create a meaningful variant of this skill that approaches the same goal differently.
Consider one or more of:
- Rewording the main prompt for clarity or different emphasis
- Adding a helpful example
- Restructuring for better readability
- Adjusting parameters or thresholds
- Changing the approach while keeping the same goal

The variant should be substantively different from the original while maintaining the skill's purpose.

Return ONLY the variant skill content (Markdown format). No explanations outside the content:`;

    const content = await this.callMiniMax(prompt);

    // Determine what kind of mutation was applied
    const mutationType: Mutation["type"] =
      Math.random() < 0.3
        ? "prompt_rewrite"
        : Math.random() < 0.5
        ? "structure_change"
        : "parameter_tweak";

    return {
      id: `variant-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
      skillName: "", // Will be set by caller
      generation: 1,
      content,
      mutations: [{ type: mutationType, description: "Generated variant" }],
      parents: [],
      createdAt: new Date(),
    };
  }

  /**
   * Score all variants in a population using the LLM judge.
   */
  private async scorePopulation(
    population: SkillVariant[],
    testCases: DatasetEntry[]
  ): Promise<Array<{ variant: SkillVariant; score: FitnessScore }>> {
    const results: Array<{ variant: SkillVariant; score: FitnessScore }> = [];

    // Score variants in parallel with a concurrency limit
    const concurrencyLimit = 3;
    for (let i = 0; i < population.length; i += concurrencyLimit) {
      const batch = population.slice(i, i + concurrencyLimit);
      const batchResults = await Promise.all(
        batch.map(async (variant) => {
          try {
            const score = await this.judge.scoreVariant(variant, testCases);
            return { variant, score };
          } catch (err) {
            // If scoring fails, assign a zero score
            const zeroScore: FitnessScore = {
              overall: 0,
              components: {
                correctness: 0,
                procedureFollowing: 0,
                conciseness: 0,
              },
              evaluatedAt: new Date(),
              method: "llm_judge",
              rawScores: {},
            };
            return { variant, score: zeroScore };
          }
        })
      );
      results.push(...batchResults);
    }

    return results;
  }

  /**
   * Select elite variants (top performers by overall score).
   */
  private selectElites(
    scoredVariants: Array<{ variant: SkillVariant; score: FitnessScore }>,
    eliteSize: number
  ): Array<{ variant: SkillVariant; score: FitnessScore }> {
    // Sort by overall score descending
    const sorted = [...scoredVariants].sort(
      (a, b) => b.score.overall - a.score.overall
    );
    return sorted.slice(0, Math.min(eliteSize, sorted.length));
  }

  /**
   * Call the MiniMax API for text generation.
   * Pattern matches: LlmJudge.callMiniMax() (llm-judge.ts lines 252-289)
   */
  private async callMiniMax(prompt: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error("MINIMAX_API_KEY environment variable is not set");
    }

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
                "You are an expert AI skill developer. Return only the requested content with no additional commentary.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          temperature: 0.7, // Higher temperature for creative variant generation
          max_tokens: 2000,
        }),
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

    // Strip markdown code blocks if present
    const cleaned = content
      .replace(/^```markdown\s*/i, "")
      .replace(/^```\s*/, "")
      .replace(/\s*```$/, "")
      .trim();

    return cleaned;
  }
}
