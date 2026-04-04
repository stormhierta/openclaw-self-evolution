# Hermes ↔ OpenClaw Self-Evolution: Functional Comparison

**Date:** 2026-04-04
**Sources:** Hermes `hermes-agent-self-evolution/` (Python) vs OpenClaw `openclaw-self-evolution/src/` (TypeScript)

---

## 1. GEPA / DSPy Optimization

### Hermes (`evolution/skills/evolve_skill.py`, `evolution/skills/skill_module.py`)

**What it does:**
- Wraps a `SKILL.md` file as a DSPy `SkillModule` — the skill text becomes a DSPy signature instruction, which is the optimizable parameter
- `SkillModule.TaskWithSkill` signature: `skill_instructions` + `task_input` → `output`
- Uses `dspy.GEPA(metric=skill_fitness_metric, max_steps=iterations)` to compile the module
- Falls back to `dspy.MIPROv2` if GEPA is unavailable in the DSPy version
- `skill_fitness_metric()` uses **keyword overlap** (fast proxy, not LLM-as-judge) during optimization steps: `0.3 + 0.7 * overlap`
- Full LLM-as-judge scoring runs only on the final holdout evaluation

**Key logic flow:**
1. Load skill → parse frontmatter + body
2. Build eval dataset (synthetic / golden / sessiondb)
3. Validate baseline constraints
4. Configure DSPy LM → `dspy.GEPA.compile(baseline_module, trainset, valset)`
5. Extract evolved text from `optimized_module.skill_text`
6. Validate evolved constraints
7. Evaluate on holdout (LLM judge)
8. Save evolved skill + metrics JSON

### Ours (`src/evolution/gepa/evolver.ts`, `python/dspy_bridge.py`)

**What we do:**
- `GEPAEvolver.evolveSkill()` runs a **custom genetic algorithm** (population → scoring → elite selection → mutation → repeat)
- Mutation types: `prompt_rewrite`, `example_add`, `example_remove`, `parameter_tweak`, `structure_change`
- Uses `LlmJudge.scoreVariant()` (real LLM-as-judge) for scoring at every generation — NOT a fast proxy
- `invokeDspyBridge()` calls `python/dspy_bridge.py` post-genetic-evolution as a "final polish" step
- The Python bridge runs **real DSPy GEPA/MIPROv2** with keyword-overlap metric
- `python/dspy_bridge.py` has full parity with Hermes: same `SkillModule` pattern, same `skill_fitness_metric` (keyword overlap), GEPA with MIPROv2 fallback

**Key logic flow (evolver.ts):**
1. Score baseline via `LlmJudge.scoreBaseline()`
2. Generate initial population via LLM mutation prompts
3. Score all variants via `LlmJudge.scoreVariant()` (LLM-as-judge per generation)
4. Select elites, mutate from elites, repeat for N generations
5. Invoke DSPy bridge for final polish
6. Return best variant + metrics

### Gap Status: ⚠️ Partial

| Aspect | Hermes | Ours | Status |
|---|---|---|---|
| DSPy GEPA optimizer | ✅ Real `dspy.GEPA` | ⚠️ Custom genetic in TS; real DSPy only as post-polish | Partial |
| Skill as DSPy module | ✅ `SkillModule` wraps skill text in signature | ✅ `python/dspy_bridge.py` has identical `SkillModule` | Equivalent |
| Fast metric (keyword overlap) | ✅ During GEPA steps | ✅ In DSPy bridge | Equivalent |
| LLM-as-judge during optimization | ❌ Only on holdout | ✅ Every generation | We go further |
| GEPA fallback to MIPROv2 | ✅ | ✅ | Equivalent |
| Constraint validation pre/post | ✅ | ❌ Not in evolver.ts | Partial |

**What would need to change for full parity (and beyond):**
- Add constraint validation (`ConstraintValidator`) in the evolution loop, before accepting a generation's best variant
- Consider using real DSPy GEPA as the primary optimizer (not just post-polish) — the Python bridge already supports this; the evolver.ts just routes through it optionally

