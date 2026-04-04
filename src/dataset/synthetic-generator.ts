/**
 * OpenClaw Self-Evolution Pipeline - Synthetic Test Case Generator
 * 
 * Generates synthetic test cases for skill evaluation using the MiniMax API.
 * 
 * References:
 * - DatasetEntry type from src/types.ts (lines 245-255)
 * - EvolutionConfig type from src/types.ts (lines 25-35)
 * - Direct MiniMax API calls via fetch (no OpenClaw provider import per requirements)
 */

import type { DatasetEntry, DatasetEntryMetadata, EvolutionConfig, LlmConfig } from "../types.js";

/**
 * Response structure from MiniMax API
 */
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

/**
 * SyntheticGenerator generates synthetic test cases for skill evaluation.
 * 
 * Uses the MiniMax API for LLM generation.
 * Source: Direct API calls per requirements (no OpenClaw provider import)
 */
export class SyntheticGenerator {
  private config: EvolutionConfig;
  private apiKey: string;
  private apiBaseUrl: string;
  private model: string;
  private apiKeyEnvVar: string;
  private temperature: number;
  private maxTokens: number;

  constructor(config: EvolutionConfig, llmConfig?: LlmConfig) {
    this.config = config;

    // Use provided config or fall back to defaults
    this.model = llmConfig?.model ?? "MiniMax-M2.7";
    this.apiBaseUrl = llmConfig?.apiBase ?? "https://api.minimax.io";
    this.apiKeyEnvVar = llmConfig?.apiKeyEnvVar ?? "MINIMAX_API_KEY";
    this.temperature = llmConfig?.temperature ?? 0.7;
    this.maxTokens = llmConfig?.maxTokens ?? 4000;

    this.apiKey = process.env[this.apiKeyEnvVar] ?? "";
  }

  /**
   * Generate synthetic test cases for a specific skill.
   * 
   * @param skillName - Name of the skill to generate test cases for
   * @param skillDescription - Description of what the skill does
   * @param count - Number of test cases to generate (default: 10)
   * @returns Array of generated DatasetEntry objects
   */
  async generateForSkill(
    skillName: string,
    skillDescription: string,
    count: number = 10
  ): Promise<DatasetEntry[]> {
    const prompt = this.buildGenerationPrompt(skillName, skillDescription, count);
    
    const response = await this.callMiniMax(prompt);
    const parsed = this.parseGenerationResponse(response, skillName);
    
    // Validate all entries
    const validEntries = parsed.filter(entry => this.validateEntry(entry));
    
    if (validEntries.length === 0) {
      throw new Error(`Failed to generate valid test cases for skill: ${skillName}`);
    }
    
    return validEntries;
  }

  /**
   * Generate variants of an existing test case.
   * 
   * @param baseEntry - The base DatasetEntry to generate variants from
   * @param count - Number of variants to generate (default: 5)
   * @returns Array of variant DatasetEntry objects
   */
  async generateVariants(
    baseEntry: DatasetEntry,
    count: number = 5
  ): Promise<DatasetEntry[]> {
    const prompt = this.buildVariantPrompt(baseEntry, count);
    
    const response = await this.callMiniMax(prompt);
    const parsed = this.parseVariantResponse(response, baseEntry);
    
    // Validate all entries
    const validEntries = parsed.filter(entry => this.validateEntry(entry));
    
    return validEntries;
  }

  /**
   * Validate that a DatasetEntry has all required fields.
   * 
   * Required fields per DatasetEntry type (src/types.ts lines 245-255):
   * - id: string
   * - datasetId: string
   * - input: string
   * - expectedOutput: string
   * - createdAt: Date
   * 
   * @param entry - The entry to validate
   * @returns True if the entry is valid
   */
  validateEntry(entry: DatasetEntry): boolean {
    if (!entry || typeof entry !== "object") {
      return false;
    }
    
    // Check required fields
    if (typeof entry.id !== "string" || entry.id.length === 0) {
      return false;
    }
    
    if (typeof entry.datasetId !== "string" || entry.datasetId.length === 0) {
      return false;
    }
    
    if (typeof entry.input !== "string" || entry.input.length === 0) {
      return false;
    }
    
    if (typeof entry.expectedOutput !== "string" || entry.expectedOutput.length === 0) {
      return false;
    }
    
    if (!(entry.createdAt instanceof Date) || isNaN(entry.createdAt.getTime())) {
      return false;
    }
    
    return true;
  }

