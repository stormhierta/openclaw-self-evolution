/**
 * Skill Manager Tool Schema
 * 
 * Tool registration for skill_manage following OpenClaw plugin pattern.
 */

import { skillManage } from "./skill-manager.js";
import { jsonResult } from "openclaw/plugin-sdk/agent-runtime";

/**
 * Tool registration object for skill_manage
 * Source: matching bundled plugin firecrawl tool pattern
 */
export const skillManagerTool = {
  name: "skill_manage",
  label: "Skill Manage",
  description: `Manage skills (create, update, delete). Skills are your procedural memory — reusable approaches for recurring task types. New skills go to ~/.openclaw/skills/; existing skills can be modified wherever they live.

Actions: create (full SKILL.md + optional category), patch (old_string/new_string — preferred for fixes), edit (full SKILL.md rewrite — major overhauls only), delete, write_file, remove_file.

Create when: complex task succeeded (5+ calls), errors overcome, user-corrected approach worked, non-trivial workflow discovered, or user asks you to remember a procedure.
Update when: instructions stale/wrong, OS-specific failures, missing steps or pitfalls found during use. If you used a skill and hit issues not covered by it, patch it immediately.

After difficult/iterative tasks, offer to save as a skill. Skip for simple one-offs. Confirm with user before creating/deleting.

Good skills: trigger conditions, numbered steps with exact commands, pitfalls section, verification steps.`,
  
  parameters: {
    type: "object" as const,
    properties: {
      action: {
        type: "string" as const,
        enum: ["create", "edit", "patch", "delete", "write_file", "remove_file"],
        description: "The action to perform.",
      },
      name: {
        type: "string" as const,
        description: "Skill name (lowercase, hyphens/underscores/dots, max 64 chars).",
      },
      content: {
        type: "string" as const,
        description: "Full SKILL.md content. Required for create and edit.",
      },
      category: {
        type: "string" as const,
        description: "Optional category subdirectory (e.g. devops, data-science).",
      },
      old_string: {
        type: "string" as const,
        description: "Text to find (required for patch).",
      },
      new_string: {
        type: "string" as const,
        description: "Replacement text (required for patch). Empty string to delete.",
      },
      replace_all: {
        type: "boolean" as const,
        description: "Replace all occurrences (default false).",
      },
      file_path: {
        type: "string" as const,
        description: "Supporting file path under references/, templates/, scripts/, or assets/.",
      },
      file_content: {
        type: "string" as const,
        description: "File content (required for write_file).",
      },
    },
    required: ["action", "name"],
  },

  async execute(_toolCallId: string, params: Record<string, unknown>) {
    // Dispatch to skillManage()
    const result = await skillManage(params as {
      action: string;
      name: string;
      content?: string;
      category?: string;
      file_path?: string;
      file_content?: string;
      old_string?: string;
      new_string?: string;
      replace_all?: boolean;
    });
    
    return jsonResult(result);
  },
};
