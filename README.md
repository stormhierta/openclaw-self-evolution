# OpenClaw Self-Evolution Plugin

Self-evolution pipeline for OpenClaw skills using genetic algorithms and LLM-as-judge fitness evaluation.

> **Status:** Parts 1–3 implemented · Gap closure complete · Codex-approved  
> **Version:** 0.1.0 · **GitHub:** [stormhierta/openclaw-self-evolution](https://github.com/stormhierta/openclaw-self-evolution)

---

## What It Is

The self-evolution plugin continuously improves OpenClaw skills by collecting real agent trajectories, building training datasets, and using a genetic algorithm (GEPA) with LLM-as-judge fitness evaluation to evolve better skill variants. All changes require human approval before being applied, ensuring safe and controlled skill improvement.

In short: **watch → learn → evolve → approve → deploy**.

---

## How It Works

The plugin runs a closed-loop evolution pipeline across seven phases:

```
┌─────────────────────────────────────────────────────────────┐
│                  THE SELF-EVOLUTION LOOP                     │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐  │
│  │  TRAJECTORY  │────▶│   DATASET   │────▶│  EVOLUTION  │  │
│  │  COLLECTION  │     │   BUILDING  │     │   ENGINE    │  │
│  │              │     │              │     │             │  │
│  │ Session hooks│     │ Synthetic +  │     │ GEPA genetic│  │
│  │ capture tool │     │ mined +      │     │ algorithm   │  │
│  │ calls +      │     │ golden sets │     │ + LLM judge │  │
│  │ outcomes     │     │              │     │             │  │
│  └──────────────┘     └──────────────┘     └──────┬───────┘  │
│                                                  │          │
│  ┌──────────────┐     ┌──────────────┐            │          │
│  │   HUMAN     │◀────│   DEPLOY     │◀───────────┤          │
│  │  REVIEW     │     │   (git PR)   │            │          │
│  │             │     │              │            │          │
│  │ CLI approve │     │ Branch +     │            │          │
│  │ or reject   │     │ commit +     │            │          │
│  │             │     │ PR record   │            │          │
│  └──────┬──────┘     └──────────────┘            │          │
│         │                                        │          │
│         ▼                                        ▼          │
│  ┌──────────────┐                        ┌──────────────┐  │
│  │   VALIDATION │◀───────────────────────│  SELECT +   │  │
│  │              │                        │   MUTATE    │  │
│  │ SkillValidator│                        │             │  │
│  │ BenchmarkGate │                        │ prompt_     │  │
│  │ TestRunner   │                        │ rewrite,    │  │
│  └──────────────┘                        │ example_add,│  │
│                                          │ param_tweak │  │
│                                          │ ...         │  │
│                                          └─────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**The loop:**

1. **Trajectory Collection** — Session hooks capture every agent turn (tool calls, LLM inputs/outputs, outcomes) into SQLite.
2. **Dataset Building** — Mining extracts successful episodes; synthetic generation creates new test cases; golden sets provide curated benchmarks.
3. **Evolution Engine** — GEPA runs a genetic algorithm: score baseline → generate population → score variants via LLM judge → select elites → mutate → repeat for N generations.
4. **Validation** — Each variant passes `SkillValidator` (YAML frontmatter, required sections, no unsafe patterns) and `BenchmarkGate` (pass rate + fitness score thresholds).
5. **Deployment** — Best variant is committed to a git branch; a PR record enters the review queue.
6. **Human-in-the-Loop** — You review via CLI and approve or reject.
7. **Apply** — On approval, the change is merged and the skill is updated.

---

## Installation & Setup

### Prerequisites

- **OpenClaw** installed and running
- **Node.js** ≥ 18
- **Python 3.10+** (required only if using the DSPy bridge)
- **better-sqlite3** (for trajectory and dataset storage)

### Install from source

```bash
cd openclaw-self-evolution
npm install
npm run build
```

### Load the plugin

Add to your OpenClaw plugin configuration (e.g., `~/.openclaw/plugins.json` or via `openclaw config`):

```json
{
  "plugins": [
    {
      "id": "self-evolution",
      "enabled": true,
      "config": {
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
          "targetSkills": []
        },
        "costLimits": {
          "maxTokensPerRun": 1000000,
          "maxCostPerRun": 50.0,
          "maxConcurrentRuns": 2
        },
        "retentionDays": 90
      }
    }
  ]
}
```

Then reload plugins:

```bash
openclaw plugins reload
```

### Python setup (DSPy bridge)

Required only if you want DSPy-based optimization (`evolution.useDspyBridge: true` or `evolution.useDspyPrimary: true`):

```bash
# Create a virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install DSPy
pip install dspy

