/**
 * OpenClaw Self-Evolution Pipeline - Trajectory Hook Handler
 * 
 * Implements the actual trajectory logging logic for 9 hooks:
 * - llm_input — capture prompt/context before LLM call
 * - llm_output — capture response after LLM call
 * - agent_end — capture turn outcome
 * - before_tool_call — capture tool invocation intent
 * - after_tool_call — capture tool result
 * - session_start — start a new episode record
 * - session_end — close episode, compute summary
 * - subagent_spawned — note subagent delegation
 * - subagent_ended — capture subagent outcome
 * 
 * Hook signatures match PluginHookHandlerMap from SDK types.d.ts
 * Source: openclaw/plugin-sdk/src/plugins/types.d.ts
 */

import type { EvolutionConfig, TurnRecordRow, EpisodeRecordRow } from "../types.js";
import type { PluginHookBeforeToolCallResult } from "../types.js";
import { getSkillRegistry } from "../collection/skill-registry.js";

// ============================================================================
// Skill Tool Detection for target_skill Attribution
// ============================================================================

// Tool names that operate on skills — extract skill identifier from params instead of using tool name
// Grounded in: reference/hermes-agent/website/docs/reference/toolsets-reference.md (skills + memory toolsets)
const SKILL_TOOLS = ['skill_manage', 'skill_view', 'memory'];

/**
 * Extract skill identifier from skill tool parameters.
 * Returns undefined if tool is not a skill tool or no skill identifier found.
 */
function extractSkillFromToolParams(toolName: string, params: Record<string, unknown>): string | undefined {
  if (!SKILL_TOOLS.includes(toolName)) return undefined;
  return (params.name ?? params.skill ?? params.skillName) as string | undefined;
}

// ============================================================================
// Hook Event Types (matching SDK PluginHookHandlerMap signatures)
// Source: openclaw/plugin-sdk/src/plugins/types.d.ts
// ============================================================================

/** SDK: PluginHookLlmInputEvent */
export type LlmInputEvent = {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  systemPrompt?: string;
  prompt: string;
  historyMessages: unknown[];
  imagesCount: number;
};

/** SDK: PluginHookLlmOutputEvent */
export type LlmOutputEvent = {
  runId: string;
  sessionId: string;
  provider: string;
  model: string;
  assistantTexts: string[];
  lastAssistant?: unknown;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
};

/** SDK: PluginHookAgentEndEvent */
export type AgentEndEvent = {
  messages: unknown[];
  success: boolean;
  error?: string;
  durationMs?: number;
};

/** SDK: PluginHookBeforeToolCallEvent */
export type BeforeToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
};

/** SDK: PluginHookAfterToolCallEvent */
export type AfterToolCallEvent = {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
};

/** SDK: PluginHookSessionStartEvent */
export type SessionStartEvent = {
  sessionId: string;
  sessionKey?: string;
  resumedFrom?: string;
};

/** SDK: PluginHookSessionEndEvent */
export type SessionEndEvent = {
  sessionId: string;
  sessionKey?: string;
  messageCount: number;
  durationMs?: number;
};

/** SDK: PluginHookSubagentSpawnedEvent */
export type SubagentSpawnedEvent = {
  childSessionKey: string;
  agentId: string;
  label?: string;
  mode: "run" | "session";
  requester?: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
  threadRequested: boolean;
  runId: string;
};

/** SDK: PluginHookSubagentEndedEvent */
export type SubagentEndedEvent = {
  targetSessionKey: string;
  targetKind: "subagent" | "acp";
  reason: string;
  sendFarewell?: boolean;
  accountId?: string;
  runId?: string;
  endedAt?: number;
  outcome?: "ok" | "error" | "timeout" | "killed" | "reset" | "deleted";
  error?: string;
};

// ============================================================================
// Hook Context Types (matching SDK types)
// Source: openclaw/plugin-sdk/src/plugins/types.d.ts
// ============================================================================

/** SDK: PluginHookAgentContext */
export type AgentContext = {
  runId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: string;
  trigger?: string;
  channelId?: string;
};

/** SDK: PluginHookToolContext */
export type ToolContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
};

/** SDK: PluginHookSessionContext */
export type SessionContext = {
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
};

