/**
 * Skill Manager Tool -- Agent-Managed Skill Creation & Editing
 * 
 * TypeScript port of Hermes skill_manager_tool.py
 * Allows the agent to create, update, and delete skills.
 */

import { promises as fs, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { homedir } from "node:os";
import { tmpdir } from "node:os";
import { mkdtemp, writeFile as fsWriteFile, unlink, rename, rmdir } from "node:fs/promises";
import yaml from "js-yaml";
import { containsSecretInAny } from "../collection/secret-detector.js";

// All skills live in ~/.openclaw/skills/ (single source of truth)
const SKILLS_DIR = join(homedir(), ".openclaw", "skills");

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_SKILL_CONTENT_CHARS = 100_000; // ~36k tokens at 2.75 chars/token
const MAX_SKILL_FILE_BYTES = 1_048_576; // 1 MiB per supporting file

// Characters allowed in skill names (filesystem-safe, URL-friendly)
const VALID_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

// Subdirectories allowed for write_file/remove_file
const ALLOWED_SUBDIRS = new Set(["references", "templates", "scripts", "assets"]);

/**
 * Return type for all skill manager actions
 */
export interface SkillManageResult {
  success: boolean;
  message?: string;
  error?: string;
  path?: string;
  [key: string]: unknown;
}

// =============================================================================
// Validation helpers
// =============================================================================

/**
 * Validate a skill name. Returns error message or null if valid.
 */
export function validateName(name: string): string | null {
  if (!name) {
    return "Skill name is required.";
  }
  if (name.length > MAX_NAME_LENGTH) {
    return `Skill name exceeds ${MAX_NAME_LENGTH} characters.`;
  }
  if (!VALID_NAME_RE.test(name)) {
    return (
      `Invalid skill name '${name}'. Use lowercase letters, numbers, ` +
      `hyphens, dots, and underscores. Must start with a letter or digit.`
    );
  }
  return null;
}

/**
 * Validate an optional category name used as a single directory segment.
 */
export function validateCategory(category: string | null | undefined): string | null {
  if (category === null || category === undefined) {
    return null;
  }
  if (typeof category !== "string") {
    return "Category must be a string.";
  }

  category = category.trim();
  if (!category) {
    return null;
  }
  if (category.includes("/") || category.includes("\\")) {
    return (
      `Invalid category '${category}'. Use lowercase letters, numbers, ` +
      "hyphens, dots, and underscores. Categories must be a single directory name."
    );
  }
  if (category.length > MAX_NAME_LENGTH) {
    return `Category exceeds ${MAX_NAME_LENGTH} characters.`;
  }
  if (!VALID_NAME_RE.test(category)) {
    return (
      `Invalid category '${category}'. Use lowercase letters, numbers, ` +
      "hyphens, dots, and underscores. Categories must be a single directory name."
    );
  }
  return null;
}

/**
 * Validate that SKILL.md content has proper frontmatter with required fields.
 * Returns error message or null if valid.
 */
export function validateFrontmatter(content: string): string | null {
  if (!content.trim()) {
    return "Content cannot be empty.";
  }

  if (!content.startsWith("---")) {
    return "SKILL.md must start with YAML frontmatter (---). See existing skills for format.";
  }

  const endMatch = content.slice(3).match(/\n---\s*\n/);
  if (!endMatch) {
    return "SKILL.md frontmatter is not closed. Ensure you have a closing '---' line.";
  }

  const yamlContent = content.slice(3, 3 + endMatch.index!);

  try {
    const parsed = yaml.load(yamlContent);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return "Frontmatter must be a YAML mapping (key: value pairs).";
    }
    const parsedObj = parsed as Record<string, unknown>;

    if (!("name" in parsedObj)) {
      return "Frontmatter must include 'name' field.";
    }
    if (!("description" in parsedObj)) {
      return "Frontmatter must include 'description' field.";
    }
    if (String(parsedObj["description"]).length > MAX_DESCRIPTION_LENGTH) {
      return `Description exceeds ${MAX_DESCRIPTION_LENGTH} characters.`;
    }
  } catch (e) {
    return `YAML frontmatter parse error: ${e}`;
  }

  const body = content.slice(3 + endMatch.index! + endMatch[0].length).trim();
  if (!body) {
    return "SKILL.md must have content after the frontmatter (instructions, procedures, etc.).";
  }

  return null;
}