---

## 2. Fitness / LLM Judge

### Hermes (`evolution/core/fitness.py`)

**What it does:**
- `LLMJudge.JudgeSignature` (DSPy CoT): scores `correctness`, `procedure_following`, `conciseness` (each 0.0–1.0) + textual `feedback`
- `FitnessScore` dataclass: `correctness`, `procedure_following`, `conciseness`, `length_penalty` (0–1), `feedback`
- `composite` property: `0.5*c + 0.3*p + 0.2*c - length_penalty`
- `length_penalty`: ramps 0→0.3 when artifact size exceeds 90% of `max_size`
- `skill_fitness_metric()` (fast DSPy metric): keyword overlap as 0.3 + 0.7*overlap
- Uses `dspy.ChainOfThought` for structured judge reasoning

### Ours (`src/evolution/fitness/llm-judge.ts`, `src/evolution/fitness/rubrics.ts`)

**What we do:**
- `LlmJudge.scoreVariant()` evaluates each variant across all test cases using `buildEvaluationPrompt()` (simulate → score → feedback)
- Same three dimensions: `correctness`, `procedure_following`, `conciseness` — but on **0–100 scale**
- `RubricRegistry` stores `RubricDefinition` with configurable `weight` per criterion (defaults 0.50/0.30/0.20, same as Hermes)
- `computeWeightedOverall()` uses rubric weights from registry
- `aggregateFeedback()`: picks feedback from lowest-scoring test case (most actionable)
- No length penalty in `FitnessScore` — the rubric's `conciseness` criterion handles this implicitly

### Gap Status: ⚠️ Partial

| Aspect | Hermes | Ours | Status |
|---|---|---|---|
| Score dimensions | correctness, procedure_following, conciseness | Same three | ✅ Equivalent |
| Score scale | 0.0–1.0 | 0–100 | Different but equivalent |
| Textual feedback | ✅ `JudgeSignature.feedback` | ✅ `parseScoreResponse().feedback` | ✅ Equivalent |
| Length penalty | ✅ `FitnessScore.length_penalty` (0–0.3) | ❌ No explicit length penalty | Partial gap |
| Configurable weights | ❌ Hardcoded 0.5/0.3/0.2 | ✅ Via `RubricRegistry` | We go further |
| Multi-example aggregation | Per-holdout averaging | Per-test-case averaging + lowest-score feedback | ✅ Equivalent |
| DSPy CoT for judge | ✅ | ❌ Manual JSON parsing (simulates CoT in prompt) | Partial |

**What would need to change for full parity:**
- Add an explicit `length_penalty` field to `FitnessScore` / `FitnessComponents` to match Hermes's artifact-size-aware penalty
- Use real DSPy `ChainOfThought` signature for the judge instead of manual prompt-based simulation

---

## 3. Dataset / Trajectory Mining

### Hermes (`evolution/core/external_importers.py`, `evolution/core/dataset_builder.py`)

**What it does (importers):**
- `ClaudeCodeImporter`: reads `~/.claude/history.jsonl` (user messages only)
- `CopilotImporter`: reads `~/.copilot/session-state/*/events.jsonl` (user+assistant pairs)
- `HermesSessionImporter`: reads `~/.hermes/sessions/*.json` (full conversations with tool messages)
- Secret detection via regex patterns (API keys, tokens, PEM keys, `password=` assignments, etc.)
- **Two-stage relevance filtering:**
  1. Cheap keyword overlap pre-filter (`_is_relevant_to_skill`)
  2. LLM `RelevanceFilter.ScoreRelevance` → `expected_behavior`, `difficulty`, `category`, `relevant` boolean
- `build_dataset_from_external()`: orchestrates import → filter → split → save

**What it does (builder):**
- `SyntheticDatasetBuilder`: uses `GenerateTestCases` DSPy signature → generates `(task_input, expected_behavior, difficulty, category)` tuples
- `EvalDataset`: train/val/holdout splits (50/25/25), stored as JSONL files
- `GoldenDatasetLoader`: loads hand-curated JSONL, auto-splits if only one file
- Min dataset size: 3 examples

