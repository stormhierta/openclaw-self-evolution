/**
 * Lightweight skill metadata utilities.
 *
 * Ported from Hermes skill_utils.py
 * This module intentionally avoids heavy dependency chains.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { load as yamlLoad } from 'js-yaml';

// ── Constants ─────────────────────────────────────────────────────────────

export const PLATFORM_MAP: Record<string, string> = {
  macos: 'darwin',
  linux: 'linux',
  windows: 'win32',
};

export const EXCLUDED_SKILL_DIRS = new Set(['.git', '.github', '.hub']);

export const SKILLS_DIR = join(homedir(), '.openclaw', 'skills');
export const SYSTEM_SKILLS_DIR = join(
  homedir(),
  '.npm-global',
  'lib',
  'node_modules',
  'openclaw',
  'skills'
);

// ── Frontmatter parsing ──────────────────────────────────────────────────

export interface FrontmatterResult {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Parse YAML frontmatter from a markdown string.
 *
 * Uses js-yaml for full YAML support (nested metadata, lists)
 * with a fallback to simple key:value splitting for robustness.
 */
export function parseFrontmatter(content: string): FrontmatterResult {
  const frontmatter: Record<string, unknown> = {};
  let body = content;

  if (!content.startsWith('---')) {
    return { frontmatter, body };
  }

  const endMatch = content.slice(3).match(/\n---\s*\n/);
  if (!endMatch || endMatch.index === undefined) {
    return { frontmatter, body };
  }

  const yamlContent = content.slice(3, 3 + endMatch.index);
  body = content.slice(3 + endMatch.index + endMatch[0].length);

  try {
    const parsed = yamlLoad(yamlContent);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      Object.assign(frontmatter, parsed);
    }
  } catch {
    // Fallback: simple key:value parsing for malformed YAML
    for (const line of yamlContent.trim().split('\n')) {
      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      frontmatter[key] = value;
    }
  }

  return { frontmatter, body };
}

// ── Platform matching ─────────────────────────────────────────────────────

/**
 * Return true when the skill is compatible with the current OS.
 *
 * Skills declare platform requirements via a top-level `platforms` list
 * in their YAML frontmatter:
 *   platforms: [macos]          // macOS only
 *   platforms: [macos, linux]   // macOS and Linux
 *
 * If the field is absent or empty the skill is compatible with all
 * platforms (backward-compatible default).
 */
export function skillMatchesPlatform(frontmatter: Record<string, unknown>): boolean {
  const platforms = frontmatter['platforms'];
  if (!platforms) return true;
  const platformList = Array.isArray(platforms) ? platforms : [platforms];
  const current = process.platform;
  for (const platform of platformList) {
    const normalized = String(platform).toLowerCase().trim();
    const mapped = PLATFORM_MAP[normalized] ?? normalized;
    if (current.startsWith(mapped)) {
      return true;
    }
  }
  return false;
}

// ── Config reading helpers ────────────────────────────────────────────────

interface OpenClawConfig {
  skills?: {
    disabled?: string[] | string;
    platform_disabled?: Record<string, string[] | string>;
    external_dirs?: string[] | string;
  };
}

function normalizeStringSet(values: unknown): Set<string> {
  if (values === null || values === undefined) {
    return new Set();
  }
  if (typeof values === 'string') {
    values = [values];
  }
  if (!Array.isArray(values)) {
    return new Set();
  }
  const result = new Set<string>();
  for (const v of values) {
    const s = String(v).trim();
    if (s) result.add(s);
  }
  return result;
}

function readOpenClawConfig(): OpenClawConfig | null {
  // Try YAML config first
  const yamlPath = join(homedir(), '.openclaw', 'config.yaml');
  if (existsSync(yamlPath)) {
    try {
      const content = readFileSync(yamlPath, 'utf-8');
      const parsed = yamlLoad(content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as OpenClawConfig;
      }
    } catch {
      // Ignore parse errors, fall through
    }
  }

  // Fallback to JSON config
  const jsonPath = join(homedir(), '.openclaw', 'openclaw.json');
  if (existsSync(jsonPath)) {
    try {
      const content = readFileSync(jsonPath, 'utf-8');
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as OpenClawConfig;
      }
    } catch {
      // Ignore parse errors
    }
  }

  return null;
}

// ── Disabled skills ───────────────────────────────────────────────────────

/**
 * Read disabled skill names from config.
 *
 * Checks `skills.disabled` and `skills.platform_disabled[platform]`
 * from ~/.openclaw/config.yaml or openclaw.json.
 */
export function getDisabledSkillNames(platform?: string): Set<string> {
  const config = readOpenClawConfig();
  if (!config?.skills) {
    return new Set();
  }

  const resolvedPlatform =
    platform ?? process.env['OPENCLAW_PLATFORM'] ?? process.env['PLATFORM'];

  if (resolvedPlatform) {
    const platformDisabled =
      config.skills.platform_disabled?.[resolvedPlatform];
    if (platformDisabled !== undefined) {
      return normalizeStringSet(platformDisabled);
    }
  }

  return normalizeStringSet(config.skills.disabled);
}