/**
 * Check that content doesn't exceed the character limit for agent writes.
 * Returns an error message or null if within bounds.
 */
export function validateContentSize(content: string, label = "SKILL.md"): string | null {
  if (content.length > MAX_SKILL_CONTENT_CHARS) {
    return (
      `${label} content is ${content.length.toLocaleString()} characters ` +
      `(limit: ${MAX_SKILL_CONTENT_CHARS.toLocaleString()}). ` +
      `Consider splitting into a smaller SKILL.md with supporting files ` +
      `in references/ or templates/.`
    );
  }
  return null;
}

/**
 * Build the directory path for a new skill, optionally under a category.
 */
function resolveSkillDir(name: string, category?: string): string {
  if (category) {
    return join(SKILLS_DIR, category, name);
  }
  return join(SKILLS_DIR, name);
}

/**
 * Find a skill by name across all skill directories.
 * Searches ~/.openclaw/skills/ (user skills) and ~/.npm-global/lib/node_modules/openclaw/skills/ (system skills).
 * Returns { path: string } or null.
 */
export async function findSkill(name: string): Promise<{ path: string } | null> {
  // Search in ~/.openclaw/skills/ (user skills)
  if (existsSync(SKILLS_DIR)) {
    const result = await searchSkillDir(SKILLS_DIR, name);
    if (result) return result;
  }

  // Search in ~/.npm-global/lib/node_modules/openclaw/skills/ (system skills)
  const systemSkillsDir = join(homedir(), ".npm-global", "lib", "node_modules", "openclaw", "skills");
  if (existsSync(systemSkillsDir)) {
    const result = await searchSkillDir(systemSkillsDir, name);
    if (result) return result;
  }

  return null;
}

/**
 * Helper to search a single skill directory for a skill by name.
 */
async function searchSkillDir(dir: string, name: string): Promise<{ path: string } | null> {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      // Check if this directory contains SKILL.md and matches the name
      const skillMdPath = join(fullPath, "SKILL.md");
      if (entry.name === name && existsSync(skillMdPath)) {
        return { path: fullPath };
      }

      // Recurse into subdirectories (for category folders)
      const result = await searchSkillDir(fullPath, name);
      if (result) {
        return result;
      }
    }
  }
  return null;
}

/**
 * Validate a file path for write_file/remove_file.
 * Must be under an allowed subdirectory and not escape the skill dir.
 */
export function validateFilePath(filePath: string): string | null {
  if (!filePath) {
    return "file_path is required.";
  }

  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(p => p.length > 0);

  // Prevent path traversal
  if (parts.includes("..")) {
    return "Path traversal ('..') is not allowed.";
  }

  // Must be under an allowed subdirectory
  if (parts.length === 0 || !ALLOWED_SUBDIRS.has(parts[0])) {
    const allowed = Array.from(ALLOWED_SUBDIRS).sort().join(", ");
    return `File must be under one of: ${allowed}. Got: '${filePath}'`;
  }

  // Must have a filename (not just a directory)
  if (parts.length < 2) {
    return `Provide a file path, not just a directory. Example: '${parts[0]}/myfile.md'`;
  }

  return null;
}

/**
 * Atomically write text content to a file.
 * Uses a temporary file in the same directory and fs.rename() to ensure
 * the target file is never left in a partially-written state.
 */
export async function atomicWriteText(filePath: string, content: string): Promise<void> {
  const dir = dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const tempPath = filePath + '.tmp.' + process.pid;

  try {
    await fs.writeFile(tempPath, content, 'utf-8');
    await fs.rename(tempPath, filePath);
  } catch (error) {
    try { await fs.unlink(tempPath); } catch { /* ignore cleanup errors */ }
    throw error;
  }
}

/**
 * Helper to get basename (cross-platform)
 */
function basename(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
}

/**
 * Scan a skill directory for secrets. Returns error string if secrets found, else null.
 */
