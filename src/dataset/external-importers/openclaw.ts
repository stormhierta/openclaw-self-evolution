/**
 * OpenClaw session importer.
 * 
 * Wraps the existing SessionMiner to output ParsedSession format.
 * Reads from OpenClaw JSONL session files in ~/.openclaw/agents/[agent-id]/sessions/
 * 
 * Ported from Hermes: evolution/core/external_importers.py
 * Reference: HermesSessionImporter class (lines 226-290)
 */

import type { ParsedSession, ExternalImporter } from "./base.js";
import type { SessionMiner } from "../../collection/session-miner.js";
import { SecretDetector } from "./secret-detector.js";

/**
 * Import conversations from OpenClaw session files.
 * 
 * Wraps the existing SessionMiner to extract user/assistant pairs
 * where a targetSkill is set, outputting ParsedSession format.
 */
export class OpenClawImporter implements ExternalImporter {
  readonly sourceName = "openclaw";
  private sessionMiner: SessionMiner;

  constructor(sessionMiner: SessionMiner) {
    this.sessionMiner = sessionMiner;
  }

  /**
   * Read user/assistant pairs from OpenClaw session files.
   * 
   * Extracts turns where target_skill is set, pairing user messages
   * with assistant responses.
   * 
   * @param limit - Maximum messages to return (0 = no limit)
   * @returns Array of ParsedSession objects
   */
  async extractMessages(limit = 0): Promise<ParsedSession[]> {
    // Query all turns from session miner
    const turns = await this.sessionMiner.queryTurns({});
    
    if (turns.length === 0) {
      return [];
    }

    const messages: ParsedSession[] = [];

    for (const turn of turns) {
      // Only include turns with a target skill
      if (!turn.target_skill) {
        continue;
      }

      // Skip if user message is too short
      if (!turn.user_message || turn.user_message.length < 10) {
        continue;
      }

      // Parse outcome JSON to get assistant response
      let assistantResponse: string | undefined;
      try {
        const outcomeData = JSON.parse(turn.outcome_json) as Record<string, unknown>;
        if (outcomeData.textPreview && typeof outcomeData.textPreview === "string") {
          assistantResponse = outcomeData.textPreview;
        }
      } catch {
        // Ignore parse errors
      }

      // Filter secrets from both input and response
      const taskInput = turn.user_message;
      if (SecretDetector.containsSecret(taskInput)) {
        continue;
      }
      if (assistantResponse && SecretDetector.containsSecret(assistantResponse)) {
        continue;
      }

      messages.push({
        source: "openclaw",
        taskInput,
        assistantResponse,
        project: turn.session_key, // Use session key as project identifier
        sessionId: turn.session_key,
        timestamp: turn.timestamp,
      });

      if (limit > 0 && messages.length >= limit) {
        break;
      }
    }

    return messages;
  }

  /**
   * Extract messages for a specific skill.
   * 
   * @param skillName - Name of the skill to filter by
   * @param limit - Maximum messages to return (0 = no limit)
   * @returns Array of ParsedSession objects for the skill
   */
  async extractMessagesForSkill(
    skillName: string,
    limit = 0
  ): Promise<ParsedSession[]> {
    const turns = await this.sessionMiner.queryTurns({
      skillName,
    });

    if (turns.length === 0) {
      return [];
    }

    const messages: ParsedSession[] = [];

    for (const turn of turns) {
      // Skip if user message is too short
      if (!turn.user_message || turn.user_message.length < 10) {
        continue;
      }

      // Parse outcome JSON to get assistant response
      let assistantResponse: string | undefined;
      try {
        const outcomeData = JSON.parse(turn.outcome_json) as Record<string, unknown>;
        if (outcomeData.textPreview && typeof outcomeData.textPreview === "string") {
          assistantResponse = outcomeData.textPreview;
        }
      } catch {
        // Ignore parse errors
      }

      // Filter secrets
      const taskInput = turn.user_message;
      if (SecretDetector.containsSecret(taskInput)) {
        continue;
      }
      if (assistantResponse && SecretDetector.containsSecret(assistantResponse)) {
        continue;
      }

      messages.push({
        source: "openclaw",
        taskInput,
        assistantResponse,
        project: turn.session_key,
        sessionId: turn.session_key,
        timestamp: turn.timestamp,
      });

      if (limit > 0 && messages.length >= limit) {
        break;
      }
    }

    return messages;
  }
}
