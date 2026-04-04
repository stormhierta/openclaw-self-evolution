/**
 * GitHub Copilot session importer.
 * 
 * Parses ~/.copilot/session-state/[session-id]/events.jsonl to extract user/assistant pairs.
 * Each session has workspace.yaml (project context) and events.jsonl (message stream).
 * 
 * Ported from Hermes: evolution/core/external_importers.py
 * Reference: CopilotImporter class (lines 151-223)
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ParsedSession, ExternalImporter } from "./base.js";
import { SecretDetector } from "./secret-detector.js";

/**
 * Copilot event format in events.jsonl
 */
interface CopilotEvent {
  type: string;
  data?: {
    content?: string;
    [key: string]: unknown;
  };
}

/**
 * Import conversations from GitHub Copilot session events.
 * 
 * Copilot stores sessions at ~/.copilot/session-state/[session-id]/.
 * Each session has workspace.yaml (project context) and events.jsonl
 * (chronological stream of user.message / assistant.message events).
 */
export class CopilotImporter implements ExternalImporter {
  readonly sourceName = "copilot";
  private readonly sessionDir: string;

  constructor() {
    this.sessionDir = join(homedir(), ".copilot", "session-state");
  }

  /**
   * Read user/assistant message pairs from Copilot sessions.
   * 
   * @param limit - Maximum messages to return (0 = no limit)
   * @returns Array of ParsedSession objects with taskInput and assistantResponse
   */
  async extractMessages(limit = 0): Promise<ParsedSession[]> {
    if (!existsSync(this.sessionDir)) {
      return [];
    }

    const messages: ParsedSession[] = [];
    
    // Find all events.jsonl files
    const eventFiles = this.findEventFiles();

    for (const eventsPath of eventFiles) {
      const sessionId = eventsPath.split("/").slice(-2)[0] || "unknown";
      const project = this.readWorkspace(join(eventsPath, "..", "workspace.yaml"));

      const pairs = this.parseEventsFile(eventsPath, sessionId, project);
      messages.push(...pairs);

      if (limit > 0 && messages.length >= limit) {
        break;
      }
    }

    return limit > 0 ? messages.slice(0, limit) : messages;
  }

  /**
   * Find all events.jsonl files in the session directory.
   */
  private findEventFiles(): string[] {
    try {
      const files: string[] = [];
      
      const entries = readdirSync(this.sessionDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const eventsPath = join(this.sessionDir, entry.name, "events.jsonl");
          if (existsSync(eventsPath)) {
            files.push(eventsPath);
          }
        }
      }
      
      return files;
    } catch {
      return [];
    }
  }

  /**
   * Read cwd from a Copilot workspace.yaml file.
   */
  private readWorkspace(workspacePath: string): string {
    try {
      if (!existsSync(workspacePath)) {
        return "";
      }
      const content = readFileSync(workspacePath, "utf-8");
      for (const line of content.split("\n")) {
        if (line.startsWith("cwd:")) {
          return line.split(":", 2)[1]?.trim() || "";
        }
      }
    } catch {
      // Ignore errors
    }
    return "";
  }

  /**
   * Parse a single Copilot events.jsonl into user/assistant pairs.
   */
  private parseEventsFile(
    eventsPath: string,
    sessionId: string,
    project: string
  ): ParsedSession[] {
    const pairs: ParsedSession[] = [];
    let currentUserMsg: string | null = null;
    let currentAssistantMsg: string | null = null;

    try {
      const content = readFileSync(eventsPath, "utf-8");
      const lines = content.split("\n").filter(line => line.trim());

      for (const line of lines) {
        try {
          const event = JSON.parse(line) as CopilotEvent;
          const eventType = event.type || "";
          const data = event.data || {};

          if (eventType === "user.message") {
            // Save previous pair before starting new one
            if (currentUserMsg && currentAssistantMsg) {
              if (
                !SecretDetector.containsSecret(currentUserMsg) &&
                !SecretDetector.containsSecret(currentAssistantMsg)
              ) {
                pairs.push({
                  source: "copilot",
                  taskInput: currentUserMsg,
                  assistantResponse: currentAssistantMsg,
                  project: project || undefined,
                  sessionId,
                  timestamp: new Date().toISOString(),
                });
              }
            }

            currentUserMsg = data.content || "";
            currentAssistantMsg = null;
          } else if (eventType === "assistant.message") {
            const content = data.content || "";
            if (content && currentUserMsg) {
              if (currentAssistantMsg) {
                currentAssistantMsg += "\n" + content;
              } else {
                currentAssistantMsg = content;
              }
            }
          }
        } catch {
          // Skip malformed lines
          continue;
        }
      }

      // Don't forget the last pair in the file
      if (currentUserMsg && currentAssistantMsg) {
        if (
          !SecretDetector.containsSecret(currentUserMsg) &&
          !SecretDetector.containsSecret(currentAssistantMsg)
        ) {
          pairs.push({
            source: "copilot",
            taskInput: currentUserMsg,
            assistantResponse: currentAssistantMsg,
            project: project || undefined,
            sessionId,
            timestamp: new Date().toISOString(),
          });
        }
      }
    } catch {
      // Return empty on error
    }

    return pairs;
  }
}