export async function secretScanSkill(skillDir: string): Promise<string | null> {
  // Find all .md files in the skill directory
  const mdFiles: string[] = [];
  
  async function collectMdFiles(dir: string): Promise<void> {
    if (!existsSync(dir)) return;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await collectMdFiles(fullPath);
      } else if (entry.name.endsWith(".md")) {
        mdFiles.push(fullPath);
      }
    }
  }
  
  await collectMdFiles(skillDir);
  
  // Read and scan each file
  for (const filePath of mdFiles) {
    try {
      const content = await fs.readFile(filePath, "utf-8");
      if (containsSecretInAny(content)) {
        const relPath = relative(skillDir, filePath);
        return `Security scan blocked this skill: potential secrets detected in ${relPath}`;
      }
    } catch {
      // Skip files we can't read
    }
  }
  
  return null;
}

// =============================================================================
// Core actions
// =============================================================================

/**
 * Create a new user skill with SKILL.md content.
 */
export async function createSkill(
  name: string,
  content: string,
  category?: string
): Promise<SkillManageResult> {
  // Validate name
  let err = validateName(name);
  if (err) {
    return { success: false, error: err };
  }

  err = validateCategory(category);
  if (err) {
    return { success: false, error: err };
  }

  // Validate content
  err = validateFrontmatter(content);
  if (err) {
    return { success: false, error: err };
  }

  err = validateContentSize(content);
  if (err) {
    return { success: false, error: err };
  }

  // Check for name collisions across all directories
  const existing = await findSkill(name);
  if (existing) {
    return {
      success: false,
      error: `A skill named '${name}' already exists at ${existing.path}.`,
    };
  }

  // Create the skill directory
  const skillDir = resolveSkillDir(name, category);
  await fs.mkdir(skillDir, { recursive: true });

  // Write SKILL.md atomically
  const skillMd = join(skillDir, "SKILL.md");
  
  try {
    await atomicWriteText(skillMd, content);
  } catch (error) {
    // Clean up on write failure
    await fs.rm(skillDir, { recursive: true, force: true });
    return { success: false, error: `Failed to write SKILL.md: ${error}` };
  }

  // Security scan — roll back on block
  const scanError = await secretScanSkill(skillDir);
  if (scanError) {
    await fs.rm(skillDir, { recursive: true, force: true });
    return { success: false, error: scanError };
  }

  const result: SkillManageResult = {
    success: true,
    message: `Skill '${name}' created.`,
    path: relative(SKILLS_DIR, skillDir),
  };
  
  if (category) {
    result.category = category;
  }
  
  result.hint = (
    `To add reference files, templates, or scripts, use ` +
    `skill_manage(action='write_file', name='${name}', file_path='references/example.md', file_content='...')`
  );
  
  return result;
}

/**
 * Replace the SKILL.md of any existing skill (full rewrite).
 */
export async function editSkill(name: string, content: string): Promise<SkillManageResult> {
  let err = validateFrontmatter(content);
  if (err) {
    return { success: false, error: err };
  }

  err = validateContentSize(content);
  if (err) {
    return { success: false, error: err };
  }

  const existing = await findSkill(name);
  if (!existing) {
    return { success: false, error: `Skill '${name}' not found. Use skills_list() to see available skills.` };
  }

  const skillMd = join(existing.path, "SKILL.md");

  // Back up original content for rollback
  let originalContent: string | null = null;
  if (existsSync(skillMd)) {
    originalContent = await fs.readFile(skillMd, "utf-8");
  }

  try {
    await atomicWriteText(skillMd, content);
  } catch (error) {
    // Rollback on error
    if (originalContent !== null) {
      await atomicWriteText(skillMd, originalContent).catch(() => {});
    }
    return { success: false, error: `Failed to write SKILL.md: ${error}` };
  }

  // Security scan — roll back on block
  const scanError = await secretScanSkill(existing.path);
  if (scanError) {
    if (originalContent !== null) {
      await atomicWriteText(skillMd, originalContent);
    }
    return { success: false, error: scanError };
  }

  return {
    success: true,
    message: `Skill '${name}' updated.`,
    path: existing.path,
  };
}

/**
 * Targeted find-and-replace within a skill file.
 * Defaults to SKILL.md. Use file_path to patch a supporting file instead.
 */