// ── External skills directories ──────────────────────────────────────────

/**
 * Read `skills.external_dirs` from config and return validated paths.
 *
 * Each entry is expanded (~ and ${VAR}) and resolved to an absolute path.
 * Only directories that actually exist are returned.
 */
export function getExternalSkillsDirs(): string[] {
  const config = readOpenClawConfig();
  if (!config?.skills) {
    return [];
  }

  let rawDirs = config.skills.external_dirs;
  if (!rawDirs) {
    return [];
  }
  if (typeof rawDirs === 'string') {
    rawDirs = [rawDirs];
  }
  if (!Array.isArray(rawDirs)) {
    return [];
  }

  const localSkills = resolve(SKILLS_DIR);
  const seen = new Set<string>();
  const result: string[] = [];

  for (const entry of rawDirs) {
    const entryStr = String(entry).trim();
    if (!entryStr) continue;

    // Expand ~ and environment variables
    const expanded = entryStr
      .replace(/^~/, homedir())
      .replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? '');
    const p = resolve(expanded);

    if (p === localSkills) continue;
    if (seen.has(p)) continue;
    if (existsSync(p)) {
      seen.add(p);
      result.push(p);
    }
  }

  return result;
}

// ── All skills directories ────────────────────────────────────────────────

/**
 * Return all skill directories: local ~/.openclaw/skills first, then external.
 *
 * The local dir is always first (and always included even if it doesn't exist
 * yet — callers handle that). External dirs follow in config order.
 * System skills dir is included last if it exists.
 */
export function getAllSkillsDirs(): string[] {
  const dirs: string[] = [SKILLS_DIR];
  dirs.push(...getExternalSkillsDirs());
  if (existsSync(SYSTEM_SKILLS_DIR)) {
    dirs.push(SYSTEM_SKILLS_DIR);
  }
  return dirs.filter((d, i, arr) => arr.indexOf(d) === i);
}

// ── Condition extraction ──────────────────────────────────────────────────

export interface SkillConditions {
  fallback_for_toolsets: unknown[];
  requires_toolsets: unknown[];
  fallback_for_tools: unknown[];
  requires_tools: unknown[];
}

/**
 * Extract conditional activation fields from parsed frontmatter.
 */
export function extractSkillConditions(
  frontmatter: Record<string, unknown>
): SkillConditions {
  let metadata = frontmatter['metadata'];
  // Handle cases where metadata is not a dict (e.g., a string from malformed YAML)
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    metadata = {};
  }
  let hermes = (metadata as Record<string, unknown>)['hermes'];
  if (!hermes || typeof hermes !== 'object' || Array.isArray(hermes)) {
    hermes = {};
  }
  const hermesObj = hermes as Record<string, unknown>;
  return {
    fallback_for_toolsets: (hermesObj['fallback_for_toolsets'] as unknown[]) ?? [],
    requires_toolsets: (hermesObj['requires_toolsets'] as unknown[]) ?? [],
    fallback_for_tools: (hermesObj['fallback_for_tools'] as unknown[]) ?? [],
    requires_tools: (hermesObj['requires_tools'] as unknown[]) ?? [],
  };
}

// ── Description extraction ────────────────────────────────────────────────

/**
 * Extract a truncated description from parsed frontmatter.
 */
export function extractSkillDescription(frontmatter: Record<string, unknown>): string {
  const rawDesc = frontmatter['description'];
  if (!rawDesc) return '';
  let desc = String(rawDesc).trim();
  // Strip surrounding quotes
  desc = desc.replace(/^['"]|['"]$/g, '');
  if (desc.length > 60) {
    return desc.slice(0, 57) + '...';
  }
  return desc;
}

// ── File iteration ────────────────────────────────────────────────────────

import { readdirSync, statSync } from 'node:fs';

/**
 * Walk skillsDir recursively, return sorted paths where filename exists.
 *
 * Excludes .git, .github, .hub directories.
 */
export function iterSkillIndexFiles(
  skillsDir: string,
  filename: string
): string[] {
  const matches: string[] = [];

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (EXCLUDED_SKILL_DIRS.has(entry)) continue;

      const fullPath = join(dir, entry);
      let isDir: boolean;
      try {
        isDir = statSync(fullPath).isDirectory();
      } catch {
        continue;
      }

      if (isDir) {
        walk(fullPath);
      } else if (entry === filename) {
        matches.push(fullPath);
      }
    }
  }

  if (existsSync(skillsDir)) {
    walk(skillsDir);
  }

  // Sort by relative path for stable ordering
  return matches.sort((a, b) => {
    const relA = a.slice(skillsDir.length + 1);
    const relB = b.slice(skillsDir.length + 1);
    return relA.localeCompare(relB);
  });
}
