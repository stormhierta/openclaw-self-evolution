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
  private apiKey: string;
  private apiBaseUrl: string;

  constructor(
    config: EvolutionConfig,
    judge: LlmJudge,
    rubricRegistry: RubricRegistry
  ) {
    this.config = config;
    this.judge = judge;
    this.rubricRegistry = rubricRegistry;
    this.apiKey = process.env.MINIMAX_API_KEY ?? "";
    this.apiBaseUrl = "https://api.minimax.io";
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

    // Step 2: Generate initial population
    const initialVariants = await this.generateVariants(skillContent, populationSize);
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

      for (let i = 0; i < populationSize - safeEliteSize; i++) {
        // Pick random elite and random mutation
        const elite = elites[Math.floor(Math.random() * elites.length)];
        const mutation =
          mutationsToApply[Math.floor(Math.random() * mutationsToApply.length)];

        if (Math.random() < mutationRate) {
          try {
            const mutatedContent = await this.applyMutation(
              elite.variant.content,
              mutation
            );
            newVariants.push({
              id: `${skillName}-gen${generation}-mutant${i}-${Date.now()}`,
              skillName,
              generation,
              content: mutatedContent,
              mutations: [mutation],
              parents: [elite.variant.id],
              createdAt: new Date(),
            });
          } catch (err) {
            // If mutation fails, fall back to generating a fresh variant
            const fallback = await this.generateSingleVariant(skillContent);
            newVariants.push({
              ...fallback,
              id: `${skillName}-gen${generation}-fallback${i}-${Date.now()}`,
              skillName,
              generation,
              parents: [elite.variant.id],
            });
          }
        } else {
          // No mutation, clone elite
          newVariants.push({
            ...elite.variant,
            id: `${skillName}-gen${generation}-clone${i}-${Date.now()}`,
            generation,
            mutations: [],
            parents: [elite.variant.id],
          });
        }
      }

      // Next generation = elites + new variants
      population = [...elites.map((e) => e.variant), ...newVariants];
    }

    // Final scoring of all variants
    const finalScored = await this.scorePopulation(population, testCases);
    totalVariantsEvaluated += finalScored.length;

    // Select the best overall variant
    const best = this.selectBest(
      finalScored.map((s) => s.variant),
      finalScored
    );

    const bestScored = finalScored.find((s) => s.variant.id === best.id)!;
    const improvement = bestScored.score.overall - baselineScore.overall;

    // Optionally run DSPy bridge to potentially find a better variant
    let bestVariant = bestScored.variant;
    let bestScore = bestScored.score;
    if (engineConfig.useDspyBridge) {
      const bridgeResult = await this.invokeDspyBridge({
        skillName,
        skillContent,
        currentBestContent: bestScored.variant.content,
        currentScore: bestScored.score.overall,
        testCases: testCases.map((tc) => ({
          input: tc.input,
          expectedOutput: tc.expectedOutput,
          context: tc.context,
        })),
      });
      if (bridgeResult.success && bridgeResult.optimizedContent && bridgeResult.score !== undefined) {
        if (bridgeResult.score > bestScore.overall) {
          bestVariant = {
            id: `${bestScored.variant.id}-dspy-optimized`,
            skillName,
            generation: bestScored.variant.generation,
            content: bridgeResult.optimizedContent,
            mutations: [{ type: "prompt_rewrite", description: "DSPy optimization" }],
            parents: [bestScored.variant.id],
            createdAt: new Date(),
          };
          bestScore = {
            ...bestScored.score,
            overall: bridgeResult.score,
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
      stoppedEarly,
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

    // Build score lookup by variant id
    const scoreMap = new Map<string, FitnessScore>();
    for (const sv of scoredVariants) {
      scoreMap.set(sv.variant.id, sv.score);
    }

    // Find variant with highest overall score
    let bestVariant = variants[0];
    let bestScore = scoreMap.get(bestVariant.id)?.overall ?? -Infinity;

    for (const variant of variants) {
      const score = scoreMap.get(variant.id)?.overall ?? -Infinity;
      if (score > bestScore) {
        bestScore = score;
        bestVariant = variant;
      }
    }

    return bestVariant;
  }

  /**
   * Apply a specific mutation to skill content.
   * Uses MiniMax LLM to perform the mutation.
   * 
   * @param skillContent - Original skill content
   * @param mutation - Mutation to apply (from Mutation.type in src/types.ts)
   * @returns Mutated skill content as string
   */
  async applyMutation(skillContent: string, mutation: Mutation): Promise<string> {
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

    const prompt = `You are an expert at improving AI agent skills through careful mutation.

## ORIGINAL SKILL CONTENT
\`\`\`
${skillContent}
\`\`\`

## MUTATION TO APPLY
${mutationDescriptions[mutation.type]}

${mutation.description ? `Additional context: ${mutation.description}` : ""}

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
  ): Promise<{ success: boolean; optimizedContent?: string; score?: number; error?: string }> {
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
                formatAdherence: 0,
                efficiency: 0,
                robustness: 0,
                clarity: 0,
              } as FitnessComponents,
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
