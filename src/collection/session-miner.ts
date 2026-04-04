/**
 * OpenClaw Self-Evolution Pipeline - Session Miner
 * 
 * Queries the OpenClaw JSON session store to extract historical turn data.
 * 
 * Design decisions based on:
 * - OpenClaw session storage: ~/.openclaw/agents/{agentId}/sessions/
 * - sessions.json: Session metadata index (maps stable session keys to session files)
 * - *.jsonl: Session transcript files with turn-level data
 * - Format: JSON Lines with event types (session, message, tool_call, etc.)
 */

import type { EvolutionConfig, TurnRecordRow, EpisodeRecordRow, TrajectoryFilter } from "../types.js";
import { join } from "node:path";
import { homedir } from "node:os";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";

/**
 * OpenClaw session event types found in JSONL files
 * 
 * IMPORTANT: OpenClaw stores tool calls INSIDE message events, NOT as separate events.
 * - Assistant tool calls: message with role="assistant" and content contains type="toolCall"
 * - Tool results: message with role="toolResult" 
 * - There are NO standalone "tool_call" or "tool_result" event types in the JSONL.
 */
type SessionEvent =
  | { type: "session"; version: number; id: string; timestamp: string; cwd?: string }
  | { type: "message"; id: string; parentId: string | null; timestamp: string; message: SessionMessage }
  | { type: "model_change"; id: string; parentId: string | null; timestamp: string; provider: string; modelId: string }
  | { type: "thinking_level_change"; id: string; parentId: string | null; timestamp: string; thinkingLevel: string }
  | { type: "custom"; customType: string; data: unknown; id: string; parentId: string | null; timestamp: string }
  | { type: string; [key: string]: unknown };

/**
 * Message payload within a session event
 */
interface SessionMessage {
  role: "user" | "assistant" | "toolResult";
  content: MessageContent[];
  timestamp?: number;
  // Assistant message fields
  api?: string;
  provider?: string;
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: Record<string, number>;
  };
  stopReason?: string;
  responseId?: string;
  // Tool result fields
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

/**
 * Individual content item in a message
 */
interface MessageContent {
  type: "text" | "toolCall" | "thinking" | "image";
  text?: string;
  // toolCall specific fields
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  // image specific fields
  url?: string;
  mimeType?: string;
}

/**
 * Session metadata from sessions.json
 */
interface SessionMetadata {
  sessionId: string;
  sessionFile: string;
  updatedAt: number;
  origin?: {
    label?: string;
    provider?: string;
    surface?: string;
  };
}

/**
 * Session index from sessions.json - maps stable session keys to metadata
 */
type SessionsIndex = Record<string, SessionMetadata>;

/**
 * SessionMiner queries the OpenClaw JSON session store to extract
 * historical turn data for evolution analysis.
 * 
 * Source: OpenClaw session storage at ~/.openclaw/agents/{agentId}/sessions/
 * - sessions.json: Maps stable session keys to session metadata
 * - *.jsonl: Session transcript files with event-level data
 */
export class SessionMiner {
  private config: EvolutionConfig;
  private sessionsIndex: SessionsIndex | null = null;
  private sessionsIndexPath: string | null = null;

  constructor(config: EvolutionConfig) {
    this.config = config;
  }

  /**
   * Get the base path to the OpenClaw agents directory.
   * 
   * @returns Path to ~/.openclaw/agents/
   */
  getSessionPath(): string {
    const dataDir = process.env.OPENCLAW_DATA_DIR;
    if (dataDir) {
      return join(dataDir, "agents");
    }
    return join(homedir(), ".openclaw", "agents");
  }

  /**
   * Load the sessions.json index file which maps stable session keys to session files.
   * 
   * @param agentId - The agent ID to load sessions for
   * @returns The sessions index or null if not found/unreadable
   */
  private loadSessionsIndex(agentId: string): SessionsIndex | null {
    const indexPath = join(this.getSessionPath(), agentId, "sessions", "sessions.json");
    
    if (!existsSync(indexPath)) {
      return null;
    }

    try {
      const content = readFileSync(indexPath, "utf-8");
      const index = JSON.parse(content) as SessionsIndex;
      this.sessionsIndexPath = indexPath;
      return index;
    } catch {
      return null;
    }
  }