  /**
   * Build the prompt for generating test cases for a skill.
   */
  private buildGenerationPrompt(
    skillName: string,
    skillDescription: string,
    count: number
  ): string {
    return `Generate ${count} diverse test cases for evaluating an AI skill.

Skill Name: ${skillName}
Skill Description: ${skillDescription}

For each test case, provide:
1. An input query that a user might send to this skill
2. The expected output that the skill should produce
3. A behavioral rubric describing what the agent should do (not exact text)
4. Difficulty level (easy, medium, or hard)
5. Category describing what aspect of the skill this tests

Make the test cases diverse in:
- Complexity (simple to complex)
- Edge cases and corner cases
- Different phrasings and styles
- Various user intents related to the skill

Return ONLY a JSON array with this exact structure:
[
  {
    "input": "user query here",
    "expected_output": "expected skill response here",
    "expected_behavior": "rubric: the agent should ... (behavioral description, not exact text)",
    "difficulty": "easy|medium|hard",
    "category": "what aspect of the skill this tests",
    "context": { "optional": "context object" }
  },
  ...
]

Do not include any explanation or markdown formatting, only the JSON array.`;
  }

  /**
   * Build the prompt for generating variants of an existing test case.
   */
  private buildVariantPrompt(baseEntry: DatasetEntry, count: number): string {
    return `Generate ${count} variants of the following test case.

Original Input: ${baseEntry.input}
Original Expected Output: ${baseEntry.expectedOutput}

Create variants that:
- Rephrase the input in different ways while keeping the same intent
- Change tone, formality, or style
- Add or remove context while preserving the core request
- Test robustness of the skill

Return ONLY a JSON array with this exact structure:
[
  {
    "input": "variant user query here",
    "expected_output": "expected skill response here",
    "context": { "optional": "context object" }
  },
  ...
]

Do not include any explanation or markdown formatting, only the JSON array.`;
  }

  /**
   * Call the MiniMax API with the given prompt.
   */
  private async callMiniMax(prompt: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error(`${this.apiKeyEnvVar} environment variable is not set`);
    }

    const response = await fetch(`${this.apiBaseUrl}/v1/text/chatcompletion_v2`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          {
            role: "system",
            content: "You are a helpful assistant that generates test cases for AI skill evaluation. Always return valid JSON.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
        temperature: this.temperature,
        max_tokens: this.maxTokens,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`MiniMax API error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = await response.json() as MiniMaxResponse;
    
    // Check MiniMax base_resp status_code
    if (data.base_resp && data.base_resp.status_code !== 0) {
      throw new Error(`MiniMax API error: ${data.base_resp.status_msg} (code ${data.base_resp.status_code})`);
    }
    
    if (data.error) {
      throw new Error(`MiniMax API error: ${data.error.message}`);
    }

    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("MiniMax API returned empty content");
    }

    return content;
  }

  /**
   * Parse the LLM response into DatasetEntry objects for skill generation.
   */
  private parseGenerationResponse(response: string, skillName: string): DatasetEntry[] {
    const entries: DatasetEntry[] = [];

    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                        response.match(/(\[[\s\S]*\])/);
      const jsonStr = jsonMatch ? jsonMatch[1] : response;

      const parsed = JSON.parse(jsonStr.trim()) as Array<{
        input: string;
        expected_output: string;
        expected_behavior?: string;
        difficulty?: 'easy' | 'medium' | 'hard';
        category?: string;
        context?: Record<string, unknown>;
      }>;

      const now = new Date();
      const datasetId = `synthetic-${skillName}-${Date.now()}`;

      for (let i = 0; i < parsed.length; i++) {
        const item = parsed[i];
        const metadata: DatasetEntryMetadata = {
          source: 'synthetic',
          difficulty: item.difficulty,
          category: item.category,
          expectedBehavior: item.expected_behavior,
        };
        entries.push({
          id: `synth-${skillName}-${Date.now()}-${i}`,
          datasetId,
          input: item.input,
          expectedOutput: item.expected_output,
          context: item.context,
          metadata,
          createdAt: now,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse generation response: ${message}`);
    }

    return entries;
  }

  /**
   * Parse the LLM response into DatasetEntry objects for variant generation.
   */
  private parseVariantResponse(response: string, baseEntry: DatasetEntry): DatasetEntry[] {
    const entries: DatasetEntry[] = [];

    try {
      // Extract JSON from response (handle markdown code blocks)
      const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                        response.match(/(\[[\s\S]*\])/);
      const jsonStr = jsonMatch ? jsonMatch[1] : response;

      const parsed = JSON.parse(jsonStr.trim()) as Array<{
        input: string;
        expected_output: string;
        context?: Record<string, unknown>;
      }>;

      const now = new Date();

      for (let i = 0; i < parsed.length; i++) {
        const item = parsed[i];
        // Inherit metadata from base entry, mark as variant
        const metadata: DatasetEntryMetadata = {
          ...baseEntry.metadata,
          source: 'synthetic',
        };
        entries.push({
          id: `variant-${baseEntry.id}-${Date.now()}-${i}`,
          datasetId: baseEntry.datasetId,
          input: item.input,
          expectedOutput: item.expected_output,
          context: item.context ?? baseEntry.context,
          metadata,
          createdAt: now,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse variant response: ${message}`);
    }

    return entries;
  }
}