### Ours (`src/collection/trajectory-logger.ts`, `src/dataset/`)

**What we do (trajectory-logger):**
- `TrajectoryLogger`: persists `TurnRecordRow`, `EpisodeRecordRow` to SQLite (`evolution_turns`, `evolution_episodes` tables)
- `evaluateOutcome()`: LLM-as-judge scoring 0.0–1.0 for turns with `target_skill` set
- `computeFallbackRewardSignal()`: heuristic using token count or durationMs (deprecated)
- `flush()`: snapshots buffer → computes reward signals → transaction-inserts → clears only committed IDs

**What we do (dataset):**
- `DatasetManager`: SQLite-backed dataset versioning with `datasets` + `dataset_entries` tables
- `DatasetBuilder`: orchestrates `GoldenSetLoader` + `DatasetSessionMiner` + `SyntheticGenerator` into one dataset
- `DatasetSessionMiner`: extracts `DatasetEntry[]` from `TrajectoryLogger` / `SessionMiner` query results, filters by `outcome_type=success`
- `SyntheticGenerator`: generates `(input, expected_output)` pairs via MiniMax API directly
- `GoldenSetLoader`: loads hand-curated datasets (stub / minimal)

### Gap Status: ⚠️ Partial

| Aspect | Hermes | Ours | Status |
|---|---|---|---|
| Claude Code importer | ✅ `ClaudeCodeImporter` | ❌ No dedicated importer | Missing |
| Copilot importer | ✅ `CopilotImporter` | ❌ No dedicated importer | Missing |
| Hermes session importer | ✅ `HermesSessionImporter` | ❌ No dedicated importer | Missing |
| Secret detection | ✅ Regex patterns | ❌ Not implemented | Missing |
| Two-stage relevance filter | ✅ Heuristic → LLM scoring | ⚠️ TrajectoryLogger uses only outcome type filter | Partial |
| LLM expected_behavior generation | ✅ `ScoreRelevance` generates rubric | ⚠️ `SyntheticGenerator` only generates input/output pairs, not rubrics | Partial |
| Difficulty/category metadata | ✅ From LLM relevance scoring | ❌ Not generated | Missing |
| Synthetic generation | ✅ DSPy `GenerateTestCases` signature | ✅ Direct MiniMax API call | Equivalent |
| Dataset storage format | JSONL files (train/val/holdout) | SQLite tables | Different but equivalent |
| Train/val/holdout split | 50/25/25 | 50/25/25 (via `DatasetBuilder`) | ✅ Equivalent |

**What would need to change for full parity:**
- Implement dedicated `ClaudeCodeImporter`, `CopilotImporter`, `HermesSessionImporter` (or equivalent) to directly read those tools' session formats
- Add secret detection to trajectory logging / dataset mining
- Extend `SyntheticGenerator` to produce `difficulty` and `category` metadata like Hermes's `ScoreRelevance` LLM step
- The two-stage relevance filter (heuristic pre-filter → LLM scoring) is not implemented; mined entries go directly from `outcome_type=success` filter to dataset

---

## 4. Outcome Labeling / Reward Signals

### Hermes (`evolution/core/fitness.py` — scoring + relevance filter parts)

**What it does:**
- `FitnessScore` (0.0–1.0 composite) is the primary reward signal
- `LLMJudge.score()` returns `FitnessScore` with `correctness`, `procedure_following`, `conciseness`, `length_penalty`, `feedback`
- Used to evaluate evolved skills on holdout sets (end of evolution only)
- `RelevanceFilter.ScoreRelevance` LLM call also assigns `expected_behavior`, `difficulty`, `category` to each mined example
- Outcome labeling is thus: **(fitness score + behavioral rubric + metadata)**

### Ours (`src/collection/trajectory-logger.ts` — `evaluateOutcome`)