  /**
   * Get all agent session directories.
   * 
   * @returns Array of agent IDs with session directories
   */
  private getAgentIds(): string[] {
    const basePath = this.getSessionPath();
    if (!existsSync(basePath)) {
      return [];
    }

    try {
      const entries = readdirSync(basePath, { withFileTypes: true });
      return entries
        .filter(e => e.isDirectory())
        .map(e => e.name);
    } catch {
      return [];
    }
  }

  /**
   * Get all session files across all agents using sessions.json index.
   * Returns stable session keys (e.g., "agent:main:telegram:direct:485259140") 
   * instead of ephemeral session IDs.
   * 
   * @returns Array of { agentId, sessionFilePath, stableSessionKey, sessionId }
   */
  private getAllSessionFiles(): Array<{ 
    agentId: string; 
    sessionFilePath: string; 
    stableSessionKey: string;
    sessionId: string;
  }> {
    const files: Array<{ 
      agentId: string; 
      sessionFilePath: string; 
      stableSessionKey: string;
      sessionId: string;
    }> = [];
    const agentIds = this.getAgentIds();

    for (const agentId of agentIds) {
      // Load sessions.json index for this agent
      const sessionsIndex = this.loadSessionsIndex(agentId);
      
      if (sessionsIndex) {
        // Use the index to get stable session keys
        for (const [stableKey, metadata] of Object.entries(sessionsIndex)) {
          if (metadata.sessionFile && existsSync(metadata.sessionFile)) {
            files.push({
              agentId,
              sessionFilePath: metadata.sessionFile,
              stableSessionKey: stableKey,
              sessionId: metadata.sessionId,
            });
          }
        }
      } else {
        // Fallback: scan directory for JSONL files if sessions.json is missing
        const sessionsDir = join(this.getSessionPath(), agentId, "sessions");
        if (!existsSync(sessionsDir)) {
          continue;
        }

        try {
          const entries = readdirSync(sessionsDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith(".jsonl") && 
                !entry.name.includes(".deleted.") && 
                !entry.name.includes(".reset.") &&
                entry.name !== "sessions.json") {
              // Extract session ID from filename (remove .jsonl extension)
              const sessionId = entry.name.replace(/\.jsonl$/, "");
              files.push({
                agentId,
                sessionFilePath: join(sessionsDir, entry.name),
                stableSessionKey: sessionId, // Fallback: use sessionId as stable key
                sessionId,
              });
            }
          }
        } catch {
          // Skip this agent's sessions on error
        }
      }
    }

