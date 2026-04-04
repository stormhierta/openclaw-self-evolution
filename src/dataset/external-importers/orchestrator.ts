/**
 * External session importer orchestrator.
 * 
 * Coordinates multiple importers (Claude Code, Copilot, OpenClaw) and
 * applies the two-stage relevance filter to produce DatasetEntry objects.
 * 
 * Ported from Hermes: evolution/core/external_importers.py
 * Reference: build_dataset_from_external function (lines 403-475)
 */

import type { ParsedSession, ExternalImporter } from "./base.js";
import type { RelevanceScore } from "./relevance-filter.js";
import type { DatasetEntry, EvolutionConfig } from "../../types.js";
import { ClaudeCodeImporter } from "./claude-code.js";
import { CopilotImporter } from "./copilot.js";
import { OpenClawImporter } from "./openclaw.js";
import { RelevanceFilter, SecretDetector } from "./index.js";
import type { SessionMiner } from "../../collection/session-miner.js";

/**
 * Available import sources
 */
export type ImportSource = 'claude-code' | 'copilot' | 'openclaw';

/**
 * Main orchestrator for importing external sessions.
 * 
 * Coordinates:
 * 1. Running all specified importers in parallel
 * 2. Deduplicating by taskInput
 * 3. Filtering secrets
 * 4. Running RelevanceFilter.filterAndScore()
 * 5. Converting to DatasetEntry[] with metadata
 */
export class ExternalSessionImporter {
  private config: EvolutionConfig;
  private relevanceFilter: RelevanceFilter;
  private importers: Map<ImportSource, ExternalImporter>;

  constructor(config: EvolutionConfig, sessionMiner: SessionMiner) {
    this.config = config;
    this.relevanceFilter = new RelevanceFilter(config);
    this.importers = new Map<ImportSource, ExternalImporter>([
      ["claude-code", new ClaudeCodeImporter()],
      ["copilot", new CopilotImporter()],
      ["openclaw", new OpenClawImporter(sessionMiner)],
    ]);
  }

  /**
   * Import and filter sessions for a specific skill.
   * 
   * Flow:
   * 1. Run all specified importers in parallel
   * 2. Deduplicate (same taskInput from different sources)
   * 3. Filter secrets
   * 4. Run RelevanceFilter.filterAndScore()
   * 5. Convert to DatasetEntry[] with metadata
   * 
   * @param skillName - Name of the target skill
   * @param skillContent - Full content of the skill file
   * @param sources - Array of sources to import from (default all)
   * @param maxExamples - Maximum examples to generate (default 50)
   * @returns Array of DatasetEntry objects
   */
  async importForSkill(
    skillName: string,
    skillContent: string,
    sources: ImportSource[] = ["claude-code", "copilot", "openclaw"],
    maxExamples = 50
  ): Promise<DatasetEntry[]> {
    // Run all specified importers in parallel
    const allMessages: ParsedSession[] = [];
    const importerResults = await Promise.all(
      sources.map(async (source) => {
        const importer = this.importers.get(source);
        if (!importer) {
          console.log(`[external-importer] Unknown source: ${source}`);
          return { source, count: 0 };
        }

        console.log(`[external-importer] Importing from ${source}...`);
        const messages = await importer.extractMessages(maxExamples * 2);
        console.log(`[external-importer]   Found ${messages.length} messages from ${source}`);
        return { source, messages, count: messages.length };
      })
    );

    for (const result of importerResults) {
      if (result.messages) {
        allMessages.push(...result.messages);
      }
    }

    console.log(`[external-importer] Total messages: ${allMessages.length}`);

    if (allMessages.length === 0) {
      console.log("[external-importer] No messages found from any source.");
      return [];
    }

    // Deduplicate by taskInput
    const deduplicated = this.deduplicateByTaskInput(allMessages);
    console.log(`[external-importer] After deduplication: ${deduplicated.length}`);

    // Filter secrets (already done in importers, but double-check)
    const secretFree = deduplicated.filter(
      session => !SecretDetector.containsSecret(session.taskInput) &&
                 (!session.assistantResponse || !SecretDetector.containsSecret(session.assistantResponse))
    );
    console.log(`[external-importer] After secret filtering: ${secretFree.length}`);

    // Run relevance filter
    console.log(`[external-importer] Filtering for relevance to skill: ${skillName}`);
    const scoredSessions = await this.relevanceFilter.filterAndScore(
      secretFree,
      skillName,
      skillContent,
      maxExamples
    );

    console.log(`[external-importer] Found ${scoredSessions.length} relevant examples`);

    if (scoredSessions.length === 0) {
      console.log("[external-importer] No relevant examples found. Try a different skill or broader sources.");
      return [];
    }

    // Convert to DatasetEntry
    const entries = this.convertToDatasetEntries(scoredSessions, skillName);

    // Log source distribution
    const sourceCounts = this.countBySource(entries);
    console.log("[external-importer] Source distribution:");
    for (const [src, count] of Object.entries(sourceCounts)) {
      console.log(`  ${src}: ${count}`);
    }

    return entries;
  }

  /**
   * Deduplicate sessions by taskInput.
   * Keeps the first occurrence of each unique taskInput.
   */
  private deduplicateByTaskInput(sessions: ParsedSession[]): ParsedSession[] {
    const seen = new Set<string>();
    const deduplicated: ParsedSession[] = [];

    for (const session of sessions) {
      // Normalize taskInput for deduplication
      const normalized = session.taskInput.toLowerCase().trim();
      if (!seen.has(normalized)) {
        seen.add(normalized);
        deduplicated.push(session);
      }
    }

    return deduplicated;
  }

  /**
   * Convert scored sessions to DatasetEntry objects.
   */
  private convertToDatasetEntries(
    sessions: Array<ParsedSession & RelevanceScore>,
    skillName: string
  ): DatasetEntry[] {
    return sessions.map(session => ({
      id: `external_${session.source}_${session.sessionId}`,
      datasetId: "external_import",
      input: session.taskInput,
      expectedOutput: session.expectedBehavior || "",
      context: {
        skillName,
        source: session.source,
        sessionId: session.sessionId,
        project: session.project,
        assistantResponse: session.assistantResponse,
      },
      score: session.relevant ? 1 : 0,
      metadata: {
        source: session.source,
        difficulty: session.difficulty,
        category: session.category,
        expectedBehavior: session.expectedBehavior,
        importedAt: new Date().toISOString(),
      },
      createdAt: new Date(session.timestamp),
    }));
  }

  /**
   * Count entries by source for logging.
   */
  private countBySource(entries: DatasetEntry[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const entry of entries) {
      const source = (entry.metadata?.source as string) || "unknown";
      counts[source] = (counts[source] || 0) + 1;
    }
    return counts;
  }
}
