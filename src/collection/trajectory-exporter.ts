import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { writeFile } from "node:fs/promises";

/**
 * Convert <REASONING_SCRATCHPAD> tags to <think> tags.
 */
export function convertScratchpadToThink(content: string): string {
  if (!content || !content.includes("<REASONING_SCRATCHPAD>")) {
    return content;
  }
  return content
    .replace(/<REASONING_SCRATCHPAD>/g, "<think>")
    .replace(/<\/REASONING_SCRATCHPAD>/g, "</think>");
}

/**
 * Check if content has an opening <REASONING_SCRATCHPAD> without a closing tag.
 */
export function hasIncompleteScratchpad(content: string): boolean {
  if (!content) {
    return false;
  }
  return (
    content.includes("<REASONING_SCRATCHPAD>") &&
    !content.includes("</REASONING_SCRATCHPAD>")
  );
}

/**
 * Default directory for trajectory files.
 */
const DEFAULT_TRAJECTORY_DIR = `${process.env.HOME ?? "."}/.openclaw/trajectories`;

/**
 * Append a trajectory entry to a JSONL file.
 *
 * @param trajectory - The ShareGPT-format conversation list.
 * @param model - Model name for metadata.
 * @param completed - Whether the conversation completed successfully.
 * @param filename - Override output filename. Defaults to trajectory_samples.jsonl
 *                   or failed_trajectories.jsonl based on `completed`.
 */
export async function saveTrajectory(
  trajectory: Array<Record<string, unknown>>,
  model: string,
  completed: boolean,
  filename?: string
): Promise<void> {
  const outputFilename =
    filename ??
    (completed ? "trajectory_samples.jsonl" : "failed_trajectories.jsonl");

  const outputPath = `${DEFAULT_TRAJECTORY_DIR}/${outputFilename}`;

  const entry = {
    conversations: trajectory,
    timestamp: new Date().toISOString(),
    model,
    completed,
  };

  try {
    // Ensure directory exists
    await mkdir(dirname(outputPath), { recursive: true });

    // Append JSON line to file
    const line = JSON.stringify(entry, ensureAsciiFalse) + "\n";
    await writeFile(outputPath, line, { flag: "a", encoding: "utf-8" });

    console.log(`[trajectory-exporter] Trajectory saved to ${outputPath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[trajectory-exporter] Failed to save trajectory: ${message}`);
    // Never throw - logging failures should not break the pipeline
  }
}

/**
 * JSON stringify replacer that ensures non-ASCII characters are preserved.
 * This matches Python's ensure_ascii=False behavior.
 */
function ensureAsciiFalse(_key: string, value: unknown): unknown {
  return value;
}
