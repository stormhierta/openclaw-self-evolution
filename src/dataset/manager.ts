/**
 * OpenClaw Self-Evolution Pipeline - Dataset Manager
 * 
 * Handles versioning and storage of training datasets for the evolution pipeline.
 * 
 * Design decisions based on:
 * - SQLite patterns from trajectory-logger.ts (same better-sqlite3 usage)
 * - DatasetManifestRow, DatasetEntryRow types from src/types.ts
 * - Storage config from src/config.ts (datasetPath)
 * 
 * Tables: datasets, dataset_entries
 * Columns match the row types in src/types.ts exactly.
 */

import Database from "better-sqlite3";
import type {
  EvolutionConfig,
  DatasetMetadata,
  DatasetManifest,
  DatasetEntry,
  DatasetManifestRow,
  DatasetEntryRow,
  DatasetStatus,
} from "../types.js";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";

/**
 * DatasetManager handles versioning and storage of training datasets.
 * 
 * Design: Manages its own SQLite database at config.storage.datasetPath
 * Source: SQLite patterns from trajectory-logger.ts
 * 
 * Each dataset is versioned and tracks its entries in a separate table.
 */
export class DatasetManager {
  private config: EvolutionConfig;
  private db: Database.Database | null = null;
  private isInitialized = false;

  // Prepared statements for performance
  private insertDatasetStmt: Database.Statement | null = null;
  private insertEntryStmt: Database.Statement | null = null;
  private getDatasetStmt: Database.Statement | null = null;
  private listDatasetsStmt: Database.Statement | null = null;
  private updateDatasetStmt: Database.Statement | null = null;
  private getEntriesStmt: Database.Statement | null = null;
  private countEntriesStmt: Database.Statement | null = null;

  constructor(config: EvolutionConfig) {
    this.config = config;
  }

  /**
   * Get the dataset storage path from config or use default.
   * Source: Same pattern as trajectory-logger.ts getDbPath()
   */
  private getDatasetPath(): string {
    return (
      this.config.storage.datasetPath ??
      `${process.env.HOME ?? "."}/.openclaw/evolution/datasets/`
    );
  }

  /**
   * Get the database file path (datasets index DB).
   */
  private getDbPath(): string {
    return join(this.getDatasetPath(), "datasets.db");
  }