export async function patchSkill(
  name: string,
  oldString: string,
  newString: string,
  filePath?: string,
  replaceAll = false
): Promise<SkillManageResult> {
  if (!oldString) {
    return { success: false, error: "old_string is required for 'patch'." };
  }
  if (newString === undefined || newString === null) {
    return { success: false, error: "new_string is required for 'patch'. Use an empty string to delete matched text." };
  }

  const existing = await findSkill(name);
  if (!existing) {
    return { success: false, error: `Skill '${name}' not found.` };
  }

  const skillDir = existing.path;
  let target: string;

  if (filePath) {
    // Patching a supporting file
    const err = validateFilePath(filePath);
    if (err) {
      return { success: false, error: err };
    }
    target = join(skillDir, filePath);
  } else {
    // Patching SKILL.md
    target = join(skillDir, "SKILL.md");
  }

  if (!existsSync(target)) {
    return { success: false, error: `File not found: ${relative(skillDir, target)}` };
  }

  const content = await fs.readFile(target, "utf-8");

  // Try exact match first, then fuzzy match
  let newContent: string;
  let matchCount: number;

  if (replaceAll) {
    // For replaceAll, try exact regex match first
    const exactRegex = new RegExp(escapeRegex(oldString), "g");
    const exactMatches = content.match(exactRegex);
    if (exactMatches) {
      matchCount = exactMatches.length;
      newContent = content.split(oldString).join(newString);
    } else {
      // Try fuzzy match for replaceAll
      const fuzzyResult = fuzzyReplaceAll(content, oldString, newString);
      if (fuzzyResult.matchCount === 0) {
        const preview = content.slice(0, 500) + (content.length > 500 ? "..." : "");
        return {
          success: false,
          error: `Could not find the specified text to replace.`,
          file_preview: preview,
        };
      }
      matchCount = fuzzyResult.matchCount;
      newContent = fuzzyResult.content;
    }
  } else {
    // Single replacement - try exact match first
    const index = content.indexOf(oldString);
    if (index !== -1) {
      matchCount = 1;
      newContent = content.slice(0, index) + newString + content.slice(index + oldString.length);
    } else {
      // Try fuzzy match
      const fuzzyResult = fuzzyReplaceOne(content, oldString, newString);
      if (fuzzyResult.matchCount === 0) {
        const preview = content.slice(0, 500) + (content.length > 500 ? "..." : "");
        return {
          success: false,
          error: `Could not find the specified text to replace. Ensure old_string matches exactly.`,
          file_preview: preview,
        };
      }
      matchCount = fuzzyResult.matchCount;
      newContent = fuzzyResult.content;
    }
  }

  // Check size limit on the result
  const targetLabel = filePath || "SKILL.md";
  const sizeErr = validateContentSize(newContent, targetLabel);
  if (sizeErr) {
    return { success: false, error: sizeErr };
  }

  // If patching SKILL.md, validate frontmatter is still intact
  if (!filePath) {
    const fmErr = validateFrontmatter(newContent);
    if (fmErr) {
      return {
        success: false,
        error: `Patch would break SKILL.md structure: ${fmErr}`,
      };
    }
  }

  const originalContent = content; // for rollback

  try {
    await atomicWriteText(target, newContent);
  } catch (error) {
    // Rollback on error
    await atomicWriteText(target, originalContent).catch(() => {});
    return { success: false, error: `Failed to write file: ${error}` };
  }

  // Security scan — roll back on block
  const scanError = await secretScanSkill(skillDir);
  if (scanError) {
    await atomicWriteText(target, originalContent);
    return { success: false, error: scanError };
  }

  return {
    success: true,
    message: `Patched ${filePath || "SKILL.md"} in skill '${name}' (${matchCount} replacement${matchCount > 1 ? "s" : ""}).`,
  };
}

/**
 * Escape special regex characters for use in RegExp constructor
 */