/** SDK: PluginHookSubagentContext */
export type SubagentContext = {
  runId?: string;
  childSessionKey?: string;
  requesterSessionKey?: string;
};

// ============================================================================
// In-Memory State Types
// ============================================================================

/** Internal turn buffer entry with metadata for tracking */
interface TurnBufferEntry extends TurnRecordRow {
  _internal: {
    createdAt: number;
    sessionId: string;
    runId?: string;
    /** FIX 6: Store sampling decision once per turn at onLlmInput time */
    _sampled: boolean;
  };
}

/** Internal episode tracking structure */
interface ActiveEpisode {
  id: string;
  sessionKey: string;
  sessionId: string;
  startedAt: number;
  turnCount: number;
  turnIds: string[];
  skillsInvolved: Set<string>;
  totalReward: number;
}

// ============================================================================
// Utility Functions
// ============================================================================

/** Generate a unique ID with timestamp prefix */
function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

/** Safely serialize to JSON, handling circular refs */
function safeJsonStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return JSON.stringify({ error: "Failed to serialize", type: typeof obj });
  }
}

/** Extract skills mentioned in a prompt or tool call */
function extractSkillsFromText(text: string): string[] {
  const skills: string[] = [];
  // Match skill references like @skill_name or skill:skill_name
  const skillRegex = /(?:@|skill:)([a-zA-Z_][a-zA-Z0-9_-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = skillRegex.exec(text)) !== null) {
    skills.push(match[1]);
  }
  return [...new Set(skills)]; // Deduplicate
}

/** Extract skills from tool parameters */
function extractSkillsFromParams(params: Record<string, unknown>): string[] {
  const paramsJson = JSON.stringify(params);
  return extractSkillsFromText(paramsJson);
}

// ============================================================================
// Trajectory Hook Handler Class
// ============================================================================

/**
 * Handles trajectory logging for the self-evolution pipeline.
 * 
 * Implements typed handler methods for each hook, matching OpenClaw SDK
 * signatures from PluginHookHandlerMap (per SDK types.d.ts).
 * 
 * Stores captured data in memory (Map/array) — persistence to SQLite comes in T2.3.
 */
export class TrajectoryHookHandler {
  private config: EvolutionConfig;
  /** In-progress turns (mutable work-in-progress) */
  private turnBuffer: Map<string, TurnBufferEntry> = new Map();
  /** FIX 3: Finalized turns ready for persistence */
  private finalizedTurns: TurnRecordRow[] = [];
  private completedEpisodes: EpisodeRecordRow[] = [];
  private activeEpisodes: Map<string, ActiveEpisode> = new Map();
  private sessionEpisodeMap: Map<string, string> = new Map(); // sessionId -> episodeId
  private subagentParentMap: Map<string, string> = new Map(); // childSessionKey -> parentSessionId
  
  // FIX 6: Sample rate tracking for per-turn sampling
  private sampleCounter = 0;

  constructor(config: EvolutionConfig) {
    this.config = config;
  }

  // ============================================================================
  // Sampling & Config Checks
  // ============================================================================

  /**
   * Check if trajectory logging is enabled and this event should be sampled.
   * Respects config.trajectory.enabled and config.trajectory.sampleRate.
   */
  private shouldSample(): boolean {
    if (!this.config.trajectory.enabled) {
      return false;
    }

    const sampleRate = this.config.trajectory.sampleRate;
    if (sampleRate >= 1.0) {
      return true;
    }

    this.sampleCounter++;
    const shouldInclude = Math.random() < sampleRate;
    
    // Reset counter periodically to avoid overflow
    if (this.sampleCounter > 1000000) {
      this.sampleCounter = 0;
    }

    return shouldInclude;
  }

  /**
   * Check if we've exceeded max turns per session.
   */
  private isWithinTurnLimit(sessionKey: string): boolean {
    const episodeId = this.sessionEpisodeMap.get(sessionKey);
    if (!episodeId) return true;

    const episode = this.activeEpisodes.get(episodeId);
    if (!episode) return true;

    return episode.turnCount < this.config.trajectory.maxTurnsPerSession;
  }

  // ============================================================================
  // Hook Handlers (matching PluginHookHandlerMap signatures)
  // ============================================================================