  /**
   * Initialize the database connection and create tables if they don't exist.
   * 
   * Schema matches DatasetManifestRow and DatasetEntryRow from src/types.ts.
   * Source: Table creation pattern from trajectory-logger.ts initialize()
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    const dbPath = this.getDbPath();

    try {
      // Ensure directory exists
      const dir = dirname(dbPath);
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        // Directory may already exist
      }

      // Open database with better-sqlite3 (synchronous API)
      this.db = new Database(dbPath);

      // Enable WAL mode for better concurrency
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("synchronous = NORMAL");

      // Create datasets table (matches DatasetManifestRow type)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS datasets (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          version INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL CHECK(status IN ('draft', 'ready', 'archived', 'deleted')),
          metadata_json TEXT NOT NULL,
          entry_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `);

      // Create indexes for common queries
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_datasets_name ON datasets(name);
        CREATE INDEX IF NOT EXISTS idx_datasets_status ON datasets(status);
        CREATE INDEX IF NOT EXISTS idx_datasets_created_at ON datasets(created_at);
      `);

      // Create dataset_entries table (matches DatasetEntryRow type)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS dataset_entries (
          id TEXT PRIMARY KEY,
          dataset_id TEXT NOT NULL,
          input TEXT NOT NULL,
          expected_output TEXT NOT NULL,
          context_json TEXT,
          score REAL,
          metadata_json TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (dataset_id) REFERENCES datasets(id) ON DELETE CASCADE
        )
      `);

      // Create indexes for entries
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_entries_dataset_id ON dataset_entries(dataset_id);
        CREATE INDEX IF NOT EXISTS idx_entries_created_at ON dataset_entries(created_at);
      `);

      // Prepare statements for better performance
      this.insertDatasetStmt = this.db.prepare(`
        INSERT INTO datasets (
          id, name, version, status, metadata_json, entry_count, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      this.insertEntryStmt = this.db.prepare(`
        INSERT INTO dataset_entries (
          id, dataset_id, input, expected_output, context_json, score, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      this.getDatasetStmt = this.db.prepare(`
        SELECT 
          id,
          name,
          version,
          status,
          metadata_json,
          entry_count,
          created_at,
          updated_at
        FROM datasets
        WHERE id = ?
      `);

      this.listDatasetsStmt = this.db.prepare(`
        SELECT 
          id,
          name,
          version,
          status,
          metadata_json,
          entry_count,
          created_at,
          updated_at
        FROM datasets
        WHERE status != 'deleted'
        ORDER BY created_at DESC
      `);

      this.updateDatasetStmt = this.db.prepare(`
        UPDATE datasets
        SET status = ?, entry_count = ?, updated_at = ?, metadata_json = ?
        WHERE id = ?
      `);

      this.getEntriesStmt = this.db.prepare(`
        SELECT 
          id,
          dataset_id,
          input,
          expected_output,
          context_json,
          score,
          metadata_json,
          created_at
        FROM dataset_entries
        WHERE dataset_id = ?
        ORDER BY created_at ASC
      `);

      this.countEntriesStmt = this.db.prepare(`
        SELECT COUNT(*) as count FROM dataset_entries WHERE dataset_id = ?
      `);

      this.isInitialized = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to initialize dataset database at ${dbPath}: ${message}`,
        { cause: error }
      );
    }
  }

  /**
   * Generate a unique dataset ID.
   * Source: Same pattern as trajectory IDs (UUID v4 style)
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Convert a database row to a DatasetManifest.
   * Source: Same pattern as trajectory-logger.ts query() row mapping
   * 
   * Note: entryCount is read from the authoritative entry_count column,
   * not metadata_json.entryCount, to avoid drift.
   */
  private rowToManifest(row: DatasetManifestRow): DatasetManifest {
    const metadata = JSON.parse(row.metadata_json) as DatasetMetadata;
    return {
      id: row.id,
      name: row.name,
      version: row.version,
      metadata,
      entryCount: row.entry_count, // Authoritative source
      status: row.status,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  /**
   * Convert a database row to a DatasetEntry.
   */
  private rowToEntry(row: DatasetEntryRow): DatasetEntry {
    return {
      id: row.id,
      datasetId: row.dataset_id,
      input: row.input,
      expectedOutput: row.expected_output,
      context: row.context_json ? JSON.parse(row.context_json) : undefined,
      score: row.score,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
      createdAt: new Date(row.created_at),
    };
  }

  /**
   * Create a new versioned dataset entry.
   * 
   * @param name - Human-readable name for the dataset
   * @param metadata - Dataset metadata
   * @returns The created dataset manifest
   */
  async createDataset(
    name: string,
    metadata: DatasetMetadata
  ): Promise<DatasetManifest> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.db || !this.insertDatasetStmt) {
      throw new Error("Database not initialized");
    }

    const id = this.generateId();
    const now = new Date();
    const version = 1;
    const status: DatasetStatus = "draft";

    // Update metadata with derived values
    const fullMetadata: DatasetMetadata = {
      ...metadata,
      name,
      entryCount: 0,
      createdAt: now,
      status,
    };

    try {
      this.insertDatasetStmt.run(
        id,
        name,
        version,
        status,
        JSON.stringify(fullMetadata),
        0,
        now.toISOString(),
        now.toISOString()
      );

      return {
        id,
        name,
        version,
        metadata: fullMetadata,
        entryCount: 0,
        status,
        createdAt: now,
        updatedAt: now,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create dataset: ${message}`, { cause: error });
    }
  }

  /**
   * Add training examples to a dataset.
   * 
   * @param datasetId - The dataset ID to add entries to
   * @param entries - Array of dataset entries to add
   * @returns Number of entries added
   */
  async addEntries(
    datasetId: string,
    entries: DatasetEntry[]
  ): Promise<number> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.db || !this.insertEntryStmt || !this.countEntriesStmt) {
      throw new Error("Database not initialized");
    }

    // Verify dataset exists and is not deleted
    const dataset = await this.getDataset(datasetId);
    if (!dataset) {
      throw new Error(`Dataset not found: ${datasetId}`);
    }
    if (dataset.status === "deleted") {
      throw new Error(`Cannot add entries to deleted dataset: ${datasetId}`);
    }

    let addedCount = 0;
    const now = new Date();

    // Use a transaction for atomicity
    const transaction = this.db.transaction(() => {
      for (const entry of entries) {
        try {
          this.insertEntryStmt!.run(
            entry.id || this.generateId(),
            datasetId,
            entry.input,
            entry.expectedOutput,
            entry.context ? JSON.stringify(entry.context) : null,
            entry.score ?? null,
            entry.metadata ? JSON.stringify(entry.metadata) : null,
            now.toISOString()
          );
          addedCount++;
        } catch (err) {
          console.error(
            `[dataset-manager] Error inserting entry for dataset ${datasetId}:`
          );
          // Continue with other entries
        }
      }
    });

    try {
      transaction();

      // Update entry count in dataset
      const countResult = this.countEntriesStmt.get(datasetId) as {
        count: number;
      };
      const newCount = countResult.count;

      // Get current dataset to update metadata_json in sync
      const currentDataset = await this.getDataset(datasetId);
      if (currentDataset) {
        const updatedMetadata: DatasetMetadata = {
          ...currentDataset.metadata,
          entryCount: newCount,
          status: currentDataset.status,
        };
        this.db
          .prepare(
            `UPDATE datasets SET entry_count = ?, updated_at = ?, metadata_json = ? WHERE id = ?`
          )
          .run(newCount, now.toISOString(), JSON.stringify(updatedMetadata), datasetId);
      } else {
        // Fallback if dataset not found (shouldn't happen)
        this.db
          .prepare(
            `UPDATE datasets SET entry_count = ?, updated_at = ? WHERE id = ?`
          )
          .run(newCount, now.toISOString(), datasetId);
      }

      return addedCount;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to add entries: ${message}`, { cause: error });
    }
  }