# Or install from requirements.txt if present
pip install -r requirements.txt
```

Set your API key:

```bash
export MINIMAX_API_KEY="your-api-key-here"
```

---

## Configuration Reference

All keys are optional. Defaults are shown.

### Top-level

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable the plugin |
| `retentionDays` | `integer` | `90` | Days to retain trajectory and evolution data |
| `sizeLimits` | `object` | — | Skill content size constraints (see below) |

### `trajectory`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable trajectory data collection |
| `sampleRate` | `number` | `1.0` | Fraction of sessions to sample (0.0–1.0) |
| `maxTurnsPerSession` | `integer` | `1000` | Max turns to record per session |

### `evolution`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `autoRun` | `boolean` | `false` | Automatically run evolution when data is available |
| `maxGenerations` | `integer` | `10` | Max generations per evolution run |
| `populationSize` | `integer` | `20` | Population size for the genetic algorithm |
| `mutationRate` | `number` | `0.3` | Probability of mutation per variant (0.0–1.0) |
| `eliteSize` | `integer` | `2` | Number of elite variants preserved each generation |
| `targetSkills` | `string[]` | `[]` | Only evolve these skills (empty = all) |
| `useDspyBridge` | `boolean` | `false` | Use DSPy bridge as post-genetic polishing step |
| `useDspyPrimary` | `boolean` | `false` | Use DSPy GEPA as the primary optimizer (hybrid mode) |
| `preWarmGenerations` | `integer` | `2` | Genetic generations before DSPy primary kicks in |
| `dspyIterations` | `integer` | `10` | GEPA max_steps when using DSPy as primary |
| `schedule.cron` | `string` | `"0 2 * * *"` | Cron expression for scheduled evolution |

### `costLimits`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `maxTokensPerRun` | `integer` | `1000000` | Max LLM tokens per evolution run |
| `maxCostPerRun` | `number` | `50.0` | Max USD cost per run |
| `maxConcurrentRuns` | `integer` | `2` | Max simultaneous evolution runs |

### `sizeLimits`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `maxSkillSizeBytes` | `integer` | `15000` | Maximum skill file size |
| `maxDescriptionLength` | `integer` | `500` | Maximum description length in characters |
| `maxSectionCount` | `integer` | `20` | Maximum number of sections |

### `storage`

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `trajectoryDbPath` | `string` | `null` | Path to SQLite trajectory DB |
| `datasetPath` | `string` | `null` | Path to dataset storage |
| `evolutionLogPath` | `string` | `null` | Path to evolution run logs |

---

## Agent Tools

Five tools are registered for agents to invoke at runtime.

### `run_evolution`

Trigger an evolution run for a specific skill.

```json
{
  "skillName": "my-skill",
  "generations": 10,       // optional
  "populationSize": 20      // optional
}
```

Returns:

```json
{
  "success": true,
  "runId": "evo-123456",
  "status": "completed",
  "bestFitnessScore": 82.5,
  "generationsCompleted": 10
}
```

### `evolution_status`

Check the status of an evolution run.

```json
{
  "runId": "evo-123456"      // either runId or skillName required
}
```

```json
{
  "skillName": "my-skill"    // omit runId to get latest run for a skill
}
```

### `dataset_build`

Build a training dataset for a skill from collected trajectories.

```json
{
  "skillName": "my-skill",
  "datasetType": "all",       // synthetic|mined|golden|external|all (default: all)
  "maxEntries": 100          // optional
}
```

Returns:

```json
{
  "success": true,
  "datasetId": "ds-789",
  "entryCount": 47,
  "name": "my-skill-evolution-v1"
}
```

### `benchmark_run`

Run benchmarks to evaluate a skill variant.

```json
{
  "skillName": "my-skill",
  "datasetId": "ds-789"       // optional — enables TestRunner + BenchmarkGate
}
```

### `propose_skill_edit`

Propose an edit to a skill for human review.

```json
{
  "skillName": "my-skill",
  "rationale": "Tool descriptions were unclear causing mis-routes",
  "proposedChanges": {
    "content": "# My Skill\n\n## Description\n..."
  }
}
```

### `check_evolution_need`

Check if a skill needs evolution based on recent performance data.

```json
{
  "skillName": "my-skill"     // optional — omit to check all tracked skills
}
```

### `label_trajectories`

Label recent trajectory turns with outcome quality scores for RL training.

```json
{
  "skillName": "my-skill",    // optional — label for specific skill
  "limit": 50                 // optional — max turns to label (default 50)
}
```

### `run_scheduler_cycle`

Manually trigger one autonomous evolution scheduler cycle.

```json
{}
```

---

## CLI Commands

### Evolution

```bash
# Run evolution for a skill
openclaw evolution run --skill <name> [--generations N]   # coming soon