  /**
   * Handle llm_input hook — capture prompt/context before LLM call.
   * 
   * SDK Signature: (event: PluginHookLlmInputEvent, ctx: PluginHookAgentContext) => Promise<void> | void
   * Source: PluginHookHandlerMap['llm_input'] per SDK types.d.ts
   * 
   * FIX 6: Sampling decision is made ONCE here and stored in the turn state.
   */
  async onLlmInput(
    event: LlmInputEvent,
    ctx: AgentContext
  ): Promise<void> {
    // FIX 6: Make sampling decision ONCE at turn start
    const sampled = this.shouldSample();
    
    // If not sampling, we still track the turn but mark it as not to be persisted
    // This allows subsequent events to check the stored decision
    if (!sampled && !this.config.trajectory.enabled) {
      return;
    }

    try {
      const sessionId = event.sessionId;
      const sessionKey = ctx.sessionKey ?? sessionId;
      const runId = event.runId;

      // Get or create episode for this session
      const episodeId = this.getOrCreateEpisode(sessionKey, ctx);
      if (!episodeId) return;

      if (!this.isWithinTurnLimit(sessionKey)) {
        return;
      }

      const episode = this.activeEpisodes.get(episodeId);
      if (!episode) return;

      episode.turnCount++;

      const turnId = generateId("turn");
      
      // CHUNK B: Detect skills from system prompt using SkillRegistry
      // This captures which SKILL.md files were injected into the context
      const systemPromptText = event.systemPrompt ?? '';
      const skillsFromSystemPrompt = getSkillRegistry().matchSkillsInText(systemPromptText);
      
      // Also extract skills from user prompt as fallback
      const skillsFromPrompt = extractSkillsFromText(event.prompt);
      
      // Combine and deduplicate skills
      const allSkillsUsed = [...new Set([...skillsFromSystemPrompt, ...skillsFromPrompt])];
      
      // Update episode skills
      allSkillsUsed.forEach(skill => episode.skillsInvolved.add(skill));

      const turn: TurnBufferEntry = {
        id: turnId,
        session_key: ctx.sessionKey ?? sessionId,
        turn_number: episode.turnCount,
        episode_id: episodeId,
        timestamp: new Date().toISOString(),
        system_prompt: event.systemPrompt,
        user_message: event.prompt,
        context_json: safeJsonStringify({
          provider: event.provider,
          model: event.model,
          imagesCount: event.imagesCount,
          historyLength: event.historyMessages?.length ?? 0,
        }),
        action_type: "response", // Will be updated if tool call follows
        action_json: safeJsonStringify({
          type: "llm_input",
          provider: event.provider,
          model: event.model,
        }),
        outcome_type: "partial", // Will be updated on llm_output or agent_end
        outcome_json: safeJsonStringify({ status: "pending" }),
        reward_signal: undefined,
        skills_used: JSON.stringify(allSkillsUsed.map(s => s.toLowerCase())),
        target_skill: allSkillsUsed[0]?.toLowerCase(), // First detected skill from system prompt or prompt (normalized to lowercase)
        _internal: {
          createdAt: Date.now(),
          sessionId,
          runId,
          _sampled: sampled, // FIX 6: Store sampling decision
        },
      };

      this.turnBuffer.set(turnId, turn);
      episode.turnIds.push(turnId);
    } catch (error) {
      // Graceful error handling — never crash the agent turn
      console.error("[self-evolution] Error in onLlmInput:", error);
    }
  }

