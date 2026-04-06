/**
 * OpenClaw Self-Evolution Pipeline - Task Pattern Detector
 * 
 * Detects recurring task patterns that don't have a corresponding skill
 * and recommends creating new SKILL.md files.
 * 
 * Inspired by Hermes Agent self-evolution pattern detection.
 */

import type Database from "better-sqlite3";

// ============================================================================
// Types
// ============================================================================

export interface SkillCreationRecommendation {
  pattern: string; // detected task pattern description
  occurrences: number; // how many times seen
  suggestedSkillName: string; // kebab-case suggested skill id
  confidence: number; // 0-1
  examplePrompts: string[]; // up to 3 example prompt snippets
}

interface TurnRow {
  id: string;
  user_message: string;
  action_json: string;
}

interface KeywordGroup {
  keywords: string[];
  turns: TurnRow[];
}

// ============================================================================
// TaskPatternDetector Class
// ============================================================================

export class TaskPatternDetector {
  private db: Database.Database;

  // Minimum occurrences to surface a pattern (Hermes heuristic: 5+ tool calls)
  private readonly MIN_OCCURRENCES = 5;
  // Minimum keywords that must match to group turns
  private readonly MIN_KEYWORD_MATCH = 2;
  // Maximum number of example prompts to include
  private readonly MAX_EXAMPLES = 3;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Analyze trajectory data to find recurring task patterns
   * that don't have a corresponding skill.
   * 
   * Detection logic:
   * 1. Query turns where target_skill IS NULL/empty AND outcome_type = 'success'
   * 2. Group by prompt keyword clusters using simple word frequency
   * 3. Only surface groups with 5+ turns
   * 4. Generate suggested skill names from top keywords
   */
  analyze(): SkillCreationRecommendation[] {
    // Step 1: Query successful unattributed turns
    const turns = this.queryUnattributedSuccessfulTurns();

    if (turns.length < this.MIN_OCCURRENCES) {
      return [];
    }

    // Step 2: Extract keywords and group turns
    const groups = this.clusterTurnsByKeywords(turns);

    // Step 3: Filter groups with 5+ turns and build recommendations
    const recommendations: SkillCreationRecommendation[] = [];

    for (const group of groups) {
      if (group.turns.length >= this.MIN_OCCURRENCES) {
        const recommendation = this.buildRecommendation(group);
        if (recommendation) {
          recommendations.push(recommendation);
        }
      }
    }

    // Step 4: Sort by occurrences descending
    recommendations.sort((a, b) => b.occurrences - a.occurrences);

    return recommendations;
  }

  /**
   * Query evolution_turns for successful turns with no active skill.
   * These are the turns that could benefit from a new skill.
   */
  private queryUnattributedSuccessfulTurns(): TurnRow[] {
    const query = `
      SELECT 
        id,
        user_message,
        action_json
      FROM evolution_turns
      WHERE (target_skill IS NULL OR target_skill = '') 
        AND outcome_type = 'success'
      ORDER BY timestamp DESC
      LIMIT 1000
    `;

    const stmt = this.db.prepare(query);
    return stmt.all() as TurnRow[];
  }

  /**
   * Cluster turns by keyword similarity using union-find (disjoint set).
   * Uses simple word frequency - extracts top 3 nouns/verbs from each turn
   * and groups turns that share 2+ keywords.
   * 
   * Uses transitive clustering: if A matches B and B matches C, all three
   * are grouped together even if A and C don't directly share 2+ keywords.
   */
  private clusterTurnsByKeywords(turns: TurnRow[]): KeywordGroup[] {
    // Extract keywords for each turn
    const turnKeywords: Map<string, string[]> = new Map();

    for (const turn of turns) {
      const keywords = this.extractKeywords(turn);
      turnKeywords.set(turn.id, keywords);
    }

    // Union-Find data structure for clustering
    const parent = new Map<string, string>();
    const rank = new Map<string, number>();

    function find(x: string): string {
      if (parent.get(x) !== x) {
        parent.set(x, find(parent.get(x)!));
      }
      return parent.get(x)!;
    }

    function union(x: string, y: string): void {
      const px = find(x);
      const py = find(y);
      if (px === py) return;

      const rx = rank.get(px) || 0;
      const ry = rank.get(py) || 0;

      if (rx < ry) {
        parent.set(px, py);
      } else if (rx > ry) {
        parent.set(py, px);
      } else {
        parent.set(py, px);
        rank.set(px, rx + 1);
      }
    }

    // Initialize union-find
    for (const turn of turns) {
      parent.set(turn.id, turn.id);
      rank.set(turn.id, 0);
    }

    // Build edges between turns that share MIN_KEYWORD_MATCH keywords
    for (let i = 0; i < turns.length; i++) {
      const turnA = turns[i];
      const keywordsA = turnKeywords.get(turnA.id) || [];
      if (keywordsA.length === 0) continue;

      for (let j = i + 1; j < turns.length; j++) {
        const turnB = turns[j];
        const keywordsB = turnKeywords.get(turnB.id) || [];
        if (keywordsB.length === 0) continue;

        const commonKeywords = keywordsA.filter((k) => keywordsB.includes(k));
        if (commonKeywords.length >= this.MIN_KEYWORD_MATCH) {
          union(turnA.id, turnB.id);
        }
      }
    }

    // Group turns by their root
    const groups = new Map<string, KeywordGroup>();

    for (const turn of turns) {
      const keywords = turnKeywords.get(turn.id) || [];
      if (keywords.length === 0) continue;

      const root = find(turn.id);
      
      if (!groups.has(root)) {
        groups.set(root, {
          keywords: [],
          turns: [],
        });
      }

      const group = groups.get(root)!;
      group.turns.push(turn);
      // Add all keywords from this turn to the group
      for (const k of keywords) {
        if (!group.keywords.includes(k)) {
          group.keywords.push(k);
        }
      }
    }

    // Convert to array and limit keywords to top 5
    return Array.from(groups.values())
      .map((g) => ({
        keywords: g.keywords.slice(0, 5),
        turns: g.turns,
      }))
      .filter((g) => g.turns.length >= 2); // Only keep groups with 2+ turns
  }