# Check status
openclaw evolution status [--run-id <id>] [--skill <name>]  # coming soon

# List evolution runs
openclaw evolution list [--skill <name>]                # coming soon

# List pending PRs
openclaw evolution pr list

# Approve a PR
openclaw evolution pr approve --pr <id> [--note "text"]

# Reject a PR
openclaw evolution pr reject --pr <id> [--note "text"]
```

> **Note:** `evolution run`, `evolution status`, and `evolution list` are scaffolded stubs. Full CLI parity is planned. The PR subcommands (`list`, `approve`, `reject`) are fully functional.

### Dataset

```bash
openclaw dataset build --skill <name> [--type all]       # coming soon
openclaw dataset list [--skill <name>]                  # coming soon
openclaw dataset validate --dataset <id>                 # coming soon
```

### Benchmark

```bash
openclaw benchmark run --skill <name> [--variant <id>]  # coming soon
openclaw benchmark list [--skill <name>]                 # coming soon
openclaw benchmark compare --baseline <id> --compare <id>  # coming soon
```

---

## The Evolution Workflow

A complete run from trajectory collection to PR approval:

### 1. Trajectory Collection (continuous)

Session hooks capture agent interactions:

- `onLlmInput` — records prompt + sampling decision
- `onLlmOutput` — records response
- `onBeforeToolCall` / `onAfterToolCall` — captures tool intent and results
- `onAgentEnd` / `onSessionStart` / `onSessionEnd` — episode boundaries
- `onSubagentSpawned` / `onSubagentEnded` — delegation tracking

Data is buffered in memory and flushed to SQLite every 30 seconds.

### 2. Dataset Building (on demand or auto)

```
TrajectoryLogger ──▶ DatasetBuilder ──▶ DatasetManager
                          │
         ┌────────────────┼────────────────┐
         ▼                ▼                ▼
  GoldenSetLoader   SessionMiner    SyntheticGenerator
   (curated)         (mined)          (LLM-generated)
