/**
 * OpenClaw Self-Evolution Pipeline - Test Runner
 * 
 * Executes skill test suites against a skill variant using LLM simulation.
 * Since we cannot execute an actual agent (requires a running OpenClaw gateway),
 * this test runner uses an LLM to simulate what the skill would do given the input.
 * 
 * Types referenced:
 * - SkillVariant from src/types.ts (lines 104-113)
 * - DatasetEntry from src/types.ts (lines 245-255)
 * - EvolutionConfig from src/types.ts (lines 25-35)
 * 
 * MiniMax API pattern: same as src/evolution/fitness/llm-judge.ts
 */

import type {
  SkillVariant,
  DatasetEntry,
  EvolutionConfig,
} from "../types.js";

// ============================================================================
// Result Types
// ============================================================================

/** Result of a single test case execution */
export interface SingleTestResult {
  /** ID of the test case (from DatasetEntry.id) */
  testCaseId: string;
  /** Whether the test passed */
  passed: boolean;
  /** Simulated output from LLM */
  simulatedOutput: string;
  /** Expected output from DatasetEntry */
  expectedOutput: string;
  /** Score from 0 to 1 */
  score: number;
  /** Error message if test failed to execute */
  error?: string;
}

/** Result of running all test cases */
export interface TestRunResult {
  /** Total number of tests run */
  totalTests: number;
  /** Number of tests that passed */
  passed: number;
  /** Number of tests that failed */
  failed: number;
  /** Pass rate as a fraction from 0 to 1 */
  passRate: number;
  /** Array of individual test results */
  results: SingleTestResult[];
  /** Duration of the entire test run in milliseconds */
  durationMs: number;
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
// Test Runner
// ============================================================================

/**
 * TestRunner executes skill test suites against skill variants using LLM simulation.
 * 
 * Since actual agent execution requires a running OpenClaw gateway (which may not
 * be available), this runner uses an LLM to simulate what the skill would produce
 * as output given an input. The simulated output is then compared against the
 * expected output using both exact and fuzzy matching.
 */
export class TestRunner {
  private config: EvolutionConfig;
  private apiKey: string;
  private apiBaseUrl: string;

  constructor(config: EvolutionConfig) {
    this.config = config;
    this.apiKey = process.env.MINIMAX_API_KEY ?? "";
    this.apiBaseUrl = "https://api.minimax.io";
  }

  /**
   * Run all test cases against a skill variant.
   * 
   * @param variant - The SkillVariant to test (from src/types.ts)
   * @param testCases - Array of DatasetEntry test cases (from src/types.ts)
   * @returns Promise resolving to aggregated TestRunResult
   */
  async runTests(
    variant: SkillVariant,
    testCases: DatasetEntry[]
  ): Promise<TestRunResult> {
    const startTime = Date.now();
    const results: SingleTestResult[] = [];

    for (const testCase of testCases) {
      const result = await this.runSingleTest(variant, testCase);
      results.push(result);
    }

    const durationMs = Date.now() - startTime;
    const passed = results.filter((r) => r.passed).length;
    const failed = results.filter((r) => !r.passed).length;

    return {
      totalTests: testCases.length,
      passed,
      failed,
      passRate: this.computePassRate(results),
      results,
      durationMs,
    };
  }