  /**
   * Extract keywords from a turn.
   * Combines user_message and action_json content.
   * Returns top 3 significant words (nouns/verbs) from the text.
   */
  private extractKeywords(turn: TurnRow): string[] {
    const text = this.extractTextFromTurn(turn);
    return this.extractTopKeywords(text);
  }

  /**
   * Extract searchable text from a turn record.
   */
  private extractTextFromTurn(turn: TurnRow): string {
    const parts: string[] = [];

    // Add user message
    if (turn.user_message) {
      parts.push(turn.user_message);
    }

    // Try to extract content from action_json
    try {
      const action = JSON.parse(turn.action_json) as Record<string, unknown>;
      // Extract tool names from tool calls
      if (action.tools && Array.isArray(action.tools)) {
        for (const tool of action.tools) {
          if (typeof tool === "object" && tool !== null) {
            const toolName = (tool as Record<string, unknown>).name;
            if (typeof toolName === "string") {
              parts.push(toolName);
            }
          }
        }
      }
      // Extract content field
      if (typeof action.content === "string") {
        parts.push(action.content);
      }
      // Extract tool name from tool_call
      if (action.tool_call && typeof action.tool_call === "object") {
        const toolCall = action.tool_call as Record<string, unknown>;
        if (typeof toolCall.name === "string") {
          parts.push(toolCall.name);
        }
      }
    } catch {
      // If action_json doesn't parse, use it as raw text
      parts.push(turn.action_json);
    }

    return parts.join(" ");
  }

