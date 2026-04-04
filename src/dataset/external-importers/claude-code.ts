/**
 * Claude Code session importer.
 * 
 * Parses ~/.claude/history.jsonl to extract user messages.
 * Each line is a JSONL entry with: display (user text), timestamp, project, sessionId.
 * 
 * Ported from Hermes: evolution/core/external_importers.py
 * Reference: ClaudeCodeImporter class (lines 107-148)
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ParsedSession, ExternalImporter } from "./base.js";
import { SecretDetector } from "./secret-detector.js";

/**
 * Claude Code history.jsonl entry format
 */
interface ClaudeHistoryEntry {
  display: string;
  timestamp?: number;
  project?: string;
  sessionId?: string;
}

/**
 * Import user prompts from Claude Code history.jsonl.
 * 
 * Claude Code stores a flat JSONL of user messages at ~/.claude/history.jsonl.
 * Only user inputs are available — no assistant responses.
 */
export class ClaudeCodeImporter implements ExternalImporter {
  readonly sourceName = "claude-code";
  private readonly historyPath: string;

  constructor() {
    this.historyPath = join(homedir(), ".claude", "history.jsonl");
  }

  /**
   * Read user messages from Claude Code history.
   * 
   * @param limit - Maximum messages to return (0 = no limit)
   * @returns Array of ParsedSession objects
   */
  async extractMessages(limit = 0): Promise<ParsedSession[]> {
    if (!existsSync(this.historyPath)) {
      return [];
    }

    const messages: ParsedSession[] = [];
    
    try {
      const content = readFileSync(this.historyPath, "utf-8");
      const lines = content.split("\n").filter(line => line.trim());

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as ClaudeHistoryEntry;
          const text = entry.display || "";

          // Skip empty or very short messages
          if (!text || text.length < 10) {
            continue;
          }

          // Filter out entries with secrets
          if (SecretDetector.containsSecret(text)) {
            continue;
          }

          const timestamp = entry.timestamp 
            ? new Date(entry.timestamp).toISOString() 
            : new Date().toISOString();

          messages.push({
            source: "claude-code",
            taskInput: text,
            project: entry.project,
            sessionId: entry.sessionId || `claude_${timestamp}`,
            timestamp,
          });

          if (limit > 0 && messages.length >= limit) {
            break;
          }
        } catch {
          // Skip malformed lines
          continue;
        }
      }
    } catch {
      // Return empty array on any error
      return [];
    }

    return messages;
  }
}