  /**
   * Handle llm_output hook — capture response after LLM call.
   * 
   * SDK Signature: (event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext) => Promise<void> | void
   * Source: PluginHookHandlerMap['llm_output'] per SDK types.d.ts
   */
  async onLlmOutput(
    event: LlmOutputEvent,
    ctx: AgentContext
  ): Promise<void> {
    if (!this.config.trajectory.enabled) return;

    try {
      const sessionKey = ctx.sessionKey ?? event.sessionId;
      const runId = event.runId;
      const episodeId = this.sessionEpisodeMap.get(sessionKey);

      if (!episodeId) return;

      const episode = this.activeEpisodes.get(episodeId);
      if (!episode || episode.turnIds.length === 0) return;

      // Find the most recent turn for this run
      const lastTurnId = episode.turnIds[episode.turnIds.length - 1];
      const turn = this.turnBuffer.get(lastTurnId);

      if (!turn || turn._internal.runId !== runId) return;

      // FIX 6: Check stored sampling decision, don't make a new random roll
      if (!turn._internal._sampled) return;

      // Update turn with LLM output
      turn.outcome_json = safeJsonStringify({
        status: "completed",
        assistantTexts: event.assistantTexts,
        usage: event.usage,
      });

      // Calculate a simple reward signal based on usage efficiency
      if (event.usage) {
        const totalTokens = (event.usage.input ?? 0) + (event.usage.output ?? 0);
        // Simple heuristic: reward efficient responses
        turn.reward_signal = Math.max(0, 1 - (totalTokens / 10000));
        episode.totalReward += turn.reward_signal;
      }

      // If the output suggests a tool call, update action type
      const hasToolCall = event.assistantTexts.some(text => 
        text.includes("<tool>") || text.includes("<function>") || text.includes('"tool"')
      );
      if (hasToolCall) {
        turn.action_type = "tool_call";
      }
    } catch (error) {
      console.error("[self-evolution] Error in onLlmOutput:", error);
    }
  }

  /**
   * Handle agent_end hook — capture turn outcome.
   * 
   * SDK Signature: (event: PluginHookAgentEndEvent, ctx: PluginHookAgentContext) => Promise<void> | void
   * Source: PluginHookHandlerMap['agent_end'] per SDK types.d.ts
   */
  async onAgentEnd(
    event: AgentEndEvent,
    ctx: AgentContext
  ): Promise<void> {
    if (!this.config.trajectory.enabled) return;

    try {
      const sessionKey = ctx.sessionKey ?? ctx.sessionId;
      if (!sessionKey) return;

      const episodeId = this.sessionEpisodeMap.get(sessionKey);
      if (!episodeId) return;

      const episode = this.activeEpisodes.get(episodeId);
      if (!episode || episode.turnIds.length === 0) return;

      // Update the last turn with final outcome
      const lastTurnId = episode.turnIds[episode.turnIds.length - 1];
      const turn = this.turnBuffer.get(lastTurnId);

      if (turn) {
        // FIX 6: Check stored sampling decision
        if (!turn._internal._sampled) {
          // Not sampled - remove from buffer without finalizing
          this.turnBuffer.delete(lastTurnId);
          return;
        }

        turn.outcome_type = event.success ? "success" : event.error ? "error" : "failure";
        turn.outcome_json = safeJsonStringify({
          success: event.success,
          error: event.error,
          durationMs: event.durationMs,
          messageCount: event.messages?.length ?? 0,
        });

        // FIX 3: Move completed turn from turnBuffer to finalizedTurns
        const { _internal: _, ...finalizedTurn } = turn as TurnBufferEntry & { _internal: unknown };
        this.finalizedTurns.push(finalizedTurn as TurnRecordRow);
        this.turnBuffer.delete(lastTurnId);
      }
    } catch (error) {
      console.error("[self-evolution] Error in onAgentEnd:", error);
    }
  }