```

- `GoldenSetLoader` — loads hand-curated `skill-name.jsonl` files
- `DatasetSessionMiner` — extracts successful episodes from trajectory DB
- `SyntheticGenerator` — generates new `(input, expected_output)` pairs via MiniMax API

### 3. GEPA Evolution (core loop)

```
┌─────────────────────────────────────────────────────┐
│  GEPA EVOLUTION LOOP                                │
│                                                      │
│  1. Score baseline (LlmJudge.scoreBaseline())      │
│  2. Generate initial population (LLM mutations)    │
│  3. For each generation:                            │
│     a. Score all variants (LlmJudge.scoreVariant)   │
│     b. Select elites (top N by fitness)             │
│     c. Generate new variants via mutation:          │
│        - prompt_rewrite                              │
│        - example_add / example_remove                │
│        - parameter_tweak                            │
│        - structure_change                            │
│     d. Check stopping conditions:                    │
│        - target score reached                        │
│        - no improvement for N generations           │
│        - cost/token limit reached                     │
│  4. Optionally invoke DSPy bridge (post-polish)    │
│  5. Return best variant                             │
└─────────────────────────────────────────────────────┘
```

**Five mutation types:**

| Mutation | Description |
|----------|-------------|
| `prompt_rewrite` | Rewrite the skill instruction text using LLM feedback |
| `example_add` | Add a new training example to the skill |
| `example_remove` | Remove a low-value or confusing example |
| `parameter_tweak` | Adjust parameters (thresholds, options) |
| `structure_change` | Reorganize section order or groupings |

### 4. Validation

Each variant passes through:

- **SkillValidator** — YAML frontmatter, required `##` sections, no unsafe patterns (`eval`, `child_process`, `rm -rf`, `sudo`)
- **SizeLimits** — byte size, description length, section count
- **BenchmarkGate** — `minPassRate ≥ 0.7`, `minFitnessScore ≥ 60`

### 5. Deployment

```
Best Variant ──▶ GitManager.createEvolutionBranch()
                      │
                      ▼
                 PrBuilder.buildPr()
                      │
                      ▼
                 ReviewQueue (status: pending)
```

A git branch is created, the variant is committed, and a PR record is inserted into SQLite.

### 6. Human Review

```bash
# See what's waiting
openclaw evolution pr list

# Approve and apply
openclaw evolution pr approve --pr <id> --note "Looks good, merging"

# Reject and discard
openclaw evolution pr reject --pr <id> --note "Needs more examples"
```

On approval, the branch is merged and the skill is updated. On rejection, the branch is deleted.

---

## Autonomous Mode

Enable fully automated evolution with `autoRun: true`:

```json
{
  "evolution": {
    "autoRun": true,
    "schedule": {
      "cron": "0 2 * * *"
    }
  }
}
```

With `autoRun: true`, the `EvolutionScheduler` runs in the background:

1. **Label trajectories** — `OutcomeLabeler` scores unlabeled turns with LLM-as-judge
2. **Check skill performance** — `EvolutionTrigger` evaluates reward signals and success rates
3. **Trigger evolution** — Skills below performance thresholds get queued for `run_evolution`
4. **Build PRs** — Approved best variants enter the review queue automatically

The scheduler cycles every 30 minutes (configurable via `intervalMs`). Use `run_scheduler_cycle` to trigger a cycle manually at any time.

### Autonomous mode config options

| Key | Default | Description |
|-----|---------|-------------|
| `intervalMs` | `1800000` (30 min) | Cycle interval |
| `minNewTurnsToTrigger` | `20` | Min new turns before considering a skill |
| `maxSkillsPerCycle` | `1` | Max skills to evolve per cycle |

---

## Python Setup (DSPy Bridge)

The DSPy bridge enables DSPy GEPA/MIPROv2 optimization on top of the genetic algorithm.

### requirements.txt

```
dspy>=2.0.0
```

### Installation

```bash
pip install dspy
```

### How it works

When `useDspyBridge: true`, after the genetic algorithm completes, the best variant is passed to `python/dspy_bridge.py` for DSPy optimization:

1. Skill text is wrapped in a `SkillModule` DSPy module
2. Train/val/holdout splits (50/25/25) are prepared
3. `dspy.GEPA` compiles the module using keyword-overlap metric
4. Falls back to `dspy.MIPROv2` if GEPA is unavailable
5. Holdout evaluation returns baseline vs. optimized scores

When `useDspyPrimary: true`, DSPy GEPA becomes the primary optimizer and the TS genetic loop runs first as a pre-warm phase.

---

## Examples

### Full configuration

