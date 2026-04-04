/**
 * OpenClaw Self-Evolution Pipeline - Dataset Builder Orchestrator
 *
 * Orchestrates all dataset sources (golden sets, session mining, synthetic generation)
 * into a unified dataset for a target skill.
 *
 * References:
 * - DatasetEntry, DatasetManifest, EvolutionConfig from src/types.ts
 * - DatasetManager from src/dataset/manager.ts
 * - DatasetSessionMiner from src/dataset/session-miner.ts
 * - SyntheticGenerator from src/dataset/synthetic-generator.ts
 * - GoldenSetLoader from src/dataset/golden-sets.ts
 */

import type {
  EvolutionConfig,
  DatasetEntry,
  DatasetManifest,
} from "../types.js";
import type { DatasetManager } from "./manager.js";
import type { DatasetSessionMiner } from "./session-miner.js";
import type { SyntheticGenerator } from "./synthetic-generator.js";
import type { GoldenSetLoader } from "./golden-sets.js";
import { ExternalSessionImporter, type ImportSource } from "./external-importers/orchestrator.js";
import { SessionMiner } from "../collection/session-miner.js";

/**
 * Options for building a dataset for a skill.
 *
 * Source: Task specification T3.5
 */
export interface BuildOptions {
  /** Maximum number of synthetic examples to generate (default: 20) */
  maxSynthetic?: number;
  /** Maximum number of mined examples to extract (default: 50) */
  maxMined?: number;
  /** Whether to include golden sets (default: true) */
  includeGoldenSets?: boolean;
  /** Minimum quality score for entries (default: 0.5) */
  minQualityScore?: number;
  /** Whether to auto-finalize the dataset after building (default: true) */
  autoFinalize?: boolean;
  /** Whether to include external sessions (default: false) */
  includeExternalSessions?: boolean;
  /** External sources to import from (default: all) */
  externalSources?: ImportSource[];
  /** Maximum number of external examples to import (default: 50) */
  maxExternalExamples?: number;
}

/**
 * Status of a dataset build operation.
 *
 * Source: Task specification T3.5
 */
export interface BuildStatus {
  /** The dataset ID */
  datasetId: string;
  /** Current status of the build */
  status: string;
  /** Total number of entries in the dataset */
  entryCount: number;
  /** Breakdown of entries by source */
  sources: {
    synthetic: number;
    mined: number;
    golden: number;
    external: number;
  };
}

/**
 * DatasetBuilder orchestrates all dataset sources into a unified dataset.
 *
 * Combines golden sets, session-mined examples, and synthetic generation
 * to create comprehensive training datasets for skill evolution.
 *
 * Source: Task specification T3.5
 */
export class DatasetBuilder {
  private config: EvolutionConfig;
  private manager: DatasetManager;
  private sessionMiner: DatasetSessionMiner;
  private syntheticGenerator: SyntheticGenerator;
  private goldenSetLoader: GoldenSetLoader;

  // Track build status for each dataset
  private buildStatuses: Map<string, BuildStatus> = new Map();

  constructor(
    config: EvolutionConfig,
    manager: DatasetManager,
    sessionMiner: DatasetSessionMiner,
    syntheticGenerator: SyntheticGenerator,
    goldenSetLoader: GoldenSetLoader
  ) {
    this.config = config;
    this.manager = manager;
    this.sessionMiner = sessionMiner;
    this.syntheticGenerator = syntheticGenerator;
    this.goldenSetLoader = goldenSetLoader;
  }