  /**
   * Handle before_tool_call hook — capture tool invocation intent.
   * 
   * SDK Signature: (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) => Promise<PluginHookBeforeToolCallResult | void> | PluginHookBeforeToolCallResult | void
   * Source: PluginHookHandlerMap['before_tool_call'] per SDK types.d.ts
   * 
   * Returns PluginHookBeforeToolCallResult to allow blocking/approval, or void to proceed.
   */
  async onBeforeToolCall(
    event: BeforeToolCallEvent,
    ctx: ToolContext
  ): Promise<PluginHookBeforeToolCallResult | void> {
    // FIX 6: Check if there's an existing in-progress turn for this run
    const sessionKey = ctx.sessionKey ?? ctx.sessionId;
    const runId = ctx.runId;
    let sampled = false;
    
    if (sessionKey && runId) {
      const episodeId = this.sessionEpisodeMap.get(sessionKey);
      if (episodeId) {
        const episode = this.activeEpisodes.get(episodeId);
        if (episode) {
          // Find the most recent turn for this run
          for (let i = episode.turnIds.length - 1; i >= 0; i--) {
            const turnId = episode.turnIds[i];
            const turn = this.turnBuffer.get(turnId);
            if (turn && turn._internal.runId === runId) {
              sampled = turn._internal._sampled;
              break;
            }
          }
        }
      }
    }
    
    // If no parent turn found, make a new sampling decision
    if (!sampled) {
      sampled = this.shouldSample();
    }
    
    if (!sampled) return;

    try {
      if (!sessionKey) return;

      const episodeId = this.sessionEpisodeMap.get(sessionKey);
      if (!episodeId) return;

      const episode = this.activeEpisodes.get(episodeId);
      if (!episode) return;

      if (!this.isWithinTurnLimit(sessionKey)) {
        return;
      }

      episode.turnCount++;

      const turnId = generateId("turn");
      
      // CHUNK B: Determine target_skill for tool calls
      // 1. If this is a skill tool (skill_view, skill_manage, etc.), extract skill from params
      // 2. Otherwise, inherit from parent turn's target_skill if available
      let targetSkill: string | undefined = extractSkillFromToolParams(event.toolName, event.params);
      
      // If not a skill tool, try to inherit from parent turn
      if (!targetSkill && sessionKey && runId) {
        for (let i = episode.turnIds.length - 1; i >= 0; i--) {
          const parentTurnId = episode.turnIds[i];
          const parentTurn = this.turnBuffer.get(parentTurnId);
          if (parentTurn && parentTurn._internal.runId === runId && parentTurn.target_skill) {
            targetSkill = parentTurn.target_skill;
            break;
          }
        }
      }
      
      // Build skills_used: combine detected skills from params with target skill
      const skillsFromParams = extractSkillsFromParams(event.params);
      const allSkillsUsed = [...new Set([...(targetSkill ? [targetSkill] : []), ...skillsFromParams])];
      allSkillsUsed.forEach(skill => episode.skillsInvolved.add(skill));

      // Normalize target_skill to lowercase for consistent DB queries
      const normalizedTargetSkill = targetSkill?.toLowerCase();

      const turn: TurnBufferEntry = {
        id: turnId,
        session_key: sessionKey,
        turn_number: episode.turnCount,
        episode_id: episodeId,
        timestamp: new Date().toISOString(),
        system_prompt: undefined,
        user_message: `Tool call: ${event.toolName}`,
        context_json: undefined,
        action_type: "tool_call",
        action_json: safeJsonStringify({
          toolName: event.toolName,
          params: event.params,
          toolCallId: event.toolCallId,
        }),
        outcome_type: "partial",
        outcome_json: safeJsonStringify({ status: "pending" }),
        reward_signal: undefined,
        skills_used: JSON.stringify(allSkillsUsed.map(s => s.toLowerCase())),
        target_skill: normalizedTargetSkill,
        _internal: {
          createdAt: Date.now(),
          sessionId: ctx.sessionId ?? sessionKey,
          runId,
          _sampled: sampled, // FIX 6: Store sampling decision
        },
      };

      this.turnBuffer.set(turnId, turn);
      episode.turnIds.push(turnId);
    } catch (error) {
      console.error("[self-evolution] Error in onBeforeToolCall:", error);
    }
  }

  /**
   * Handle after_tool_call hook — capture tool result.
   * 
   * SDK Signature: (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => Promise<void> | void
   * Source: PluginHookHandlerMap['after_tool_call'] per SDK types.d.ts
   */
  async onAfterToolCall(
    event: AfterToolCallEvent,
    ctx: ToolContext
  ): Promise<void> {
    if (!this.config.trajectory.enabled) return;

    try {
      const sessionKey = ctx.sessionKey ?? ctx.sessionId;
      const runId = ctx.runId;
      if (!sessionKey) return;

      const episodeId = this.sessionEpisodeMap.get(sessionKey);
      if (!episodeId) return;

      const episode = this.activeEpisodes.get(episodeId);
      if (!episode || episode.turnIds.length === 0) return;

      // Find the matching turn (most recent with same tool name and runId)
      for (let i = episode.turnIds.length - 1; i >= 0; i--) {
        const turnId = episode.turnIds[i];
        const turn = this.turnBuffer.get(turnId);

        if (turn && 
            turn._internal.runId === runId && 
            turn.target_skill === event.toolName &&
            turn.outcome_type === "partial") {
          
          // FIX 6: Check stored sampling decision
          if (!turn._internal._sampled) {
            // Not sampled - remove from buffer without finalizing
            this.turnBuffer.delete(turnId);
            break;
          }

          // Update with result
          turn.outcome_type = event.error ? "error" : "success";
          turn.outcome_json = safeJsonStringify({
            result: event.result,
            error: event.error,
            durationMs: event.durationMs,
          });

          // Simple reward based on execution time (faster = better)
          if (event.durationMs !== undefined && !event.error) {
            turn.reward_signal = Math.max(0, 1 - (event.durationMs / 5000));
            episode.totalReward += turn.reward_signal;
          }

          // FIX 3: Move completed turn to finalizedTurns
          const { _internal: _, ...finalizedTurn } = turn as TurnBufferEntry & { _internal: unknown };
          this.finalizedTurns.push(finalizedTurn as TurnRecordRow);
          this.turnBuffer.delete(turnId);

          break;
        }
      }
    } catch (error) {
      console.error("[self-evolution] Error in onAfterToolCall:", error);
    }
  }