function escapeRegex(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Normalize whitespace: collapse runs of whitespace/newlines to single space, trim.
 */
function normalizeWhitespace(str: string): string {
  return str.replace(/\s+/g, ' ').trim();
}

/**
 * Build a regex pattern that matches the given string with flexible whitespace.
 * Replaces each run of whitespace in the original with \s+ in the regex.
 */
function buildFuzzyPattern(str: string): RegExp {
  // Escape special regex chars, then replace escaped whitespace with flexible match
  const normalized = normalizeWhitespace(str);
  // Split by single spaces (which represent original whitespace runs)
  const parts = normalized.split(' ');
  // Build pattern: match original whitespace runs as \s+
  const pattern = parts.map(escapeRegex).join('\\s+');
  return new RegExp(pattern, 'g');
}

/**
 * Fuzzy replace for single occurrence.
 * Returns { content: newContent, matchCount: number }
 */
function fuzzyReplaceOne(content: string, oldString: string, newString: string): { content: string; matchCount: number } {
  // Try normalized match
  const normalizedOld = normalizeWhitespace(oldString);
  const normalizedContent = normalizeWhitespace(content);

  const index = normalizedContent.indexOf(normalizedOld);
  if (index === -1) {
    return { content, matchCount: 0 };
  }

  // Build fuzzy regex to find the actual position in original content
  const fuzzyPattern = buildFuzzyPattern(oldString);
  fuzzyPattern.lastIndex = 0; // Reset since we use 'g' flag

  const match = fuzzyPattern.exec(content);
  if (!match) {
    return { content, matchCount: 0 };
  }

  const newContent = content.slice(0, match.index) + newString + content.slice(match.index + match[0].length);
  return { content: newContent, matchCount: 1 };
}

/**
 * Fuzzy replace for all occurrences.
 * Returns { content: newContent, matchCount: number }
 */
function fuzzyReplaceAll(content: string, oldString: string, newString: string): { content: string; matchCount: number } {
  const fuzzyPattern = buildFuzzyPattern(oldString);
  const matches = content.match(fuzzyPattern);

  if (!matches || matches.length === 0) {
    return { content, matchCount: 0 };
  }

  // Replace all occurrences by rebuilding the string
  fuzzyPattern.lastIndex = 0;
  let result = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fuzzyPattern.exec(content)) !== null) {
    result += content.slice(lastIndex, match.index) + newString;
    lastIndex = match.index + match[0].length;
    // Prevent infinite loop on zero-length matches
    if (match[0].length === 0) {
      fuzzyPattern.lastIndex++;
    }
  }
  result += content.slice(lastIndex);

  return { content: result, matchCount: matches.length };
}

/**
 * Delete a skill.
 */