  /**
   * Run a single test case against a skill variant.
   * 
   * @param variant - The SkillVariant to test
   * @param testCase - The DatasetEntry test case to run
   * @returns Promise resolving to SingleTestResult
   */
  async runSingleTest(
    variant: SkillVariant,
    testCase: DatasetEntry
  ): Promise<SingleTestResult> {
    try {
      // Construct prompt asking LLM to simulate what the skill would do
      const prompt = this.buildSimulationPrompt(variant, testCase);

      // Call MiniMax API to get simulated output
      const simulatedOutput = await this.callMiniMax(prompt);

      // Compare simulated output against expected output
      const score = this.compareOutputs(simulatedOutput, testCase.expectedOutput);
      const passed = score >= 0.7; // Threshold for passing

      return {
        testCaseId: testCase.id,
        passed,
        simulatedOutput,
        expectedOutput: testCase.expectedOutput,
        score,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      return {
        testCaseId: testCase.id,
        passed: false,
        simulatedOutput: "",
        expectedOutput: testCase.expectedOutput,
        score: 0,
        error: errorMessage,
      };
    }
  }

  /**
   * Compute the pass rate from an array of test results.
   * 
   * @param results - Array of SingleTestResult
   * @returns Pass rate as a fraction from 0 to 1
   */
  computePassRate(results: SingleTestResult[]): number {
    if (results.length === 0) {
      return 0;
    }
    const passedCount = results.filter((r) => r.passed).length;
    return passedCount / results.length;
  }

  // ==========================================================================
  // Private Methods
  // ==========================================================================

  /**
   * Build the prompt for LLM simulation of skill behavior.
   */
  private buildSimulationPrompt(
    variant: SkillVariant,
    testCase: DatasetEntry
  ): string {
    return `You are an AI assistant following skill instructions. Given the following skill definition and input, simulate what output the skill would produce.

## SKILL DEFINITION
Skill Name: ${variant.skillName}
Generation: ${variant.generation}
Content:
${variant.content}

## INPUT
${testCase.input}

${testCase.context ? `## CONTEXT\n${JSON.stringify(testCase.context, null, 2)}\n` : ""}

## TASK
Based on the skill instructions above, simulate what output an AI assistant would produce when given the input above.

IMPORTANT: Provide ONLY the simulated output text. Do not include explanations, reasoning, or any text outside the actual output. The output should be exactly what the skill would produce.

Simulated Output:`;
  }

  /**
   * Compare simulated output against expected output using fuzzy + exact matching.
   * Returns a score from 0 to 1.
   */
  private compareOutputs(
    simulated: string,
    expected: string
  ): number {
    // First, try exact match
    if (this.isExactMatch(simulated, expected)) {
      return 1.0;
    }

    // Fall back to fuzzy matching using Levenshtein-based similarity
    return this.fuzzyMatch(simulated, expected);
  }

  /**
   * Check for exact match (case-insensitive, trimmed).
   */
  private isExactMatch(simulated: string, expected: string): boolean {
    const normalizedSimulated = simulated.trim().toLowerCase();
    const normalizedExpected = expected.trim().toLowerCase();
    return normalizedSimulated === normalizedExpected;
  }

  /**
   * Fuzzy matching using normalized Levenshtein similarity.
   * Returns a score from 0 to 1.
   */
  private fuzzyMatch(simulated: string, expected: string): number {
    const normalizedSimulated = this.normalizeText(simulated);
    const normalizedExpected = this.normalizeText(expected);

    if (normalizedSimulated === normalizedExpected) {
      return 1.0;
    }

    // Compute Levenshtein distance
    const distance = this.levenshteinDistance(normalizedSimulated, normalizedExpected);

    // Convert distance to similarity score
    // Handle empty strings
    const maxLength = Math.max(normalizedSimulated.length, normalizedExpected.length);
    if (maxLength === 0) {
      return 1.0;
    }

    const similarity = 1 - distance / maxLength;
    return Math.round(similarity * 100) / 100;
  }

  /**
   * Normalize text for comparison by lowercasing and removing extra whitespace.
   */
  private normalizeText(text: string): string {
    return text
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  /**
   * Compute Levenshtein distance between two strings.
   */
  private levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = [];

    // Initialize matrix
    for (let i = 0; i <= b.length; i++) {
      matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
      matrix[0][j] = j;
    }

    // Fill matrix
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1,     // insertion
            matrix[i - 1][j] + 1      // deletion
          );
        }
      }
    }

    return matrix[b.length][a.length];
  }

  /**
   * Call the MiniMax API to get simulated output.
   * Pattern matches: src/evolution/fitness/llm-judge.ts callMiniMax()
   */
  private async callMiniMax(prompt: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error("MINIMAX_API_KEY environment variable is not set");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
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
                  "You are an AI assistant following skill instructions. Provide only the simulated output text without explanations.",
              },
              {
                role: "user",
                content: prompt,
              },
            ],
            temperature: 0.3, // Slightly higher for creative simulation
            max_tokens: 2000,
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
}
