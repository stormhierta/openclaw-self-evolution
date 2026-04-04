/**
 * Two-stage relevance filter for session data.
 * 
 * Stage 1: Cheap heuristic pre-filter (keyword overlap with skill content)
 * Stage 2: LLM scoring (MiniMax) for relevance, difficulty, category, expected behavior
 * 
 * Ported from Hermes: evolution/core/external_importers.py
 * Reference: RelevanceFilter class (lines 293-400)
 */

import type { ParsedSession } from "./base.js";
import type { EvolutionConfig } from "../../types.js";

/**
 * Relevance score result from LLM evaluation
 */
export interface RelevanceScore {
  relevant: boolean;
  expectedBehavior: string;  // Rubric for LLM judge
  difficulty: 'easy' | 'medium' | 'hard';
  category: string;
}

/**
 * MiniMax API response type
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
 * Valid difficulty values
 */
const VALID_DIFFICULTIES = new Set(['easy', 'medium', 'hard']);

/**
 * Two-stage relevance filter for external session data.
 * 
 * Stage 1: Heuristic keyword overlap (cheap)
 * Stage 2: LLM scoring for relevance metadata (expensive)
 */
export class RelevanceFilter {
  private config: EvolutionConfig;
  private apiKey: string;
  private apiBaseUrl: string;

  constructor(config: EvolutionConfig) {
    this.config = config;
    this.apiKey = process.env.MINIMAX_API_KEY ?? "";
    this.apiBaseUrl = "https://api.minimax.io";
  }