  /**
   * Handle session_start hook — start a new episode record.
   * 
   * SDK Signature: (event: PluginHookSessionStartEvent, ctx: PluginHookSessionContext) => Promise<void> | void
   * Source: PluginHookHandlerMap['session_start'] per SDK types.d.ts
   */
  async onSessionStart(
    event: SessionStartEvent,
    ctx: SessionContext
  ): Promise<void> {
    if (!this.config.trajectory.enabled) return;

    try {
      const sessionId = event.sessionId;
      const sessionKey = ctx.sessionKey ?? sessionId;
      const episodeId = generateId("episode");

      const episode: ActiveEpisode = {
        id: episodeId,
        sessionKey,
        sessionId,
        startedAt: Date.now(),
        turnCount: 0,
        turnIds: [],
        skillsInvolved: new Set(),
        totalReward: 0,
      };

      this.activeEpisodes.set(episodeId, episode);
      // FIX: Use sessionKey (stable key) instead of sessionId (ephemeral UUID) for consistent lookup
      this.sessionEpisodeMap.set(sessionKey, episodeId);
    } catch (error) {
      console.error("[self-evolution] Error in onSessionStart:", error);
    }
  }

  /**
   * Handle session_end hook — close episode, compute summary.
   * 
   * SDK Signature: (event: PluginHookSessionEndEvent, ctx: PluginHookSessionContext) => Promise<void> | void
   * Source: PluginHookHandlerMap['session_end'] per SDK types.d.ts
   */
  async onSessionEnd(
    event: SessionEndEvent,
    ctx: SessionContext
  ): Promise<void> {
    if (!this.config.trajectory.enabled) return;

    try {
      const sessionKey = event.sessionKey ?? ctx.sessionKey ?? event.sessionId;
      const episodeId = this.sessionEpisodeMap.get(sessionKey);

      if (!episodeId) return;

      const episode = this.activeEpisodes.get(episodeId);
      if (!episode) return;

      // FIX 3: Finalize any remaining turns in the buffer for this episode
      for (const turnId of episode.turnIds) {
        const turn = this.turnBuffer.get(turnId);
        if (turn && turn._internal._sampled) {
          const { _internal: _, ...finalizedTurn } = turn as TurnBufferEntry & { _internal: unknown };
          this.finalizedTurns.push(finalizedTurn as TurnRecordRow);
        }
      }
      // Clear all turns for this episode from the buffer
      for (const turnId of episode.turnIds) {
        this.turnBuffer.delete(turnId);
      }

      // Mark episode as complete
      const episodeRow: EpisodeRecordRow = {
        id: episodeId,
        session_key: event.sessionKey ?? ctx.sessionKey ?? "unknown",
        started_at: new Date(episode.startedAt).toISOString(),
        completed_at: new Date().toISOString(),
        outcome: episode.totalReward > 0 ? "success" : episode.turnCount > 0 ? "partial" : "failure",
        skills_involved: JSON.stringify([...episode.skillsInvolved]),
        total_reward: episode.totalReward,
      };

      // Store episode in the dedicated completedEpisodes array
      this.completedEpisodes.push(episodeRow);

      // Cleanup
      this.activeEpisodes.delete(episodeId);
      this.sessionEpisodeMap.delete(sessionKey);
    } catch (error) {
      console.error("[self-evolution] Error in onSessionEnd:", error);
    }
  }