  /**
   * Build a complete dataset for a target skill by orchestrating all sources.
   *
   * Logic per task specification T3.5:
   * 1. Create a new dataset via manager.createDataset()
   * 2. If includeGoldenSets: load from goldenSetLoader.loadForSkill(), filter by minQualityScore, add to dataset
   * 3. Mine from sessions via sessionMiner.mineForSkill(), filter by score, add to dataset
   * 4. Generate synthetic examples via syntheticGenerator.generateForSkill(), add to dataset
   * 5. If autoFinalize: call manager.finalizeDataset()
   * 6. Return the manifest
   *
   * Each source is handled independently — if golden sets fail, continue without them;
   * if mining returns empty, that's fine.
   *
   * @param skillName - Name of the skill to build dataset for
   * @param skillDescription - Description of what the skill does
   * @param options - Build options (optional)
   * @returns The completed dataset manifest
   */
  async buildForSkill(
    skillName: string,
    skillDescription: string,
    options?: BuildOptions
  ): Promise<DatasetManifest> {
    // Apply defaults per task spec
    const maxSynthetic = options?.maxSynthetic ?? 20;
    const maxMined = options?.maxMined ?? 50;
    const includeGoldenSets = options?.includeGoldenSets ?? true;
    const minQualityScore = options?.minQualityScore ?? 0.5;
    const autoFinalize = options?.autoFinalize ?? true;

    // Step 1: Create a new dataset
    // Source: DatasetManager.createDataset() signature from manager.ts
    const datasetName = `${skillName}-dataset-${Date.now()}`;
    const manifest = await this.manager.createDataset(datasetName, {
      name: datasetName,
      description: `Training dataset for skill: ${skillName}`,
      skillTarget: skillName,
      entryCount: 0,
      createdAt: new Date(),
      status: "draft",
    });

    // Initialize build status tracking
    const buildStatus: BuildStatus = {
      datasetId: manifest.id,
      status: "building",
      entryCount: 0,
      sources: { synthetic: 0, mined: 0, golden: 0, external: 0 },
    };
    this.buildStatuses.set(manifest.id, buildStatus);

    // Collect entries from all sources
    const allEntries: DatasetEntry[] = [];

    // Step 2: Load golden sets if enabled
    // Source: GoldenSetLoader.loadForSkill() signature from golden-sets.ts
    // Note: Golden sets are hand-curated and inherently trusted, so unscored entries pass quality filter
    if (includeGoldenSets) {
      try {
        const goldenEntries = await this.goldenSetLoader.loadForSkill(skillName);
        const filteredGolden = goldenEntries.filter(
          // Golden sets are hand-curated and inherently trusted
          // Treat unscored entries as passing quality filter (default score 1.0)
          (entry) => (entry.score ?? 1.0) >= minQualityScore
        );
        allEntries.push(...filteredGolden);
        buildStatus.sources.golden = filteredGolden.length;
      } catch (error) {
        // Golden sets are optional — log and continue
        console.warn(
          `[dataset-builder] Golden sets unavailable for ${skillName}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    // Step 3: Mine from sessions
    // Source: DatasetSessionMiner.mineForSkill() signature from session-miner.ts
    // Note: Mined entries use minQualityScore filter (default 0 for unscored)
    try {
      const minedEntries = await this.sessionMiner.mineForSkill(skillName, {
        maxEntries: maxMined,
      });
      const filteredMined = minedEntries.filter(
        // Mined entries: use minQualityScore filter (default 0 for unscored)
        (entry) => (entry.score ?? 0) >= minQualityScore
      );
      allEntries.push(...filteredMined);
      buildStatus.sources.mined = filteredMined.length;
    } catch (error) {
      // Mining failure is acceptable — log and continue
      console.warn(
        `[dataset-builder] Session mining failed for ${skillName}:`,
        error instanceof Error ? error.message : String(error)
      );
    }

    // Step 4: Generate synthetic examples
    // Source: SyntheticGenerator.generateForSkill() signature from synthetic-generator.ts
    try {
      const syntheticEntries = await this.syntheticGenerator.generateForSkill(
        skillName,
        skillDescription,
        maxSynthetic
      );
      // Synthetic entries don't have scores yet — include all
      allEntries.push(...syntheticEntries);
      buildStatus.sources.synthetic = syntheticEntries.length;
    } catch (error) {
      // Synthetic generation failure is acceptable — log and continue
      console.warn(
        `[dataset-builder] Synthetic generation failed for ${skillName}:`,
        error instanceof Error ? error.message : String(error)
      );
    }

    // Step 5: Import external sessions if enabled
    if (options?.includeExternalSessions) {
      try {
        const sessionMiner = new SessionMiner(this.config);
        const importer = new ExternalSessionImporter(this.config, sessionMiner);
        const externalSources = options.externalSources ?? ["claude-code", "copilot", "openclaw"];
        const maxExternalExamples = options.maxExternalExamples ?? 50;

        // Read skill content for relevance filtering
        const skillContent = skillDescription; // Use description as skill content for now

        const externalEntries = await importer.importForSkill(
          skillName,
          skillContent,
          externalSources,
          maxExternalExamples
        );

        // Update datasetId for external entries
        const externalEntriesWithDatasetId = externalEntries.map((entry) => ({
          ...entry,
          datasetId: manifest.id,
        }));

        allEntries.push(...externalEntriesWithDatasetId);
        buildStatus.sources.external = externalEntriesWithDatasetId.length;
      } catch (error) {
        // External import failure is acceptable — log and continue
        console.warn(
          `[dataset-builder] External session import failed for ${skillName}:`,
          error instanceof Error ? error.message : String(error)
        );
      }
    }

    // Add all collected entries to the dataset
    let persistedCount = 0;
    if (allEntries.length > 0) {
      // Update datasetId for all entries to match the new dataset
      const entriesWithDatasetId = allEntries.map((entry) => ({
        ...entry,
        datasetId: manifest.id,
      }));
      try {
        // addEntries returns the actual count persisted (may be less than attempted)
        persistedCount = await this.manager.addEntries(manifest.id, entriesWithDatasetId);
      } catch (err) {
        console.error(`[dataset-builder] Failed to persist ${allEntries.length} entries for dataset ${manifest.id}:`, err);
        throw new Error(`Dataset build failed: could not persist entries. ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Update build status with actual persisted count (not attempted count)
    buildStatus.entryCount = persistedCount;

    // Log difficulty distribution summary if entries have metadata
    this.logDifficultyDistribution(allEntries);

    // Step 5: Finalize if autoFinalize is enabled
    // Source: DatasetManager.finalizeDataset() signature from manager.ts
    if (autoFinalize) {
      try {
        await this.manager.finalizeDataset(manifest.id);
        buildStatus.status = "ready";
      } catch (err) {
        console.error(`[dataset-builder] Failed to finalize dataset ${manifest.id}:`, err);
        // Non-fatal — dataset entries are already persisted, just status wasn't updated
      }
    } else {
      buildStatus.status = "draft";
    }

    // Update the stored status
    this.buildStatuses.set(manifest.id, buildStatus);

    // Step 6: Return the manifest
    // Re-fetch to get updated entry count
    return (
      (await this.manager.getDataset(manifest.id)) ??
      // Fallback to original manifest if re-fetch fails
      manifest
    );
  }

  /**
   * Get the current build status for a dataset.
   *
   * @param datasetId - The dataset ID to check
   * @returns The build status
   * @throws Error if dataset not found
   */
  async getStatus(datasetId: string): Promise<BuildStatus> {
    // First check our internal tracking
    const trackedStatus = this.buildStatuses.get(datasetId);
    if (trackedStatus) {
      return trackedStatus;
    }

    // Otherwise, fetch from manager and construct status
    // Source: DatasetManager.getDataset() signature from manager.ts
    const manifest = await this.manager.getDataset(datasetId);
    if (!manifest) {
      throw new Error(`Dataset not found: ${datasetId}`);
    }

    // Construct status from manifest
    const status: BuildStatus = {
      datasetId,
      status: manifest.status,
      entryCount: manifest.entryCount,
      sources: { synthetic: 0, mined: 0, golden: 0, external: 0 },
    };

    // Store for future lookups
    this.buildStatuses.set(datasetId, status);

    return status;
  }

  /**
   * Log a summary of difficulty distribution for dataset entries.
   *
   * @param entries - Array of dataset entries to analyze
   */
  private logDifficultyDistribution(entries: DatasetEntry[]): void {
    if (entries.length === 0) {
      return;
    }

    const counts = {
      easy: 0,
      medium: 0,
      hard: 0,
      unknown: 0,
    };

    for (const entry of entries) {
      const difficulty = entry.metadata?.difficulty;
      if (difficulty === 'easy') {
        counts.easy++;
      } else if (difficulty === 'medium') {
        counts.medium++;
      } else if (difficulty === 'hard') {
        counts.hard++;
      } else {
        counts.unknown++;
      }
    }

    const total = entries.length;
    console.log(`[dataset-builder] Difficulty distribution:`);
    console.log(`  easy: ${counts.easy} (${((counts.easy / total) * 100).toFixed(1)}%)`);
    console.log(`  medium: ${counts.medium} (${((counts.medium / total) * 100).toFixed(1)}%)`);
    console.log(`  hard: ${counts.hard} (${((counts.hard / total) * 100).toFixed(1)}%)`);
    if (counts.unknown > 0) {
      console.log(`  unknown: ${counts.unknown} (${((counts.unknown / total) * 100).toFixed(1)}%)`);
    }
  }

  /**
   * List all built datasets, optionally filtered by skill name.
   *
   * @param skillName - Optional skill name to filter by
   * @returns Array of dataset manifests
   */
  async listBuilds(skillName?: string): Promise<DatasetManifest[]> {
    // Source: DatasetManager.listDatasets() signature from manager.ts
    const allDatasets = await this.manager.listDatasets();

    if (!skillName) {
      return allDatasets;
    }

    // Filter by skill name in metadata
    return allDatasets.filter(
      (dataset) => dataset.metadata.skillTarget === skillName
    );
  }
}