```json
{
  "enabled": true,
  "trajectory": {
    "enabled": true,
    "sampleRate": 1.0,
    "maxTurnsPerSession": 500
  },
  "evolution": {
    "autoRun": true,
    "maxGenerations": 15,
    "populationSize": 25,
    "mutationRate": 0.35,
    "eliteSize": 3,
    "targetSkills": ["skill-evaluator", "test-runner"],
    "useDspyBridge": true,
    "schedule": {
      "cron": "0 3 * * *"
    }
  },
  "costLimits": {
    "maxTokensPerRun": 2000000,
    "maxCostPerRun": 100.0,
    "maxConcurrentRuns": 2
  },
  "sizeLimits": {
    "maxSkillSizeBytes": 20000,
    "maxDescriptionLength": 600
  },
  "retentionDays": 60
}
```

### `run_evolution` return value

```json
{
  "success": true,
  "runId": "evo-1712234567890-abc123",
  "status": "completed",
  "bestFitnessScore": 78.3,
  "generationsCompleted": 10
}
```

### `evolution_status` output

```json
{
  "found": true,
  "runId": "evo-1712234567890-abc123",
  "skillName": "skill-evaluator",
  "status": "completed",
  "currentGeneration": 10,
  "maxGenerations": 10,
  "bestFitnessScore": 78.3,
  "averageFitnessScore": 71.2,
  "startedAt": "2026-04-04T02:00:00.000Z",
  "completedAt": "2026-04-04T02:47:33.000Z",
  "errorMessage": null
}
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                     OPENCLAW CORE                            │
│  Session hooks (llm_input/output, tool_call, agent_end…)     │
└──────────────────────────┬─────────────────────────────────┘
                            │ hooks
┌───────────────────────────▼─────────────────────────────────┐
│                    PLUGIN ENTRY (index.ts)                    │
│  register() — wires config, hooks, tools, CLI               │
└────────────────┬────────────────────────────────────────────┘
                 │
    ┌────────────┼────────────┐
    ▼            ▼            ▼
┌────────┐  ┌──────────┐  ┌──────────┐
│HOOKS   │  │ TOOLS     │  │ CLI      │
│        │  │           │  │          │
│Traject.│  │run_evol  │  │evol run  │
│Hook    │  │dataset_  │  │evol pr   │
│Handler │  │build     │  │list/     │
│        │  │benchmark_│  │approve/  │
│9 SDK   │  │run       │  │reject    │
│hooks   │  │          │  │          │
└────┬───┘  └────┬─────┘  └────┬─────┘
     │            │             │
     ▼            ▼             ▼
┌────────────┐  ┌─────────────────────┐  ┌─────────────┐
│TRAJECTORY  │  │ EVOLUTION ENGINE    │  │ DEPLOYMENT  │
│LAYER       │  │                     │  │ STACK       │
│            │  │ GEPAEvolver         │  │             │
│Trajectory  │  │  ├─ LlmJudge         │  │ GitManager  │
│Logger      │  │  ├─ RubricRegistry  │  │ PrBuilder   │
│(SQLite)    │  │  └─ ConstraintValidator│ReviewQueue │
│            │  │                     │  │MetricsReporter│
│Session     │  │ EvolutionOptimizer  │  │             │
│Miner       │  │  ├─ DatasetBuilder  │  │             │
│            │  │  └─ GEPAEvolver     │  │             │
│Outcome     │  │                     │  │             │
│Labeler     │  │ DSPy Bridge (Python)│  │             │
│            │  └─────────────────────┘  └─────────────┘
│Trajectory  │
│HookHandler │
└────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    VALIDATION LAYER                          │
│  SkillValidator  SizeLimits  TestRunner  BenchmarkGate       │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    AUTOMATION LAYER                          │
│  EvolutionTrigger  EvolutionScheduler                       │
└─────────────────────────────────────────────────────────────┘
```

### Project structure

