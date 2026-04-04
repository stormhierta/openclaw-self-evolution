/**
 * Git Manager for Human-in-the-Loop Deployment
 *
 * Wraps git CLI operations for the evolution pipeline: when a best variant is found,
 * instead of applying directly to disk, we create a branch, commit the variant, and
 * let the user review/merge it.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { writeFile, mkdir } from "fs/promises";
import { homedir } from "os";

import type { GitManagerConfig, BranchResult } from "../types.js";

const execFileAsync = promisify(execFile);

/** Default path for the skills repository */
const DEFAULT_REPO_PATH = `${homedir()}/.openclaw/skills`;

/** Default remote name */
const DEFAULT_REMOTE = "origin";

/**
 * Wraps git CLI operations for evolution variant deployment.
 * All operations are scoped to the configured repoPath to avoid side-effects.
 */
export class GitManager {
  private readonly repoPath: string;
  private readonly remote: string;
  private readonly baseBranch: string;

  constructor(gitConfig?: GitManagerConfig) {
    this.repoPath = gitConfig?.repoPath ?? DEFAULT_REPO_PATH;
    this.remote = gitConfig?.remote ?? DEFAULT_REMOTE;
    this.baseBranch = gitConfig?.baseBranch ?? "main";
  }

  /**
   * Run a git command with args, scoped to repoPath.
   * Throws a descriptive Error if the command fails.
   */
  private async runGit(args: string[]): Promise<string> {
    try {
      // stderr from successful git commands may contain warnings — currently discarded
      const { stdout } = await execFileAsync("git", args, {
        cwd: this.repoPath,
        timeout: 30_000,
      });
      return stdout.trim();
    } catch (err: unknown) {
      const stderrOut = (err as NodeJS.ErrnoException & { stderr?: string }).stderr ?? "";
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`git ${args.join(" ")} failed: ${message}${stderrOut ? `\nstderr: ${stderrOut}` : ""}`);
    }
  }

  /**
   * Check if the skills repo is a git repository.
   */
  async isGitRepo(): Promise<boolean> {
    try {
      await this.runGit(["rev-parse", "--git-dir"]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the current branch name of the repo.
   * Throws if not on a branch (e.g. detached HEAD).
   */
  async getCurrentBranch(): Promise<string> {
    const output = await this.runGit(["rev-parse", "--abbrev-ref", "HEAD"]);
    if (output === "HEAD") {
      throw new Error("Not currently on a branch (detached HEAD state)");
    }
    return output;
  }

  /**
   * Create a new branch for an evolution variant.
   * Branch naming: evolution/<skillName>/<runId>
   */
  async createEvolutionBranch(skillName: string, runId: string): Promise<string> {
    const branchName = `evolution/${skillName}/${runId}`;
    // Check working tree is clean (no uncommitted changes)
    const status = await this.runGit(["status", "--porcelain"]);
    if (status.trim().length > 0) {
      throw new Error(`Cannot create evolution branch: working tree has uncommitted changes. Please commit or stash first.`);
    }
    // Checkout base branch from remote if it exists, otherwise use local
    await this.runGit(["checkout", this.baseBranch]);
    await this.runGit(["checkout", "-b", branchName]);
    return branchName;
  }

  /**
   * Write variant content to the skill's SKILL.md and commit it.
   * The file is written to <repoPath>/<skillName>/SKILL.md
   *
   * @returns The commit SHA
   */
  async commitVariant(
    branchName: string,
    skillName: string,
    content: string,
    message: string
  ): Promise<string> {
    // Ensure we're on the correct branch before writing
    await this.runGit(["checkout", branchName]);

    const skillDir = `${this.repoPath}/${skillName}`;
    const skillFilePath = `${skillDir}/SKILL.md`;

    // Ensure the skill directory exists
    await mkdir(skillDir, { recursive: true });

    // Write the variant content
    await writeFile(skillFilePath, content, "utf-8");

    // Stage and commit using relative path
    await this.runGit(["add", `${skillName}/SKILL.md`]);
    await this.runGit(["commit", "-m", message]);

    // Return the commit SHA
    const sha = await this.runGit(["rev-parse", "HEAD"]);
    return sha;
  }

  /**
   * Push the branch to the remote.
   * Returns false if push fails (no remote, no auth) — does not throw.
   */
  async pushBranch(branchName: string): Promise<boolean> {
    try {
      await this.runGit(["push", this.remote, branchName]);
      return true;
    } catch {
      // Push failed (no remote, no auth, etc.) — fail gracefully
      return false;
    }
  }

  /**
   * Full flow: create a branch, write the variant content to SKILL.md,
   * commit it, and optionally push to remote.
   *
   * @returns BranchResult with branchName, commitSha, and pushed flag
   */
  async applyVariantToBranch(
    skillName: string,
    runId: string,
    variantContent: string,
    commitMessage?: string
  ): Promise<BranchResult> {
    // Extract run identifier from runId for commit message
    const msg =
      commitMessage ??
      `chore(evolution): apply evolved variant for ${skillName} [run:${runId}]`;

    // Create and switch to new branch
    const branchName = await this.createEvolutionBranch(skillName, runId);

    // Write and commit the variant
    const commitSha = await this.commitVariant(branchName, skillName, variantContent, msg);

    // Attempt to push (fail gracefully)
    const pushed = await this.pushBranch(branchName);

    return { branchName, commitSha, pushed };
  }

  /**
   * List evolution branches matching "evolution/<skillName>/...".
   * If skillName is omitted, returns all evolution branches.
   */
  async listEvolutionBranches(skillName?: string): Promise<string[]> {
    const prefix = skillName ? `evolution/${skillName}/` : "evolution/";

    // Get all local branch names
    const output = await this.runGit(["branch", "--format", "%(refname:short)"]);
    const branches = output
      .split("\n")
      .map((b) => b.trim())
      .filter((b) => b.startsWith(prefix));

    return branches;
  }

  /**
   * Delete a branch.
   * @param branchName The branch to delete
   * @param remote If true, delete the remote branch as well
   */
  async deleteBranch(branchName: string, remote?: boolean): Promise<void> {
    if (remote) {
      await this.runGit(["push", this.remote, "--delete", branchName]);
    }
    // Check if we're currently on the branch being deleted
    const currentBranch = await this.getCurrentBranch().catch(() => null);
    if (currentBranch === branchName) {
      // Switch to base branch before deleting
      await this.runGit(["checkout", this.baseBranch]);
    }
    // Always delete local branch
    await this.runGit(["branch", "-D", branchName]);
  }
}