    return files;
  }

  /**
   * Read and parse a JSONL session file.
   * 
   * @param filePath - Path to the .jsonl file
   * @returns Array of parsed session events
   */
  private readSessionFile(filePath: string): SessionEvent[] {
    if (!existsSync(filePath)) {
      return [];
    }

    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n").filter(line => line.trim());
      const events: SessionEvent[] = [];

      for (const line of lines) {
        try {
          const event = JSON.parse(line) as SessionEvent;
          events.push(event);
        } catch {
          // Skip malformed lines
        }
      }

      return events;
    } catch {
      return [];
    }
  }

  /**
   * Check if the session store exists and is accessible.
   * 
   * @returns true if ~/.openclaw/agents/ directory exists
   */
  isAvailable(): boolean {
    const path = this.getSessionPath();
    return existsSync(path);
  }

  /**
   * Type guard to check if an event is a message event with a valid message payload.
   */
  private isMessageEvent(event: SessionEvent): event is { type: "message"; id: string; parentId: string | null; timestamp: string; message: SessionMessage } {
    return event.type === "message" && "message" in event && event.message !== null && typeof event.message === "object";
  }

  /**
   * Convert session events to TurnRecordRow format.
   * 
   * OpenClaw stores tool calls INSIDE message events, not as separate events.
   * - Assistant tool calls: message with role="assistant" containing type="toolCall" content
   * - Tool results: message with role="toolResult"
   * - User messages: message with role="user"
   * 
   * FIX 2: skills_used is now turn-local, not session-global.
   * Each turn only tracks skills invoked in tool calls immediately associated with that turn.
   * 
   * @param stableSessionKey - The stable session key (from sessions.json)
   * @param sessionId - The ephemeral session ID (UUID from JSONL)
   * @param events - Array of session events
   * @returns Array of turn records
   */
  private eventsToTurns(stableSessionKey: string, sessionId: string, events: SessionEvent[]): TurnRecordRow[] {
    const turns: TurnRecordRow[] = [];
    let turnNumber = 0;
    let episodeId = `episode_${sessionId}`;
    let sessionStartTime = "";
    const pendingToolCalls = new Map<string, { turnIndex: number; toolName: string }>();

    // First pass: collect session info
    for (const event of events) {
      if (event.type === "session" && "id" in event && "timestamp" in event) {
        sessionStartTime = String(event.timestamp || "");
        episodeId = `episode_${String(event.id)}`;
      }
    }

    // Second pass: create turn records from messages
    // Track which skills were used in the current turn's tool calls
    let currentTurnSkills: string[] = [];
    let currentAssistantToolCalls: Array<{ name: string; id?: string }> = [];

    for (let i = 0; i < events.length; i++) {
      const event = events[i];

      if (!this.isMessageEvent(event)) {
        continue;
      }

      const msg = event.message;
      const timestamp = event.timestamp || new Date().toISOString();

      // User message turn - starts a new turn
      if (msg.role === "user") {
        turnNumber++;
        const content = (msg.content ?? [])
          .map((c: MessageContent) => {
            if (c.type === "text" && c.text) {
              return c.text;
            }
            return JSON.stringify(c);
          })
          .join(" ");

        // Reset turn-local skills tracking
        currentTurnSkills = [];
        currentAssistantToolCalls = [];

        turns.push({
          id: `${sessionId}_turn_${turnNumber}`,
          session_key: stableSessionKey, // FIX 1: Use stable session key
          turn_number: turnNumber,
          episode_id: episodeId,
          timestamp,
          system_prompt: undefined,
          user_message: content.slice(0, 10000),
          context_json: JSON.stringify({ eventId: event.id, parentId: event.parentId }),
          action_type: "response",
          action_json: JSON.stringify({ type: "user_message" }),
          outcome_type: "partial",
          outcome_json: JSON.stringify({ status: "received" }),
          reward_signal: undefined,
          skills_used: JSON.stringify([]), // Will be updated if assistant makes tool calls
          target_skill: undefined,
        });
      }

      // Assistant message - may contain tool calls
      if (msg.role === "assistant") {
        // Collect tool calls from this assistant message for turn-local tracking
        currentAssistantToolCalls = [];
        if (msg.content) {
          for (const content of msg.content) {
            if (content.type === "toolCall" && content.name) {
              currentAssistantToolCalls.push({ name: content.name, id: content.id });
              currentTurnSkills.push(content.name);
            }
          }
        }

        // Update the last user turn with assistant response info and turn-local skills
        if (turnNumber > 0) {
          const lastTurn = turns[turns.length - 1];
          if (lastTurn && lastTurn.outcome_type === "partial") {
            const content = msg.content ?? [];
            const hasToolCall = content.some((c: MessageContent) => c.type === "toolCall");
            const textContent = content
              .filter((c: MessageContent) => c.type === "text" && c.text)
              .map((c: MessageContent) => c.text)
              .join(" ");

            // Update with turn-local skills (only skills from this turn's tool calls)
            const uniqueSkills = [...new Set(currentTurnSkills)];
            lastTurn.skills_used = JSON.stringify(uniqueSkills);
            lastTurn.target_skill = uniqueSkills[0];

            lastTurn.outcome_type = "success";
            lastTurn.outcome_json = JSON.stringify({
              role: "assistant",
              hasToolCall,
              contentLength: content.length,
              textPreview: textContent?.slice(0, 500),
              model: msg.model,
              provider: msg.provider,
              usage: msg.usage,
            });

            // Calculate reward based on token efficiency
            if (msg.usage?.totalTokens) {
              lastTurn.reward_signal = Math.max(0, 1 - msg.usage.totalTokens / 10000);
            }
          }
        }

        // Create separate turns for each tool call in the assistant message
        if (msg.content) {
          for (const content of msg.content) {
            if (content.type === "toolCall" && content.name) {
              turnNumber++;
              const toolCallId = content.id || `tool_${turnNumber}`;

              // This turn only tracks its own skill (the tool being called)
              const turnSkills = [content.name];

              const turn: TurnRecordRow = {
                id: `${sessionId}_tool_${turnNumber}`,
                session_key: stableSessionKey, // FIX 1: Use stable session key
                turn_number: turnNumber,
                episode_id: episodeId,
                timestamp,
                system_prompt: undefined,
                user_message: `Tool call: ${content.name}`,
                context_json: JSON.stringify({
                  eventId: event.id,
                  parentId: event.parentId,
                  responseId: msg.responseId,
                  model: msg.model,
                }),
                action_type: "tool_call",
                action_json: JSON.stringify({
                  toolName: content.name,
                  params: content.arguments ?? {},
                  toolCallId,
                }),
                outcome_type: "partial",
                outcome_json: JSON.stringify({ status: "pending" }),
                reward_signal: undefined,
                skills_used: JSON.stringify(turnSkills), // FIX 2: Turn-local skills only
                target_skill: content.name,
              };

              turns.push(turn);
              pendingToolCalls.set(toolCallId, { turnIndex: turns.length - 1, toolName: content.name });
            }
          }
        }
      }

      // Tool result message - updates the corresponding tool call turn
      if (msg.role === "toolResult") {
        const toolCallId = msg.toolCallId;
        if (toolCallId && pendingToolCalls.has(toolCallId)) {
          const { turnIndex } = pendingToolCalls.get(toolCallId)!;
          const turn = turns[turnIndex];

          if (turn) {
            turn.outcome_type = msg.isError ? "error" : "success";

            // Extract result content
            const resultText = (msg.content ?? [])
              .map((c: MessageContent) => {
                if (c.type === "text" && c.text) {
                  return c.text;
                }
                return JSON.stringify(c);
              })
              .join(" ");

            turn.outcome_json = JSON.stringify({
              toolCallId,
              toolName: msg.toolName,
              isError: msg.isError,
              resultPreview: resultText?.slice(0, 2000),
            });

            pendingToolCalls.delete(toolCallId);
          }
        }
      }
    }

    return turns;
  }

  /**
   * Query past turns from the session store with optional filtering.
   * 
   * @param filter - Optional filter criteria
   * @returns Array of turn records
   */
  async queryTurns(filter: TrajectoryFilter = {}): Promise<TurnRecordRow[]> {
    const allTurns: TurnRecordRow[] = [];
    const sessionFiles = this.getAllSessionFiles();

    for (const { sessionFilePath, stableSessionKey, sessionId } of sessionFiles) {
      try {
        // Apply session key filter early
        if (filter.sessionKey && stableSessionKey !== filter.sessionKey) {
          continue;
        }

        const events = this.readSessionFile(sessionFilePath);
        if (events.length === 0) {
          continue;
        }

        const turns = this.eventsToTurns(stableSessionKey, sessionId, events);

        // Apply filters
        for (const turn of turns) {
          // Time range filter
          if (filter.timeRange) {
            const turnTime = new Date(turn.timestamp).getTime();
            if (turnTime < filter.timeRange.start.getTime() || turnTime > filter.timeRange.end.getTime()) {
              continue;
            }
          }

          // Outcome type filter
          if (filter.outcomeType && turn.outcome_type !== filter.outcomeType) {
            continue;
          }

          // Skill name filter
          if (filter.skillName) {
            const skills = JSON.parse(turn.skills_used) as string[];
            if (!skills.includes(filter.skillName) && turn.target_skill !== filter.skillName) {
              continue;
            }
          }

          // Reward filters
          if (filter.minReward !== undefined && (turn.reward_signal === undefined || turn.reward_signal < filter.minReward)) {
            continue;
          }
          if (filter.maxReward !== undefined && (turn.reward_signal === undefined || turn.reward_signal > filter.maxReward)) {
            continue;
          }

          allTurns.push(turn);
        }
      } catch (error) {
        console.error(`[session-miner] Error processing ${sessionFilePath}:`, error);
      }
    }

    // Sort by timestamp descending and limit
    allTurns.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    return allTurns.slice(0, 10000);
  }

  /**
   * Query past episodes from the session store.
   * 
   * @param sessionKey - Optional session key to filter by
   * @returns Array of episode records
   */
  async queryEpisodes(sessionKey?: string): Promise<EpisodeRecordRow[]> {
    const episodes: EpisodeRecordRow[] = [];
    const sessionFiles = this.getAllSessionFiles();

    for (const { sessionFilePath, stableSessionKey, sessionId } of sessionFiles) {
      // Apply session key filter
      if (sessionKey && stableSessionKey !== sessionKey) {
        continue;
      }

      try {
        const events = this.readSessionFile(sessionFilePath);
        if (events.length === 0) {
          continue;
        }

        // Find session start event
        const sessionEvent = events.find(e => e.type === "session") as { type: "session"; id: string; timestamp: string } | undefined;
        if (!sessionEvent) {
          continue;
        }

        // Get turns for this session
        const turns = this.eventsToTurns(stableSessionKey, sessionId, events);

        // Calculate episode metrics
        const skillsInvolved = new Set<string>();
        let totalReward = 0;
        let successCount = 0;
        let errorCount = 0;

        for (const turn of turns) {
          const skills = JSON.parse(turn.skills_used) as string[];
          skills.forEach(s => skillsInvolved.add(s));
          if (turn.reward_signal !== undefined) {
            totalReward += turn.reward_signal;
          }
          if (turn.outcome_type === "success") {
            successCount++;
          } else if (turn.outcome_type === "error") {
            errorCount++;
          }
        }

        // Determine outcome
        let outcome: EpisodeRecordRow["outcome"] = "partial";
        if (errorCount === 0 && successCount > 0) {
          outcome = "success";
        } else if (successCount === 0 && errorCount > 0) {
          outcome = "failure";
        }

        // Get last event timestamp for completed_at
        const lastEvent = events[events.length - 1];
        const completedAt = lastEvent?.timestamp || sessionEvent.timestamp;

        episodes.push({
          id: `episode_${sessionEvent.id}`,
          session_key: stableSessionKey, // FIX 1: Use stable session key
          started_at: sessionEvent.timestamp,
          completed_at: completedAt as string,
          outcome,
          skills_involved: JSON.stringify([...skillsInvolved]) as string,
          total_reward: totalReward,
        });
      } catch (error) {
        console.error(`[session-miner] Error processing episode from ${sessionFilePath}:`, error);
      }
    }

    // Sort by started_at descending and limit
    episodes.sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());
    return episodes.slice(0, 1000);
  }

  /**
   * Get usage statistics for a specific skill.
   * Returns counts by outcome type and other metrics.
   * 
   * @param skillName - Name of the skill to analyze
   * @returns Record of statistic name to count/value
   */
  async getSkillUsageStats(skillName: string): Promise<Record<string, number>> {
    const stats: Record<string, number> = {
      total_invocations: 0,
      unique_sessions: 0,
      avg_reward: 0,
    };

    const sessionFiles = this.getAllSessionFiles();
    const uniqueSessions = new Set<string>();
    let totalRewardSum = 0;
    let rewardCount = 0;

    for (const { sessionFilePath, stableSessionKey } of sessionFiles) {
      try {
        const events = this.readSessionFile(sessionFilePath);
        const turns = this.eventsToTurns(stableSessionKey, stableSessionKey, events);

        for (const turn of turns) {
          const skills = JSON.parse(turn.skills_used) as string[];
          const isTargetSkill = skills.includes(skillName) || turn.target_skill === skillName;

          if (isTargetSkill) {
            stats.total_invocations++;
            uniqueSessions.add(stableSessionKey);

            const outcomeKey = `outcome_${turn.outcome_type}`;
            stats[outcomeKey] = (stats[outcomeKey] || 0) + 1;

            if (turn.reward_signal !== undefined) {
              totalRewardSum += turn.reward_signal;
              rewardCount++;
            }
          }
        }
      } catch (error) {
        console.error(`[session-miner] Error getting stats from ${sessionFilePath}:`, error);
      }
    }

    stats.unique_sessions = uniqueSessions.size;
    if (rewardCount > 0) {
      stats.avg_reward = totalRewardSum / rewardCount;
    }

    return stats;
  }

  /**
   * Get the raw OpenClaw session data (if available).
   * 
   * @param sessionId - Optional session ID to filter by
   * @returns Array of raw session records
   */
  async queryRawSessions(sessionId?: string): Promise<Record<string, unknown>[]> {
    const results: Record<string, unknown>[] = [];
    const sessionFiles = this.getAllSessionFiles();

    for (const { sessionFilePath, stableSessionKey, sessionId: sid } of sessionFiles) {
      if (sessionId && sid !== sessionId) {
        continue;
      }

      try {
        const events = this.readSessionFile(sessionFilePath);
        if (events.length > 0) {
          results.push({
            sessionId: sid,
            stableSessionKey,
            filePath: sessionFilePath,
            eventCount: events.length,
            events: events.slice(0, 100), // Limit events per session
          });
        }
      } catch (error) {
        console.error(`[session-miner] Error reading raw session ${sessionFilePath}:`, error);
      }
    }

    return results;
  }

  /**
   * Close any open resources.
   * (No-op for JSON-based storage)
   */
  close(): void {
    // No resources to close for file-based storage
  }
}
