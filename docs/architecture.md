# Architecture

## Component Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Trajectory Collection                             │
│  trajectory-hooks.ts ──► trajectory.db (SQLite)                            │
│  session-miner.ts ──► session data                                          │
│  skill-usage-analyzer.ts ──► skill usage metrics                            │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                             Dataset Building                                 │
│  session-miner.ts ──► mined episodes                                         │
│  synthetic-generator.ts ──► synthetic examples                               │
│  golden-sets.ts ──► curated benchmarks                                       │
│                                                                              │
│  Output: dataset files (JSONL / SQLite) stored at config.storage.datasetPath │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Evolution Engine (GEPA)                             │
│  optimizer.ts ──► manages runs, selection, elitism                           │
│  evolver.ts ──► genetic operators: crossover, mutation                       │
│                                                                              │
│  Mutations: prompt_rewrite | example_add | example_remove |                  │
│             parameter_tweak | structure_change                               │
│                                                                              │
│  Output: evolution/runs.db (SQLite) — EvolutionRun, SkillVariant records     │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                             Validation Gate                                 │
│  size-limits.ts ──► enforce maxSkillSizeBytes, maxDescriptionLength, etc.    │
│  skill-validator.ts ──► schema validation of skill content                   │
│  benchmark-gate.ts ──► run variant on dataset, gate on pass threshold        │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Fitness Evaluation (LLM-Judge)                        │
│  llm-judge.ts ──► LLM-as-judge scoring via rubric                            │
│  rubrics.ts ──► scoring criteria: correctness, format, efficiency,           │
│                 robustness, clarity (0-100 weighted sum)                      │
│                                                                              │
│  Output: FitnessScore attached to SkillVariant                               │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Deployment / Git Layer                               │
│  git-manager.ts ──► apply variant to evolution/ branch                      │
│  pr-builder.ts ──► create PR record                                          │
│  review-queue.ts ──► pending PRs queue                                       │
│  metrics-reporter.ts ──► human-readable evolution metrics                    │
│                                                                              │
│  Output: evolution/prs.db (SQLite) — PrRecord, ReviewQueueItem               │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │
                                ▼
                    Human Review (CLI) ──► Approve / Reject
                                │
                                ▼
                          Git Merge / Apply
```

## Data Flow

| Stage | Input | Output | Storage |
|-------|-------|--------|---------|
| Trajectory Collection | Live agent sessions | TurnRecord, EpisodeRecord | `trajectory.db` |
| Dataset Building | Trajectory episodes | DatasetEntry, DatasetManifest | `dataset/` (JSONL/SQLite) |
| Evolution Engine | Skill content, dataset | EvolutionRun, SkillVariant | `evolution/runs.db` |
| Fitness Evaluation | SkillVariant + dataset | FitnessScore | `evolution/runs.db` |
| Benchmark Gate | SkillVariant + dataset | pass/fail | `evolution/runs.db` |
| Deployment | Best variant | PrRecord | `evolution/prs.db` |

## SQLite Databases

| Path | Contents |
|------|----------|
| `trajectory.db` | TurnRecord, EpisodeRecord, TrajectoryRow |
| `dataset/` | DatasetEntryRow, DatasetManifestRow (per-dataset SQLite or JSONL) |
| `evolution/runs.db` | EvolutionRunRow, SkillVariantRow, FitnessScoreRow |
| `evolution/prs.db` | PrRecord, ReviewQueueItem |

Default paths are managed by the `storage` config block (`trajectoryDbPath`, `datasetPath`, `evolutionLogPath`).

## Key Design Decisions

### External plugin — no core changes
All self-evolution logic lives in this plugin. It communicates with OpenClaw exclusively through SDK hooks and the plugin API. OpenClaw core is never modified.

### Human-in-the-loop
Every evolved variant requires explicit human approval before being applied. The review queue (`evolution/prs.db`) persists pending PRs so they survive restarts and can be reviewed at any time.

### Cost controls as first-class citizens
Token and cost limits are checked per-generation, not just at the end. Runs that exceed `maxTokensPerRun`, `maxCostPerRun`, or the concurrent run limit are gracefully stopped and marked `stopped-early`.

### Genetic algorithm with LLM-as-judge
The GEPА evolver uses classic genetic operators (selection, crossover, mutation) on skill content strings. Fitness is evaluated by an LLM judge using a defined rubric rather than hand-coded metrics.

### DSPy bridge
The evolver has a `useDspyBridge` flag (`false` by default) to integrate DSPy optimization for prompt weights when available.