export async function deleteSkill(name: string): Promise<SkillManageResult> {
  const existing = await findSkill(name);
  if (!existing) {
    return { success: false, error: `Skill '${name}' not found.` };
  }

  const skillDir = existing.path;
  await fs.rm(skillDir, { recursive: true, force: true });

  // Clean up empty category directories (don't remove SKILLS_DIR itself)
  const parent = dirname(skillDir);
  if (parent !== SKILLS_DIR && existsSync(parent)) {
    try {
      const entries = await fs.readdir(parent);
      if (entries.length === 0) {
        await rmdir(parent);
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  return {
    success: true,
    message: `Skill '${name}' deleted.`,
  };
}

/**
 * Add or overwrite a supporting file within any skill directory.
 */
export async function writeFile(
  name: string,
  filePath: string,
  fileContent: string
): Promise<SkillManageResult> {
  const err = validateFilePath(filePath);
  if (err) {
    return { success: false, error: err };
  }

  if (fileContent === undefined || fileContent === null) {
    return { success: false, error: "file_content is required." };
  }

  // Check size limits
  const contentBytes = Buffer.byteLength(fileContent, "utf-8");
  if (contentBytes > MAX_SKILL_FILE_BYTES) {
    return {
      success: false,
      error: (
        `File content is ${contentBytes.toLocaleString()} bytes ` +
        `(limit: ${MAX_SKILL_FILE_BYTES.toLocaleString()} bytes / 1 MiB). ` +
        `Consider splitting into smaller files.`
      ),
    };
  }
  
  const sizeErr = validateContentSize(fileContent, filePath);
  if (sizeErr) {
    return { success: false, error: sizeErr };
  }

  const existing = await findSkill(name);
  if (!existing) {
    return { success: false, error: `Skill '${name}' not found. Create it first with action='create'.` };
  }

  const target = join(existing.path, filePath);
  await fs.mkdir(dirname(target), { recursive: true });
  
  // Back up for rollback
  let originalContent: string | null = null;
  if (existsSync(target)) {
    originalContent = await fs.readFile(target, "utf-8");
  }
  
  try {
    await atomicWriteText(target, fileContent);
  } catch (error) {
    // Rollback on error
    if (originalContent !== null) {
      await atomicWriteText(target, originalContent).catch(() => {});
    } else {
      await unlink(target).catch(() => {});
    }
    return { success: false, error: `Failed to write file: ${error}` };
  }

  // Security scan — roll back on block
  const scanError = await secretScanSkill(existing.path);
  if (scanError) {
    if (originalContent !== null) {
      await atomicWriteText(target, originalContent);
    } else {
      await unlink(target).catch(() => {});
    }
    return { success: false, error: scanError };
  }

  return {
    success: true,
    message: `File '${filePath}' written to skill '${name}'.`,
    path: target,
  };
}

/**
 * Remove a supporting file from any skill directory.
 */
export async function removeFile(name: string, filePath: string): Promise<SkillManageResult> {
  const err = validateFilePath(filePath);
  if (err) {
    return { success: false, error: err };
  }

  const existing = await findSkill(name);
  if (!existing) {
    return { success: false, error: `Skill '${name}' not found.` };
  }
  
  const skillDir = existing.path;
  const target = join(skillDir, filePath);
  
  if (!existsSync(target)) {
    // List what's actually there for the model to see
    const available: string[] = [];
    
    for (const subdir of ALLOWED_SUBDIRS) {
      const d = join(skillDir, subdir);
      if (existsSync(d)) {
        await collectFiles(d, skillDir, available);
      }
    }
    
    return {
      success: false,
      error: `File '${filePath}' not found in skill '${name}'.`,
      available_files: available.length > 0 ? available : null,
    };
  }

  await unlink(target);

  // Clean up empty subdirectories
  const parent = dirname(target);
  if (parent !== skillDir && existsSync(parent)) {
    try {
      const entries = await fs.readdir(parent);
      if (entries.length === 0) {
        await rmdir(parent);
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  return {
    success: true,
    message: `File '${filePath}' removed from skill '${name}'.`,
  };
}

/**
 * Recursively collect file paths relative to skillDir
 */
async function collectFiles(dir: string, skillDir: string, results: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(fullPath, skillDir, results);
    } else {
      results.push(relative(skillDir, fullPath));
    }
  }
}

// =============================================================================
// Main entry point
// =============================================================================

export interface SkillManageParams {
  action: string;
  name: string;
  content?: string;
  category?: string;
  file_path?: string;
  file_content?: string;
  old_string?: string;
  new_string?: string;
  replace_all?: boolean;
}

/**
 * Manage user-created skills. Dispatches to the appropriate action handler.
 */
export async function skillManage(params: SkillManageParams): Promise<SkillManageResult> {
  const { action, name, content, category, file_path, file_content, old_string, new_string, replace_all } = params;

  switch (action) {
    case "create": {
      if (!content) {
        return { success: false, error: "content is required for 'create'. Provide the full SKILL.md text (frontmatter + body)." };
      }
      return createSkill(name, content, category);
    }

    case "edit": {
      if (!content) {
        return { success: false, error: "content is required for 'edit'. Provide the full updated SKILL.md text." };
      }
      return editSkill(name, content);
    }

    case "patch": {
      if (!old_string) {
        return { success: false, error: "old_string is required for 'patch'. Provide the text to find." };
      }
      if (new_string === undefined || new_string === null) {
        return { success: false, error: "new_string is required for 'patch'. Use empty string to delete matched text." };
      }
      return patchSkill(name, old_string, new_string, file_path, replace_all ?? false);
    }

    case "delete": {
      return deleteSkill(name);
    }

    case "write_file": {
      if (!file_path) {
        return { success: false, error: "file_path is required for 'write_file'. Example: 'references/api-guide.md'" };
      }
      if (file_content === undefined || file_content === null) {
        return { success: false, error: "file_content is required for 'write_file'." };
      }
      return writeFile(name, file_path, file_content);
    }

    case "remove_file": {
      if (!file_path) {
        return { success: false, error: "file_path is required for 'remove_file'." };
      }
      return removeFile(name, file_path);
    }

    default: {
      return { success: false, error: `Unknown action '${action}'. Use: create, edit, patch, delete, write_file, remove_file` };
    }
  }
}