  /**
   * Stage 1: Cheap heuristic pre-filter.
   * 
   * Uses keyword overlap between the message and skill description/name.
   * This is a cheap pre-filter before the LLM does proper relevance scoring.
   * 
   * @param session - The parsed session to check
   * @param skillName - Name of the target skill
   * @param skillText - Full text of the skill file
   * @returns True if the message shares enough vocabulary with the skill
   */
  private isRelevantHeuristic(
    session: ParsedSession,
    skillName: string,
    skillText: string
  ): boolean {
    const textLower = session.taskInput.toLowerCase();
    const skillLower = skillName.toLowerCase().replace(/[-_]/g, " ");

    // Exact full skill name match (handles short names like "mcp", "tdd", "git")
    if (textLower.includes(skillLower)) {
      return true;
    }

    // Individual word match (only words > 3 chars to avoid false positives)
    for (const word of skillLower.split(/\s+/)) {
      if (word.length > 3 && textLower.includes(word)) {
        return true;
      }
    }

    // Extract meaningful keywords from skill text (first 500 chars)
    const skillKeywords = new Set<string>();
    const skillTextLower = skillText.slice(0, 500).toLowerCase();
    
    for (const word of skillTextLower.split(/\s+/)) {
      // Clean word of non-alpha chars
      const cleanWord = word.replace(/[^a-z]/g, "");
      if (cleanWord.length > 4) {
        skillKeywords.add(cleanWord);
      }
    }

    // Require at least 2 keyword matches
    const messageWords = new Set(
      textLower
        .replace(/[^a-z\s]/g, "")
        .split(/\s+/)
        .filter(w => w.length > 4)
    );

    let overlapCount = 0;
    for (const keyword of skillKeywords) {
      if (messageWords.has(keyword)) {
        overlapCount++;
        if (overlapCount >= 2) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Stage 2: LLM scoring for relevance and metadata.
   * 
   * Asks MiniMax to determine:
   * - Is this task relevant to the skill?
   * - What's the expected behavior (rubric)?
   * - What's the difficulty level?
   * - What category does this test?
   * 
   * @param session - The parsed session to score
   * @param skillName - Name of the target skill
   * @param skillText - Full text of the skill file
   * @returns RelevanceScore with relevance, expectedBehavior, difficulty, category
   */
  private async scoreWithLLM(
    session: ParsedSession,
    skillName: string,
    skillText: string
  ): Promise<RelevanceScore> {
    const skillDesc = skillText.slice(0, 800);

    const prompt = this.buildScoringPrompt(session, skillName, skillDesc);
    
    try {
      const response = await this.callMiniMax(prompt);
      return this.parseScoringResponse(response);
    } catch (error) {
      // Return non-relevant on error
      return {
        relevant: false,
        expectedBehavior: "",
        difficulty: "medium",
        category: "general",
      };
    }
  }

  /**
   * Build the LLM scoring prompt.
   */
  private buildScoringPrompt(
    session: ParsedSession,
    skillName: string,
    skillDesc: string
  ): string {
    return `You are evaluating whether a user message is relevant to a specific agent skill.

## SKILL NAME
${skillName}

## SKILL DESCRIPTION
${skillDesc}

## USER MESSAGE
${session.taskInput.slice(0, 1000)}

## ASSISTANT RESPONSE (may be empty)
${(session.assistantResponse || "").slice(0, 1000)}

## TASK
Determine if this user message is relevant to the skill above. If relevant, provide:
1. Expected behavior: What should a good response do? (1-2 sentences, rubric for evaluation)
2. Difficulty: easy, medium, or hard
3. Category: What aspect of the skill this tests (e.g., "basic_usage", "edge_case", "error_handling")

Return ONLY this JSON:
{"relevant": true/false, "expected_behavior": "rubric description", "difficulty": "easy/medium/hard", "category": "category_name"}`;
  }

  /**
   * Call the MiniMax API.
   * Pattern matches: src/evolution/fitness/llm-judge.ts callMiniMax()
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
                "You are an expert AI skill evaluator. Always return valid JSON with exact field names.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          temperature: 0.1,
          max_tokens: 500,
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
  }

  /**
   * Parse the LLM scoring response.
   * Extracts JSON with relevant, expected_behavior, difficulty, category.
   */
  private parseScoringResponse(response: string): RelevanceScore {
    // Try to extract JSON from response
    const jsonMatch =
      response.match(/```(?:json)?\s*([\s\S]*?)```/) ||
      response.match(/(\{[\s\S]*\})/);
    const jsonStr = jsonMatch ? jsonMatch[1] : response;

    try {
      const parsed = JSON.parse(jsonStr.trim()) as Partial<{
        relevant: boolean;
        expected_behavior: string;
        difficulty: string;
        category: string;
      }>;

      const difficulty = this.normalizeDifficulty(parsed.difficulty);
      const category = (parsed.category || "general").trim();

      return {
        relevant: parsed.relevant === true,
        expectedBehavior: (parsed.expected_behavior || "").trim(),
        difficulty,
        category: category || "general",
      };
    } catch {
      // Return non-relevant on parse error
      return {
        relevant: false,
        expectedBehavior: "",
        difficulty: "medium",
        category: "general",
      };
    }
  }

  /**
   * Normalize difficulty to a valid value.
   */
  private normalizeDifficulty(difficulty: string | undefined): 'easy' | 'medium' | 'hard' {
    if (!difficulty) return "medium";
    const normalized = difficulty.toLowerCase().trim();
    if (VALID_DIFFICULTIES.has(normalized)) {
      return normalized as 'easy' | 'medium' | 'hard';
    }
    return "medium";
  }

  /**
   * Combined two-stage filter: heuristic then LLM scoring.
   * 
   * 1. Applies cheap heuristic pre-filter
   * 2. Scores remaining candidates with LLM
   * 3. Returns sessions with relevance scores
   * 
   * @param sessions - Array of parsed sessions to filter
   * @param skillName - Name of the target skill
   * @param skillText - Full text of the skill file
   * @param maxExamples - Maximum examples to return (default 50)
   * @returns Sessions with RelevanceScore merged in
   */
  async filterAndScore(
    sessions: ParsedSession[],
    skillName: string,
    skillText: string,
    maxExamples = 50
  ): Promise<Array<ParsedSession & RelevanceScore>> {
    // Stage 0: Drop messages missing required fields
    const validSessions = sessions.filter(
      s => s.taskInput && s.source
    );

    // Stage 1: Cheap heuristic pre-filter
    let candidates = validSessions.filter(session =>
      this.isRelevantHeuristic(session, skillName, skillText)
    );

    // If heuristics found too few, sample remaining messages
    if (candidates.length < maxExamples) {
      const candidateIds = new Set(candidates.map(s => s.sessionId));
      const remaining = validSessions.filter(
        s => !candidateIds.has(s.sessionId)
      );
      
      // Shuffle remaining
      for (let i = remaining.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
      }
      
      candidates = candidates.concat(remaining.slice(0, maxExamples * 2));
    }

    // Cap candidates to control LLM costs
    candidates = candidates.slice(0, maxExamples * 3);

    console.log(`[relevance-filter] Pre-filtered to ${candidates.length} candidates (from ${validSessions.length} total)`);

    // Stage 2: LLM relevance scoring
    const results: Array<ParsedSession & RelevanceScore> = [];
    let errors = 0;

    for (const session of candidates) {
      try {
        const score = await this.scoreWithLLM(session, skillName, skillText);
        
        if (score.relevant) {
          results.push({
            ...session,
            ...score,
          });
        }
      } catch {
        errors++;
      }

      if (results.length >= maxExamples) {
        break;
      }
    }

    // Report error rate
    if (errors > 0) {
      console.log(
        `[relevance-filter] LLM scoring: ${errors}/${candidates.length} failed (${
          (errors / Math.max(1, candidates.length)) * 100
        }% error rate)`
      );
    }

    return results;
  }
}
