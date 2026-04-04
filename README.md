# openclaw-self-evolution

Self-evolution pipeline for OpenClaw skills using genetic algorithms and LLM-as-judge fitness evaluation.

## Overview

The self-evolution plugin continuously improves OpenClaw skills by collecting real agent trajectories, building training datasets, and using a genetic algorithm with LLM-judge fitness evaluation to evolve better skill variants. All changes require human approval before being applied, ensuring safe and controlled skill improvement.

## Architecture

The pipeline executes in seven phases:

1. **Trajectory Collection** — Session hooks capture agent interactions (tool calls, responses, outcomes) into a SQLite trajectory database
2. **Dataset Building** — Session mining extracts useful episodes; synthetic generation creates additional training examples; golden sets provide curated benchmarks
3. **Evolution Engine** — A genetic algorithm (GEPA) mutates skill content across generations using crossover and targeted mutations (prompt rewrite, example add/remove, parameter tweak, structure change)
4. **Validation** — Each variant is validated against size limits and schema before fitness evaluation
5. **Tool Layer** — Benchmarking runs variants against datasets; fitness scoring uses LLM-as-judge with a rubric (correctness, format adherence, efficiency, robustness, clarity)
6. **Deployment** — Approved variants are committed to git branches; PR records enter a review queue
7. **Human-in-the-Loop** — A human reviews PRs via CLI and approves or rejects; approved changes are merged and applied

## Installation

```bash
# Install via OpenClaw plugin registry
openclaw plugins install self-evolution

# Or install from source
cd openclaw-self-evolution
npm install
npm run build
openclaw plugins load ./dist/index.js
```

## Configuration

See [`schemas/evolution-config.json`](schemas/evolution-config.json) for the full schema. All keys are optional — defaults are shown below.

```json
{
  "enabled": true,
  "trajectory": {
    "enabled": true,
    "sampleRate": 1.0,
    "maxTurnsPerSession": 1000
  },
  "evolution": {
    "autoRun": false,
    "maxGenerations": 10,
    "populationSize": 20,
    "mutationRate": 0.3,
    "eliteSize": 2,
    "targetSkills": [],
    "schedule": {
      "cron": "0 2 * * *"
    }
  },
  "costLimits": {
    "maxTokensPerRun": 1000000,
    "maxCostPerRun": 50.0,
    "maxConcurrentRuns": 2
  },
  "retentionDays": 90,
  "storage": {
    "trajectoryDbPath": null,
    "datasetPath": null,
    "evolutionLogPath": null
  }
}
```

## CLI Usage

> **Note:** The following CLI commands are scaffolded and partially implemented. Tool-based usage via the agent (e.g., `run_evolution`, `benchmark_run` tools) is fully functional. Full CLI parity is planned.

### Evolution runs

```bash
# Run evolution for a skill (default 10 generations) — coming soon
openclaw evolution run --skill <name> [--generations N]

# Check status of evolution runs — coming soon
openclaw evolution status [--skill <name>] [--run-id <id>]
```

### Dataset management

```bash
# Build a training dataset for a skill — coming soon
openclaw dataset build --skill <name> [--type all|synthetic|mined|golden]
```

### Benchmarking

```bash
# Run benchmarks for a skill (optionally against a specific variant) — coming soon
openclaw benchmark run --skill <name> [--variant <variantId>]
```

### PR review

```bash
# List pending PRs
openclaw evolution pr list

# Approve and apply a PR
openclaw evolution pr approve --pr <id> [--note "text"]

# Reject a PR
openclaw evolution pr reject --pr <id> [--note "text"]
```

## Agent Tools

Agents can invoke these tools at runtime:

| Tool | Description |
|------|-------------|
| `run_evolution` | Trigger an evolution run for a skill |
| `evolution_status` | Check the status of an evolution run |
| `dataset_build` | Build a training dataset from trajectories |
| `benchmark_run` | Run benchmarks for a skill variant |
| `propose_skill_edit` | Propose an edit to a skill for review |

## Human-in-the-Loop Flow

1. **Evolve** — The optimizer generates skill variants across generations using genetic mutations
2. **Validate** — Each variant passes through size limits and skill validation
3. **Benchmark** — Variants are evaluated on datasets; LLM-as-judge scores fitness
4. **Create PR** — The best variant is committed to a git branch and a PR record is created
5. **Human reviews** — The human runs `openclaw evolution pr list` and approves or rejects via CLI
6. **Apply** — On approval, the change is merged and applied to the live skill

## Cost Controls

Three layers prevent runaway spending:

- **`maxTokensPerRun`** — Hard cap on LLM tokens consumed per evolution run (default: 1M)
- **`maxCostPerRun`** — Budget ceiling in USD per run (default: $50)
- **`maxConcurrentRuns`** — Maximum simultaneous evolution runs (default: 2)

When any limit is reached the run is gracefully stopped and recorded as `stopped-early`.

## Development

```bash
# Build TypeScript
npm run build

# Type-check without emitting
./node_modules/.bin/tsc --noEmit

# Run tests
npm test

# Watch mode
npm run dev
```

### Project structure

```
src/
├── collection/          # Phase 1: trajectory hooks & session mining
├── dataset/             # Phase 2: dataset building & synthetic generation
├── evolution/           # Phase 3: genetic optimizer & GEPА evolver
│   └── fitness/         # LLM-judge and rubric scoring
├── validation/          # Phase 4: size limits, schema, benchmarks
├── deployment/          # Phase 6-7: git manager, PR builder, review queue
├── hooks/               # OpenClaw SDK hooks (before_tool_call, etc.)
├── config.ts            # Configuration loader
└── index.ts             # Plugin entry point
```