  /**
   * Retrieve dataset metadata by ID.
   * 
   * @param datasetId - The dataset ID to retrieve
   * @returns The dataset manifest or null if not found
   */
  async getDataset(datasetId: string): Promise<DatasetManifest | null> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.db || !this.getDatasetStmt) {
      throw new Error("Database not initialized");
    }

    const row = this.getDatasetStmt.get(datasetId) as
      | DatasetManifestRow
      | undefined;

    if (!row) {
      return null;
    }

    return this.rowToManifest(row);
  }

  /**
   * List all datasets with optional filtering.
   * 
   * @param filter - Optional filter criteria
   * @returns Array of dataset manifests
   */
  async listDatasets(filter?: {
    status?: string;
  }): Promise<DatasetManifest[]> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.db) {
      throw new Error("Database not initialized");
    }

    let query: string;
    let params: string[] = [];

    if (filter?.status) {
      query = `
        SELECT 
          id,
          name,
          version,
          status,
          metadata_json,
          entry_count,
          created_at,
          updated_at
        FROM datasets
        WHERE status = ?
        ORDER BY created_at DESC
      `;
      params = [filter.status];
    } else {
      // Default: exclude deleted
      query = `
        SELECT 
          id,
          name,
          version,
          status,
          metadata_json,
          entry_count,
          created_at,
          updated_at
        FROM datasets
        WHERE status != 'deleted'
        ORDER BY created_at DESC
      `;
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as DatasetManifestRow[];

    return rows.map((row) => this.rowToManifest(row));
  }

  /**
   * Mark a dataset as ready for use.
   * 
   * @param datasetId - The dataset ID to finalize
   */
  async finalizeDataset(datasetId: string): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const dataset = await this.getDataset(datasetId);
    if (!dataset) {
      throw new Error(`Dataset not found: ${datasetId}`);
    }

    if (dataset.status === "deleted") {
      throw new Error(`Cannot finalize deleted dataset: ${datasetId}`);
    }

    const now = new Date();
    const newStatus: DatasetStatus = "ready";

    // Update metadata
    const updatedMetadata: DatasetMetadata = {
      ...dataset.metadata,
      status: newStatus,
    };

    this.db
      .prepare(
        `UPDATE datasets SET status = ?, updated_at = ?, metadata_json = ? WHERE id = ?`
      )
      .run(
        newStatus,
        now.toISOString(),
        JSON.stringify(updatedMetadata),
        datasetId
      );
  }

  /**
   * Soft delete a dataset (marks as deleted, does not remove data).
   * 
   * @param datasetId - The dataset ID to delete
   */
  async deleteDataset(datasetId: string): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.db) {
      throw new Error("Database not initialized");
    }

    const dataset = await this.getDataset(datasetId);
    if (!dataset) {
      throw new Error(`Dataset not found: ${datasetId}`);
    }

    const now = new Date();
    const newStatus: DatasetStatus = "deleted";

    // Update metadata
    const updatedMetadata: DatasetMetadata = {
      ...dataset.metadata,
      status: newStatus,
    };

    this.db
      .prepare(
        `UPDATE datasets SET status = ?, updated_at = ?, metadata_json = ? WHERE id = ?`
      )
      .run(
        newStatus,
        now.toISOString(),
        JSON.stringify(updatedMetadata),
        datasetId
      );
  }

  /**
   * Export dataset entries to a JSONL file.
   * 
   * @param datasetId - The dataset ID to export
   * @param outputPath - Path to write the JSONL file
   * @returns Number of entries exported
   */
  async exportDataset(
    datasetId: string,
    outputPath: string
  ): Promise<number> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.db || !this.getEntriesStmt) {
      throw new Error("Database not initialized");
    }

    const dataset = await this.getDataset(datasetId);
    if (!dataset) {
      throw new Error(`Dataset not found: ${datasetId}`);
    }

    if (dataset.status === "deleted") {
      throw new Error(`Cannot export deleted dataset: ${datasetId}`);
    }

    const rows = this.getEntriesStmt.all(datasetId) as DatasetEntryRow[];

    // Convert to JSONL format
    const lines: string[] = [];
    for (const row of rows) {
      const entry = this.rowToEntry(row);
      const record = {
        input: entry.input,
        expected_output: entry.expectedOutput,
        context: entry.context,
        score: entry.score,
        metadata: entry.metadata,
      };
      lines.push(JSON.stringify(record));
    }

    // Ensure output directory exists
    const outputDir = dirname(outputPath);
    try {
      mkdirSync(outputDir, { recursive: true });
    } catch {
      // Directory may already exist
    }

    // Write to file
    writeFileSync(outputPath, lines.join("\n") + (lines.length > 0 ? "\n" : ""));

    return lines.length;
  }

  /**
   * Get all entries for a dataset.
   * 
   * @param datasetId - The dataset ID
   * @returns Array of dataset entries
   */
  async getEntries(datasetId: string): Promise<DatasetEntry[]> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!this.db || !this.getEntriesStmt) {
      throw new Error("Database not initialized");
    }

    const rows = this.getEntriesStmt.all(datasetId) as DatasetEntryRow[];
    return rows.map((row) => this.rowToEntry(row));
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }

    this.isInitialized = false;
    this.insertDatasetStmt = null;
    this.insertEntryStmt = null;
    this.getDatasetStmt = null;
    this.listDatasetsStmt = null;
    this.updateDatasetStmt = null;
    this.getEntriesStmt = null;
    this.countEntriesStmt = null;
  }
}