```
openclaw-self-evolution/
├── src/
│   ├── index.ts                    # Plugin entry, tool factories, CLI registration
│   ├── config.ts                   # Zod schema validation
│   ├── types.ts                    # All TypeScript interfaces
│   ├── hooks/
│   │   └── trajectory-hooks.ts    # 9 SDK hook handlers
│   ├── collection/
│   │   ├── trajectory-logger.ts    # SQLite persistence
│   │   ├── session-miner.ts        # OpenClaw session file parser
│   │   └── outcome-labeler.ts       # RL trajectory labeling
│   ├── dataset/
│   │   ├── manager.ts              # SQLite-backed dataset CRUD
│   │   ├── builder.ts               # Orchestrates all dataset sources
│   │   ├── session-miner.ts        # Mines DatasetEntry from trajectory DB
│   │   ├── synthetic-generator.ts   # LLM-generated test cases
│   │   └── golden-sets.ts          # Curated JSONL loader
│   ├── evolution/
│   │   ├── optimizer.ts            # Run lifecycle management
│   │   └── gepa/
│   │       └── evolver.ts          # GEPA genetic algorithm
│   │   └── fitness/
│   │       ├── llm-judge.ts        # LLM-as-judge scoring
│   │       └── rubrics.ts          # Scoring rubric registry
│   ├── validation/
│   │   ├── skill-validator.ts      # YAML, sections, unsafe patterns
│   │   ├── size-limits.ts          # Byte/char/section limits
│   │   ├── test-runner.ts          # LLM-simulated test execution
│   │   ├── benchmark-gate.ts       # Pass-rate + fitness thresholds
│   │   └── constraint-validator.ts # Unified constraint checking
│   ├── deployment/
│   │   ├── git-manager.ts          # Git branch/commit/push
│   │   ├── pr-builder.ts           # PR record creation
│   │   ├── review-queue.ts          # Approve/reject/reject workflow
│   │   └── metrics-reporter.ts     # Human-readable metrics
│   └── automation/
│       ├── evolution-trigger.ts    # Performance-based evolution triggers
│       └── scheduler.ts            # Background evolution scheduler
├── python/
│   └── dspy_bridge.py              # DSPy GEPA/MIPROv2 optimization
├── openclaw.plugin.json            # Plugin manifest + config schema
├── README.md                       # This file
├── DEVPLAN.md                      # Development plan
├── AUDIT_REPORT.md                 # Audit findings
└── HERMES_COMPARISON.md            # Hermes alignment analysis
```

---

## Development

### Build

```bash
npm install
npm run build        # TypeScript → dist/
```

### Type-check

```bash
./node_modules/.bin/tsc --noEmit
```

### Run tests

```bash
npm test             # 81 tests, all passing
```

### Watch mode

```bash
npm run dev
```

### Contributing

1. **Fork and clone:**
   ```bash
   git clone https://github.com/stormhierta/openclaw-self-evolution.git
   cd openclaw-self-evolution
   npm install
   ```

2. **Create a feature branch:**
   ```bash
   git checkout -b feat/my-feature
   ```

3. **Make your changes.** All types are in `src/types.ts`. All tool factories are in `src/index.ts`. Component logic lives in subdirectories.

4. **Run typecheck and tests:**
   ```bash
   ./node_modules/.bin/tsc --noEmit
   npm test
   ```

5. **Commit and open a PR:**
   ```bash
   git add .
   git commit -m "feat: describe your change"
   git push origin feat/my-feature
   ```

### Key design principles

- **Human-in-the-loop** — No variant is ever applied without explicit CLI approval.
- **Cost controls** — Three independent limits (tokens, USD, concurrency) prevent runaway spending.
- **LLM-as-judge** — Real task outcome evaluation, not format checking.
- **Git-based deployment** — Every change is a branch + commit, with clean rollback via `git revert`.
- **SQLite everywhere** — Trajectory, datasets, evolution runs, and PR records are all persisted in SQLite.

---

## Known Limitations

From the audit (2026-04-04):

- **`selectBest()` bug** — `GEPAEvolver.selectBest()` iterates the wrong array (MAJOR, to be fixed before production use)
- **CLI stubs** — `evolution run`, `evolution status`, `evolution list`, `dataset build/validate/list`, and `benchmark` commands are scaffolded; use tools for full functionality
- **Evolution engine test coverage** — GEPAEvolver unit tests are minimal
- **No length penalty** — `FitnessScore` lacks the explicit length-penalty field present in Hermes
- **External session importers** — No dedicated importers for Claude Code, Copilot, or Hermes session formats
- **Difficulty/category metadata** — Not yet generated during dataset building

---

## License

MIT