  /**
   * Handle subagent_spawned hook — note subagent delegation.
   * 
   * SDK Signature: (event: PluginHookSubagentSpawnedEvent, ctx: PluginHookSubagentContext) => Promise<void> | void
   * Source: PluginHookHandlerMap['subagent_spawned'] per SDK types.d.ts
   */
  async onSubagentSpawned(
    event: SubagentSpawnedEvent,
    ctx: SubagentContext
  ): Promise<void> {
    // FIX 6: Check if there's an existing in-progress turn for this run
    // FIX: Use requesterSessionKey (stable key) which matches sessionEpisodeMap keys
    const parentSessionKey = ctx.requesterSessionKey;
    const runId = ctx.runId;
    let sampled = false;
    
    if (parentSessionKey && runId) {
      const parentEpisodeId = this.sessionEpisodeMap.get(parentSessionKey);
      if (parentEpisodeId) {
        const episode = this.activeEpisodes.get(parentEpisodeId);
        if (episode) {
          // Find the most recent turn for this run
          for (let i = episode.turnIds.length - 1; i >= 0; i--) {
            const turnId = episode.turnIds[i];
            const turn = this.turnBuffer.get(turnId);
            if (turn && turn._internal.runId === runId) {
              sampled = turn._internal._sampled;
              break;
            }
          }
        }
      }
    }
    
    // If no parent turn found, make a new sampling decision
    if (!sampled) {
      sampled = this.shouldSample();
    }
    
    if (!sampled) return;

    try {
      const childSessionKey = event.childSessionKey;

      if (parentSessionKey) {
        this.subagentParentMap.set(childSessionKey, parentSessionKey);
      }

      // Find parent episode and add a turn for the spawn
      // FIX: Use parentSessionKey which matches sessionEpisodeMap keys
      const parentEpisodeId = parentSessionKey ? this.sessionEpisodeMap.get(parentSessionKey) : undefined;
      if (parentEpisodeId) {
        const episode = this.activeEpisodes.get(parentEpisodeId);
        if (episode && this.isWithinTurnLimit(parentSessionKey!)) {
          episode.turnCount++;

          const turnId = generateId("turn");
          const turn: TurnBufferEntry = {
            id: turnId,
            session_key: parentSessionKey!,
            turn_number: episode.turnCount,
            episode_id: parentEpisodeId,
            timestamp: new Date().toISOString(),
            system_prompt: undefined,
            user_message: `Spawned subagent: ${event.agentId}`,
            context_json: undefined,
            action_type: "subagent_spawn",
            action_json: safeJsonStringify({
              childSessionKey,
              agentId: event.agentId,
              label: event.label,
              mode: event.mode,
              runId: event.runId,
            }),
            outcome_type: "partial",
            outcome_json: safeJsonStringify({ status: "spawned" }),
            reward_signal: undefined,
            skills_used: JSON.stringify(["subagent"]),
            target_skill: event.agentId,
            _internal: {
              createdAt: Date.now(),
              sessionId: parentSessionKey!,
              runId: ctx.runId,
              _sampled: sampled, // FIX 6: Store sampling decision
            },
          };

          this.turnBuffer.set(turnId, turn);
          episode.turnIds.push(turnId);
        }
      }
    } catch (error) {
      console.error("[self-evolution] Error in onSubagentSpawned:", error);
    }
  }