  /**
   * Extract top keywords from text.
   * Simple heuristic: find words that are:
   * - 3+ characters long (filter out common short words like "a", "an", "to")
   * - Not in common stop words list
   * - Frequency weighted
   */
  private extractTopKeywords(text: string): string[] {
    if (!text) {
      return [];
    }

    // Normalize and tokenize
    const normalized = text.toLowerCase();
    // Include 3+ char words to catch important short terms like "git", "npm", "aws"
    const words = normalized.match(/\b[a-z]{3,}\b/g) || [];

    // Filter out common stop words (including 3-letter ones)
    const stopWords = new Set([
      // 3-letter words
      "the", "and", "for", "are", "but", "not", "you", "all", "can", "had", "her", "was", "one", "our", "out", "day", "get", "has", "him", "his", "how", "its", "may", "new", "now", "old", "see", "two", "who", "boy", "did", "she", "use", "her", "way", "many", "oil", "sit", "set", "run", "eat", "far", "sea", "eye", "ago", "off", "too", "any", "say", "man", "try", "ask", "end", "why", "let", "put", "say", "she", "try", "way", "own", "say",
      // 4+ letter words
      "this",
      "that",
      "with",
      "from",
      "they",
      "have",
      "will",
      "been",
      "were",
      "said",
      "each",
      "which",
      "their",
      "what",
      "when",
      "where",
      "who",
      "how",
      "why",
      "would",
      "could",
      "should",
      "about",
      "into",
      "through",
      "during",
      "before",
      "after",
      "above",
      "below",
      "between",
      "under",
      "again",
      "further",
      "then",
      "once",
      "here",
      "there",
      "very",
      "just",
      "more",
      "most",
      "other",
      "some",
      "such",
      "only",
      "same",
      "than",
      "only",
      "those",
      "these",
      "them",
      "than",
      "also",
      "back",
      "still",
      "being",
      "having",
      "does",
      "doing",
      "done",
      "make",
      "made",
      "come",
      "came",
      "take",
      "took",
      "know",
      "knew",
      "think",
      "thought",
      "look",
      "looked",
      "want",
      "wanted",
      "give",
      "gave",
      "find",
      "found",
      "tell",
      "told",
      "feel",
      "felt",
      "become",
      "became",
      "leave",
      "left",
      "put",
      "mean",
      "meant",
      "keep",
      "kept",
      "let",
      "begin",
      "began",
      "seem",
      "seemed",
      "help",
      "helped",
      "show",
      "showed",
      "hear",
      "heard",
      "play",
      "played",
      "move",
      "moved",
      "live",
      "lived",
      "believe",
      "believed",
      "bring",
      "brought",
      "happen",
      "happened",
      "write",
      "wrote",
      "provide",
      "provided",
      "stand",
      "stood",
      "lose",
      "lost",
      "pay",
      "paid",
      "meet",
      "met",
      "include",
      "included",
      "continue",
      "continued",
      "set",
      "learn",
      "learned",
      "change",
      "changed",
      "lead",
      "led",
      "understand",
      "understood",
      "watch",
      "watched",
      "follow",
      "followed",
      "stop",
      "stopped",
      "create",
      "created",
      "speak",
      "spoke",
      "read",
      "allow",
      "allowed",
      "add",
      "added",
      "spend",
      "spent",
      "grow",
      "grew",
      "open",
      "opened",
      "walk",
      "walked",
      "win",
      "won",
      "offer",
      "offered",
      "remember",
      "remembered",
      "love",
      "loved",
      "consider",
      "considered",
      "appear",
      "appeared",
      "buy",
      "bought",
      "wait",
      "waited",
      "serve",
      "served",
      "die",
      "died",
      "send",
      "sent",
      "expect",
      "expected",
      "build",
      "built",
      "stay",
      "stayed",
      "fall",
      "fell",
      "cut",
      "reach",
      "reached",
      "kill",
      "killed",
      "remain",
      "remained",
      "suggest",
      "suggested",
      "raise",
      "raised",
      "pass",
      "passed",
      "sell",
      "sold",
      "require",
      "required",
      "report",
      "reported",
      "decide",
      "decided",
      "pull",
      "pulled",
      "return",
      "returned",
      "explain",
      "explained",
      "carry",
      "carried",
      "develop",
      "developed",
      "hope",
      "hoped",
      "drive",
      "drove",
      "break",
      "broke",
      "receive",
      "received",
      "agree",
      "agreed",
      "support",
      "supported",
      "remove",
      "removed",
      "return",
      "returned",
      "describe",
      "described",
      "create",
      "created",
      "add",
      "added",
      "please",
      "thanks",
      "thank",
      "hello",
      "goodbye",
      "okay",
      "sure",
      "well",
      "like",
      "need",
      "want",
      "help",
      "time",
      "way",
      "year",
      "work",
      "life",
      "part",
      "place",
      "case",
      "point",
      "thing",
      "person",
      "group",
      "fact",
      "right",
      "hand",
      "high",
      "long",
      "little",
      "good",
      "great",
      "real",
      "small",
      "large",
      "next",
      "early",
      "young",
      "important",
      "public",
      "same",
      "able",
    ]);

    const significantWords = words.filter((w) => !stopWords.has(w));

    // Count frequency
    const frequency = new Map<string, number>();
    for (const word of significantWords) {
      frequency.set(word, (frequency.get(word) || 0) + 1);
    }

    // Sort by frequency and return top 3
    const sorted = Array.from(frequency.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([word]) => word);

    return sorted;
  }

  /**
   * Build a SkillCreationRecommendation from a keyword group.
   */
  private buildRecommendation(
    group: KeywordGroup
  ): SkillCreationRecommendation | null {
    if (group.turns.length === 0 || group.keywords.length === 0) {
      return null;
    }

    // Generate pattern description from keywords
    const pattern = group.keywords.join(" ");

    // Generate suggested skill name from top keyword (kebab-case)
    const topKeyword = group.keywords[0];
    const suggestedSkillName = this.toKebabCase(topKeyword);

    // Calculate confidence based on occurrences
    // More occurrences = higher confidence, capped at 0.95
    const confidence = Math.min(0.5 + group.turns.length * 0.05, 0.95);

    // Get up to 3 example prompts
    const examplePrompts = group.turns
      .slice(0, this.MAX_EXAMPLES)
      .map((t) => t.user_message)
      .filter((m) => m && m.length > 0);

    return {
      pattern,
      occurrences: group.turns.length,
      suggestedSkillName,
      confidence,
      examplePrompts,
    };
  }

  /**
   * Convert a string to kebab-case.
   * Example: "git operations" -> "git-operations"
   */
  private toKebabCase(str: string): string {
    return str
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }
}