**What we do:**
- `evaluateOutcome()`: LLM-as-judge rates a turn's `outcome_json` against `userMessage` → `{"score": N, "reason": "..."}` (0.0–1.0)
- Only invoked when `target_skill` is set (cost control)
- `computeRewardSignal()` falls back to `computeFallbackRewardSignal()` (token efficiency heuristic) if LLM call fails
- Stored as `reward_signal` column in `evolution_turns`
- `evaluateOutcome` does NOT generate `expected_behavior`, `difficulty`, or `category` — it's purely a 0–1 quality score

### Gap Status: ⚠️ Partial

| Aspect | Hermes | Ours | Status |
|---|---|---|---|
| Outcome quality score | ✅ `FitnessScore.composite` (multi-dimensional) | ✅ `evaluateOutcome` score (0–1) | Partial (different granularity) |
| Feedback for mutation | ✅ `FitnessScore.feedback` text | ✅ `evaluateOutcome.reason` text | ✅ Equivalent |
| Behavioral rubric generation | ✅ `ScoreRelevance.expected_behavior` | ❌ Not generated | Missing |
| Difficulty metadata | ✅ From `ScoreRelevance` | ❌ Not tracked | Missing |
| Category metadata | ✅ From `ScoreRelevance` | ❌ Not tracked | Missing |
| Reward signal in trajectory DB | N/A (Hermes uses separate holdout eval) | ✅ `reward_signal` in `evolution_turns` | We go further |

**What would need to change for full parity:**
- Add `expected_behavior`, `difficulty`, and `category` generation to `evaluateOutcome()` or a separate LLM step in trajectory logging, matching Hermes's `ScoreRelevance` output
- Extend `FitnessComponents` / `FitnessScore` to include difficulty and category fields

---

## Summary Matrix

| Component | Hermes | Ours | Gap |
|---|---|---|---|
| **GEPA / DSPy optimization** | Real `dspy.GEPA`, skill as DSPy module | Custom genetic in TS + DSPy bridge as post-polish | ⚠️ Partial |
| **Fast fitness metric** | Keyword overlap (0.3+0.7*overlap) | Keyword overlap in bridge | ✅ Equivalent |
| **LLM-as-judge fitness** | DSPy CoT `JudgeSignature`, 0–1 scale, length penalty | `LlmJudge`, 0–100 scale, configurable weights | ⚠️ Partial |
| **Claude Code importer** | ✅ | ❌ | ❌ Missing |
| **Copilot importer** | ✅ | ❌ | ❌ Missing |
| **Hermes session importer** | ✅ | ❌ | ❌ Missing |
| **Secret detection** | ✅ Regex patterns | ❌ | ❌ Missing |
| **Two-stage relevance filter** | ✅ Heuristic → LLM | ⚠️ Outcome-type only | ⚠️ Partial |
| **Difficulty/category metadata** | ✅ From LLM | ❌ | ❌ Missing |
| **Synthetic test case gen** | ✅ DSPy signature | ✅ Direct MiniMax | ✅ Equivalent |
| **Dataset storage** | JSONL files | SQLite | Different |
| **Train/val/holdout split** | 50/25/25 | 50/25/25 | ✅ Equivalent |
| **Outcome labeling** | Multi-dim fitness + rubric + metadata | Quality score + reason text | ⚠️ Partial |
| **Reward signal in trajectory** | N/A (holdout-only) | ✅ `reward_signal` column | We go further |

## Top Priorities for Full Parity

1. **Add dedicated session importers** (Claude Code, Copilot, Hermes-format) — or equivalent that reads from OpenClaw's own session storage
2. **Add length penalty** to `FitnessScore` / `FitnessComponents` to match Hermes's `composite` formula
3. **Add difficulty + category + expected_behavior** generation to outcome labeling / dataset mining
4. **Add constraint validation** to the evolution loop (Hermes's `ConstraintValidator` is not implemented in our evolver)
5. **Add secret detection** to trajectory mining