  /**
   * Handle subagent_ended hook — capture subagent outcome.
   * 
   * SDK Signature: (event: PluginHookSubagentEndedEvent, ctx: PluginHookSubagentContext) => Promise<void> | void
   * Source: PluginHookHandlerMap['subagent_ended'] per SDK types.d.ts
   */
  async onSubagentEnded(
    event: SubagentEndedEvent,
    ctx: SubagentContext
  ): Promise<void> {
    if (!this.config.trajectory.enabled) return;

    try {
      const targetSessionKey = event.targetSessionKey;
      // FIX: subagentParentMap now stores/retrieves sessionKey (stable key) instead of sessionId
      const parentSessionKey = this.subagentParentMap.get(targetSessionKey);

      if (parentSessionKey) {
        const parentEpisodeId = this.sessionEpisodeMap.get(parentSessionKey);
        if (parentEpisodeId) {
          const episode = this.activeEpisodes.get(parentEpisodeId);
          if (episode) {
            // Find the spawn turn and update it
            for (const turnId of episode.turnIds) {
              const turn = this.turnBuffer.get(turnId);
              if (turn && turn.action_type === "subagent_spawn") {
                const action = JSON.parse(turn.action_json) as { childSessionKey?: string };
                if (action.childSessionKey === targetSessionKey && turn.outcome_type === "partial") {
                  // FIX 6: Check stored sampling decision
                  if (!turn._internal._sampled) {
                    // Not sampled - remove from buffer without finalizing
                    this.turnBuffer.delete(turnId);
                    break;
                  }

                  turn.outcome_type = event.outcome === "ok" ? "success" : "error";
                  turn.outcome_json = safeJsonStringify({
                    reason: event.reason,
                    outcome: event.outcome,
                    error: event.error,
                    sendFarewell: event.sendFarewell,
                  });

                  // FIX 3: Move completed turn to finalizedTurns
                  const { _internal: _, ...finalizedTurn } = turn as TurnBufferEntry & { _internal: unknown };
                  this.finalizedTurns.push(finalizedTurn as TurnRecordRow);
                  this.turnBuffer.delete(turnId);

                  break;
                }
              }
            }
          }
        }

        // Cleanup parent mapping
        this.subagentParentMap.delete(targetSessionKey);
      }
    } catch (error) {
      console.error("[self-evolution] Error in onSubagentEnded:", error);
    }
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Get or create an episode for a session.
   * Returns the episode ID or null if creation failed.
   */
  private getOrCreateEpisode(sessionKey: string, ctx: AgentContext): string | null {
    let episodeId = this.sessionEpisodeMap.get(sessionKey);
    
    if (!episodeId) {
      episodeId = generateId("episode");
      const episode: ActiveEpisode = {
        id: episodeId,
        sessionKey,
        sessionId: ctx.sessionId ?? sessionKey,
        startedAt: Date.now(),
        turnCount: 0,
        turnIds: [],
        skillsInvolved: new Set(),
        totalReward: 0,
      };
      this.activeEpisodes.set(episodeId, episode);
      this.sessionEpisodeMap.set(sessionKey, episodeId);
    }

    return episodeId;
  }

  // ============================================================================
  // Public API for T2.3 Persistence
  // ============================================================================

  /**
   * Get finalized turn records for persistence.
   * FIX 3: Returns finalizedTurns (completed turns), not in-progress buffer.
   */
  getFinalizedTurns(): TurnRecordRow[] {
    return [...this.finalizedTurns];
  }

  /**
   * Get all completed episodes for persistence.
   * Returns a copy of the completed episodes array.
   */
  getCompletedEpisodes(): EpisodeRecordRow[] {
    return [...this.completedEpisodes];
  }

  /**
   * Clear the finalized turns buffer.
   * FIX 3: Only clears finalizedTurns, not in-progress turnBuffer.
   * Call this after successfully persisting turns to SQLite.
   */
  clearFinalizedTurns(): void {
    this.finalizedTurns = [];
  }

  /**
   * Remove specific finalized turns by ID.
   * FIX 1: Used by TrajectoryLogger.flush() to remove only the turns that
   * were successfully committed, avoiding race conditions where new turns
   * added during async operations would be lost.
   */
  removeFinalizedTurns(ids: Set<string>): void {
    this.finalizedTurns = this.finalizedTurns.filter(turn => !ids.has(turn.id));
  }

  /**
   * Clear the completed episodes array.
   * Call this after successfully persisting episodes to SQLite.
   */
  clearCompletedEpisodes(): void {
    this.completedEpisodes = [];
  }

  /**
   * Remove specific completed episodes by ID.
   * FIX 1: Used by TrajectoryLogger.flush() to remove only the episodes that
   * were successfully committed, avoiding race conditions.
   */
  removeCompletedEpisodes(ids: Set<string>): void {
    this.completedEpisodes = this.completedEpisodes.filter(episode => !ids.has(episode.id));
  }

  /**
   * Get the count of finalized turns ready for persistence.
   */
  getFinalizedTurnsCount(): number {
    return this.finalizedTurns.length;
  }

  /**
   * Get active episode count (for debugging/monitoring).
   */
  getActiveEpisodeCount(): number {
    return this.activeEpisodes.size;
  }
}
