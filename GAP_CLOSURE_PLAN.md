# Gap Closure Plan: OpenClaw Self-Evolution vs Hermes

**Date:** 2026-04-04  
**Author:** Kimi (coding subagent)  
**Purpose:** Detailed implementation plan for closing 4 remaining gaps between our OpenClaw self-evolution plugin and the Hermes reference implementation.

---

## Executive Summary

This plan addresses 4 critical gaps preventing full parity with Hermes:

1. **Gap 1:** Session importers for Claude Code / Copilot / OpenClaw sessions (with secret detection, two-stage relevance filter, and metadata generation)
2. **Gap 2:** Difficulty/category metadata in training datasets
3. **Gap 3:** DSPy as primary optimizer (not just post-polish)
4. **Gap 4:** Constraint validation inside the evolution loop

**Recommended Implementation Order:** Gap 4 → Gap 1 → Gap 2 → Gap 3

---

## Gap 1: Session Importers for Claude Code / Copilot / OpenClaw Sessions

### What Hermes Does

**Source File:** `reference/hermes-agent-self-evolution/evolution/core/external_importers.py`

Hermes has dedicated importers that:

1. **Parse session transcripts from different tools:**
   - `ClaudeCodeImporter`: Reads `~/.claude/history.jsonl` (user messages only)
   - `CopilotImporter`: Reads `~/.copilot/session-state/*/events.jsonl` (user+assistant pairs)
   - `HermesSessionImporter`: Reads `~/.hermes/sessions/*.json` (full conversations with tool context)

2. **Apply secret detection/redaction (lines 45-66):**
   ```python
   SECRET_PATTERNS = re.compile(
       r'('
       r'sk-ant-api\S+'           # Anthropic API keys
       r'|sk-or-v1-\S+'          # OpenRouter API keys
       r'|sk-\S{20,}'            # Generic OpenAI-style keys
       r'|ghp_\S+'               # GitHub personal access tokens
       # ... more patterns
       r')',
       re.IGNORECASE,
   )
   ```

3. **Run two-stage relevance filter (lines 188-260, 330-400):**
   - **Stage 1 (heuristic):** `_is_relevant_to_skill()` — cheap keyword overlap pre-filter
   - **Stage 2 (LLM):** `RelevanceFilter.ScoreRelevance` — DSPy signature that generates:
     - `relevant`: boolean
     - `expected_behavior`: string (rubric for evaluation)
     - `difficulty`: "easy" | "medium" | "hard"
     - `category`: string (what aspect of skill this tests)

4. **Produce metadata per entry:**
   - `source`: which tool the session came from
   - `difficulty`: easy/medium/hard
   - `category`: aspect of skill being tested
   - `expected_behavior`: rubric for LLM judge (not exact output)

### What We Currently Have

**Source Files:**
- `src/dataset/session-miner.ts` — mines DatasetEntry from trajectory logger
- `src/collection/session-miner.ts` — reads OpenClaw JSONL sessions

**Current gaps:**
- ❌ No secret detection/redaction
- ❌ No two-stage relevance filter (only outcome_type filter)
- ❌ No difficulty/category/expected_behavior metadata generation
- ❌ No importers for Claude Code or Copilot formats
- ❌ No LLM-based relevance scoring

### Implementation Approach

**Architecture Decision:** Create a new `ExternalSessionImporter` class that parallels Hermes's design but integrates with our TypeScript codebase and SQLite-based storage.

**Data Flow:**
```
Claude Code / Copilot / OpenClaw sessions
    ↓
ExternalSessionImporter.parse()
    ↓
SecretDetector.redact()
    ↓
RelevanceFilter.twoStageFilter()
    ├─ Stage 1: Heuristic keyword overlap
    └─ Stage 2: LLM scoring → difficulty, category, expected_behavior
    ↓
DatasetEntry with metadata
    ↓
DatasetBuilder.addEntries()
```

### New Files / Changes Needed

**New Files:**

1. **`src/dataset/external-importers/base.ts`** — Abstract base class for importers
   ```typescript
   export interface ParsedSession {
     source: 'claude-code' | 'copilot' | 'openclaw';
     taskInput: string;
     assistantResponse?: string;
     project?: string;
     sessionId: string;
     timestamp: string;
   }

   export abstract class ExternalImporter {
     abstract readonly sourceName: string;
     abstract extractMessages(limit?: number): Promise<ParsedSession[]>;
   }
   ```

2. **`src/dataset/external-importers/claude-code.ts`** — Claude Code importer
   - Parse `~/.claude/history.jsonl`
   - Extract user messages only

3. **`src/dataset/external-importers/copilot.ts`** — Copilot importer
   - Parse `~/.copilot/session-state/*/events.jsonl`
   - Pair user.message → assistant.message events

4. **`src/dataset/external-importers/openclaw.ts`** — OpenClaw importer (wrapper around existing SessionMiner)
   - Use existing `SessionMiner` but output `ParsedSession` format

5. **`src/dataset/external-importers/secret-detector.ts`** — Secret detection
   ```typescript
   export class SecretDetector {
     private static readonly PATTERNS = [
       /sk-ant-api\S+/gi,           // Anthropic
       /sk-or-v1-\S+/gi,           // OpenRouter
       /sk-\S{20,}/gi,             // OpenAI-style
       /ghp_\S+/gi,                // GitHub PAT
       /AKIA[0-9A-Z]{16}/g,        // AWS
       /\bpassword\s*[=:]\s*\S+/gi,
       /\bsecret\s*[=:]\s*\S+/gi,
       /-----BEGIN\s+(RSA\s+)?PRIVATE\sKEY-----/g,
       // ... etc
     ];

     static containsSecret(text: string): boolean;
     static redact(text: string): string;
   }
   ```

6. **`src/dataset/external-importers/relevance-filter.ts`** — Two-stage relevance filter
   ```typescript
   export interface RelevanceScore {
     relevant: boolean;
     expectedBehavior: string;
     difficulty: 'easy' | 'medium' | 'hard';
     category: string;
   }

   export class RelevanceFilter {
     // Stage 1: Heuristic pre-filter
     private isRelevantToSkill(text: string, skillName: string, skillText: string): boolean;

     // Stage 2: LLM scoring
     async scoreRelevance(
       session: ParsedSession,
       skillName: string,
       skillText: string
     ): Promise<RelevanceScore>;

     // Combined two-stage filter
     async filterAndScore(
       sessions: ParsedSession[],
       skillName: string,
       skillText: string,
       maxExamples: number
     ): Promise<Array<ParsedSession & RelevanceScore>>;
   }
   ```

7. **`src/dataset/external-importers/index.ts`** — Orchestrator
   ```typescript
   export class ExternalSessionImporter {
     async importForSkill(
       skillName: string,
       skillContent: string,
       sources: Array<'claude-code' | 'copilot' | 'openclaw'>,
       maxExamples?: number
     ): Promise<DatasetEntry[]>;
   }
   ```

**Modified Files:**

8. **`src/dataset/builder.ts`** — Integrate external importers
   - Add `includeExternalSessions` option to `BuildOptions`
   - Call `ExternalSessionImporter.importForSkill()` before mining

9. **`src/types.ts`** — Extend `DatasetEntry` metadata
   ```typescript
   export interface DatasetEntry {
     // ... existing fields ...
     metadata?: {
       // ... existing fields ...
       difficulty?: 'easy' | 'medium' | 'hard';
       category?: string;
       expectedBehavior?: string;  // Rubric for LLM judge
       source?: 'synthetic' | 'golden' | 'claude-code' | 'copilot' | 'openclaw';
     };
   }
   ```

### Estimated Scope

**Size:** Large (L) — ~600 lines across 8 new files + 2 modified files

**Breakdown:**
- Importer implementations: 200 lines
- Secret detector: 50 lines
- Relevance filter (2-stage): 200 lines
- Orchestrator + integration: 150 lines

### Dependencies

- **None** — can be implemented independently
- **Blocks:** Gap 2 (difficulty/category metadata depends on this)

---

## Gap 2: Difficulty/Category Metadata in Training Datasets

### What Hermes Does

**Source File:** `reference/hermes-agent-self-evolution/evolution/core/dataset_builder.py`

Hermes assigns difficulty/category at multiple points:

1. **During external import** (`external_importers.py` lines 330-400):
   - `RelevanceFilter.ScoreRelevance` generates `difficulty`, `category`, `expected_behavior`
   - Stored in `EvalExample` dataclass

2. **During synthetic generation** (`dataset_builder.py` lines 138-175):
   ```python
   class GenerateTestCases(dspy.Signature):
       """Generate test cases with difficulty and category..."""
       test_cases: str = dspy.OutputField(
           desc="JSON array of test cases, each with: task_input, expected_behavior, difficulty, category"
       )
   ```

3. **Storage in EvalExample** (`dataset_builder.py` lines 23-45):
   ```python
   @dataclass
   class EvalExample:
       task_input: str
       expected_behavior: str
       difficulty: str = "medium"  # easy, medium, hard
       category: str = "general"
       source: str = "synthetic"
   ```

4. **Usage in GEPA** (`evolve_skill.py`):
   - Train/val/holdout splits can be stratified by difficulty
   - `expected_behavior` is used as rubric for LLM judge

### What We Currently Have

**Source File:** `src/types.ts` lines 245-255

```typescript
export interface DatasetEntry {
  id: string;
  datasetId: string;
  input: string;
  expectedOutput: string;
  context?: Record<string, unknown>;
  score?: number;
  metadata?: Record<string, unknown>;  // ❌ Untyped — nothing uses it for difficulty/category
  createdAt: Date;
}
```

**Current gaps:**
- ❌ `metadata` is `Record<string, unknown>` — no typed fields
- ❌ `DatasetBuilder` doesn't assign difficulty/category
- ❌ `SyntheticGenerator` only generates `input`/`expectedOutput` pairs
- ❌ No stratified splitting by difficulty

### Implementation Approach

**Decision:** Add typed metadata fields to `DatasetEntry` and populate them at each source.

**Where metadata gets assigned:**

| Source | Where Assigned | How |
|--------|---------------|-----|
| External sessions | `RelevanceFilter.scoreRelevance()` | LLM call during import |
| Synthetic generation | `SyntheticGenerator.generateForSkill()` | LLM prompt includes difficulty/category request |
| Golden sets | Loaded from JSONL | Hand-curated in file |
| Session mining | `DatasetSessionMiner` | Heuristic based on turn complexity |

**How GEPA uses difficulty/category:**
- Stratified train/val/holdout splits (ensure each split has mix of difficulties)
- `expectedBehavior` becomes the rubric for `LlmJudge` instead of raw `expectedOutput`

### New Files / Changes Needed

**Modified Files:**

1. **`src/types.ts`** — Type the metadata fields
   ```typescript
   export interface DatasetEntryMetadata {
     // Source tracking
     source?: 'synthetic' | 'golden' | 'claude-code' | 'copilot' | 'openclaw';
     minedAt?: string;
     
     // Hermes-style metadata for GEPA
     difficulty?: 'easy' | 'medium' | 'hard';
     category?: string;
     expectedBehavior?: string;  // Rubric for LLM judge (replaces expectedOutput in scoring)
     
     // Legacy fields
     outcomeType?: string;
     rewardSignal?: number;
   }

   export interface DatasetEntry {
     id: string;
     datasetId: string;
     input: string;
     expectedOutput: string;  // Keep for backward compat
     context?: Record<string, unknown>;
     score?: number;
     metadata?: DatasetEntryMetadata;  // Typed instead of Record<string, unknown>
     createdAt: Date;
   }
   ```

2. **`src/dataset/synthetic-generator.ts`** — Generate difficulty/category
   - Modify the LLM prompt to request `difficulty` and `category` for each test case
   - Parse and include in `DatasetEntry.metadata`

3. **`src/dataset/builder.ts`** — Stratified splitting
   - Add `splitByDifficulty?: boolean` option
   - When enabled, ensure train/val/holdout each have proportional difficulty distribution

4. **`src/evolution/fitness/llm-judge.ts`** — Use `expectedBehavior` as rubric
   ```typescript
   // In buildEvaluationPrompt():
   const rubric = testCase.metadata?.expectedBehavior ?? testCase.expectedOutput;
   ```

5. **`src/dataset/session-miner.ts`** — Heuristic difficulty assignment
   - Assign difficulty based on:
     - Input length (longer = harder)
     - Number of skills involved (more = harder)
     - Outcome type (success on first try = easier)

### Estimated Scope

**Size:** Medium (M) — ~200 lines across 5 modified files

### Dependencies

- **Requires:** Gap 1 (external importers with relevance filter)
- **Blocks:** None (GEPA can work without this, but better with it)

---

## Gap 3: DSPy as Primary Optimizer (Not Just Post-Polish)

### What Hermes Does

**Source File:** `reference/hermes-agent-self-evolution/evolution/skills/evolve_skill.py` (lines 90-118, 170-190)

Hermes uses DSPy GEPA as the **primary** optimization loop:

```python
# Configure DSPy
lm = dspy.LM(eval_model)
dspy.configure(lm=lm)

# Create the baseline skill module
baseline_module = SkillModule(skill["body"])

# Prepare DSPy examples
trainset = dataset.to_dspy_examples("train")
valset = dataset.to_dspy_examples("val")

# Run GEPA optimization — THIS IS THE MAIN LOOP
optimizer = dspy.GEPA(
    metric=skill_fitness_metric,
    max_steps=iterations,
)

optimized_module = optimizer.compile(
    baseline_module,
    trainset=trainset,
    valset=valset,
)
```

**Key insight:** In Hermes, genetic mutations are DSPy's population exploration. The `SkillModule` wraps the skill text as a DSPy signature instruction, which is the optimizable parameter.

### What We Currently Have

**Source File:** `src/evolution/gepa/evolver.ts` (lines 280-320)

Our current flow:
1. Run custom genetic algorithm in TypeScript for N generations
2. Score with `LlmJudge.scoreVariant()` (real LLM-as-judge every generation)
3. **After** genetic evolution, optionally call DSPy bridge as "final polish"

```typescript
// In evolveSkill():
if (engineConfig.useDspyBridge) {
  const bridgeResult = await this.invokeDspyBridge({
    skillName,
    skillContent: bestScored.variant.content,  // Use best genetic variant
    // ...
  });
  // Use DSPy result if better
}
```

**Current gaps:**
- ❌ Custom genetic loop in TS runs first
- ❌ DSPy is optional post-processing
- ❌ No `SkillModule` wrapper for DSPy optimization
- ❌ `skill_fitness_metric` (keyword overlap) only used in bridge, not main loop

### Implementation Approach

**Decision:** Restructure to make DSPy the primary optimizer, but keep our genetic loop as a fallback/pre-warm mechanism.

**Two migration paths considered:**

| Approach | Pros | Cons |
|----------|------|------|
| **A: Full DSPy replacement** | Cleanest, matches Hermes exactly | Risky — breaks what works |
| **B: Hybrid (recommended)** | Keeps working genetic loop, makes DSPy central | More complex architecture |

**Recommended: Approach B — Hybrid with DSPy as Primary**

```
┌─────────────────────────────────────────────────────────────┐
│  EVOLUTION FLOW (Hybrid Approach)                           │
├─────────────────────────────────────────────────────────────┤
│  Phase 1: Pre-warm (optional)                               │
│  ├── Run 2-3 generations of TS genetic loop                 │
│  └── Generate diverse starting population                   │
│                                                             │
│  Phase 2: DSPy GEPA (primary)                               │
│  ├── Wrap best variant(s) in SkillModule                    │
│  ├── Run dspy.GEPA.compile() with train/val splits          │
│  └── Use keyword overlap metric for speed                   │
│                                                             │
│  Phase 3: Final validation                                  │
│  ├── Score on holdout with LlmJudge (real LLM-as-judge)     │
│  └── Apply BenchmarkGate                                    │
└─────────────────────────────────────────────────────────────┘
```

### New Files / Changes Needed

**Modified Files:**

1. **`python/dspy_bridge.py`** — Make it the primary optimizer
   - Add `optimize_skill_primary()` entry point that handles full evolution
   - Accept multiple starting variants (from pre-warm phase)
   - Return full evolution history, not just final result

2. **`src/evolution/gepa/evolver.ts`** — Restructure evolution flow
   ```typescript
   export interface GEPAEvolutionConfig {
     // Existing options
     maxGenerations: number;
     populationSize: number;
     
     // New: Phase control
     preWarmGenerations: number;  // TS genetic generations before DSPy (0 to skip)
     useDspyPrimary: boolean;     // Use DSPy as main optimizer
     dspyIterations: number;      // GEPA max_steps
   }

   // New method: Pre-warm phase
   private async runPreWarmPhase(
     skillContent: string,
     testCases: DatasetEntry[],
     generations: number
   ): Promise<SkillVariant[]>;

   // New method: DSPy primary phase
   private async runDspyPrimaryPhase(
     candidates: SkillVariant[],
     testCases: DatasetEntry[],
     iterations: number
   ): Promise<SkillVariant>;
   ```

3. **`src/evolution/gepa/skill-module.ts`** — TypeScript SkillModule wrapper
   ```typescript
   // Mirrors Python SkillModule for consistency
   export class SkillModule {
     constructor(public skillText: string) {}
     
     // Simulate what DSPy would do with this skill
     async execute(taskInput: string): Promise<string>;
   }
   ```

4. **`src/evolution/fitness/keyword-metric.ts`** — Fast keyword overlap metric
   ```typescript
   // Matches Python skill_fitness_metric for DSPy compatibility
   export function keywordOverlapMetric(
     expected: string,
     actual: string
   ): number {
     const expectedWords = new Set(expected.toLowerCase().split(/\s+/));
     const actualWords = new Set(actual.toLowerCase().split(/\s+/));
     const overlap = [...expectedWords].filter(w => actualWords.has(w)).length;
     return 0.3 + 0.7 * (overlap / expectedWords.size);
   }
   ```

**Migration Path:**

1. **Phase 1:** Keep existing `evolveSkill()` working unchanged
2. **Phase 2:** Add `runDspyPrimaryPhase()` behind `useDspyPrimary` flag
3. **Phase 3:** Default `useDspyPrimary: true` after validation
4. **Phase 4:** Deprecate pure-TS genetic loop

### Estimated Scope

**Size:** Large (L) — ~500 lines across 4 files

**Breakdown:**
- DSPy bridge enhancements: 150 lines
- Evolver restructuring: 250 lines
- SkillModule wrapper: 50 lines
- Keyword metric: 50 lines

### Dependencies

- **Requires:** Gap 4 (constraint validation — DSPy needs constraints)
- **Blocks:** None (can work in parallel once Gap 4 is done)

---

## Gap 4: Constraint Validation in Evolution Loop

### What Hermes Does

**Source File:** `reference/hermes-agent-self-evolution/evolution/core/constraints.py`

Hermes enforces constraints at **multiple points** in the evolution loop:

1. **Pre-evolution (baseline validation):** `evolve_skill.py` lines 130-145
   ```python
   baseline_constraints = validator.validate_all(skill["body"], "skill")
   ```

2. **Mid-loop constraints:** Not explicitly in Hermes, but implied — GEPA's `compile()` rejects invalid modules

3. **Post-evolution (evolved validation):** `evolve_skill.py` lines 195-210
   ```python
   evolved_constraints = validator.validate_all(evolved_body, "skill", baseline_text=skill["body"])
   if not all_pass:
       console.print("[red]✗ Evolved skill FAILED constraints — not deploying[/red]")
       return
   ```

**Constraints enforced:**
- Size limits (max_skill_size, max_tool_desc_size)
- Growth limit (max_prompt_growth vs baseline)
- Non-empty check
- Skill structure (YAML frontmatter, name, description)
- Test suite pass (optional, via `run_test_suite()`)

### What We Currently Have

**Source Files:**
- `src/validation/skill-validator.ts` — validates skill format
- `src/validation/size-limits.ts` — checks size constraints
- `src/validation/benchmark-gate.ts` — final gate AFTER evolution

**Current gaps:**
- ❌ No constraint checking *inside* the evolution loop
- ❌ Variants can waste scoring budget on obviously-invalid candidates
- ❌ No growth limit check (size vs baseline)
- ❌ `BenchmarkGate` runs after evolution is complete

### Implementation Approach

**Decision:** Add `ConstraintValidator` checks inside the evolution loop to reject bad variants early.

**Where to add constraint checks:**

```
Evolution Loop:
├── Generate initial population
│   └── ✅ Constraint check each variant (reject immediately)
│
├── For each generation:
│   ├── Score population
│   ├── Select elites
│   ├── Generate new variants via mutation
│   │   └── ✅ Constraint check each variant BEFORE scoring
│   │       (saves LLM judge calls on invalid variants)
│   └── Check stopping conditions
│
└── Final scoring
    └── ✅ BenchmarkGate (already exists)
```

### New Files / Changes Needed

**Modified Files:**

1. **`src/validation/constraint-validator.ts`** — New unified validator (combines existing validators)
   ```typescript
   export interface ConstraintCheck {
     name: string;
     passed: boolean;
     message: string;
   }

   export class ConstraintValidator {
     constructor(
       private skillValidator: SkillValidator,
       private sizeLimits: SizeLimits,
       private config: EvolutionConfig
     ) {}

     // Check all constraints on a variant
     validateVariant(
       variant: SkillVariant,
       baselineContent?: string
     ): { valid: boolean; checks: ConstraintCheck[] };

     // Check if variant passes minimum bar for scoring
     isScorable(variant: SkillVariant): boolean;

     // Check growth vs baseline
     checkGrowth(variant: SkillVariant, baseline: string): ConstraintCheck;
   }
   ```

2. **`src/evolution/gepa/evolver.ts`** — Add constraint checks in loop
   ```typescript
   // In generateVariants() — check before returning
   private async generateValidVariants(
     skillContent: string,
     count: number
   ): Promise<SkillVariant[]> {
     const valid: SkillVariant[] = [];
     let attempts = 0;
     const maxAttempts = count * 3;  // Allow 3x attempts for valid variants

     while (valid.length < count && attempts < maxAttempts) {
       const variant = await this.generateSingleVariant(skillContent);
       const check = this.constraintValidator.validateVariant(variant);
       
       if (check.valid) {
         valid.push(variant);
       } else {
         console.warn(`[evolver] Rejected invalid variant: ${check.checks.filter(c => !c.passed).map(c => c.name).join(', ')}`);
       }
       attempts++;
     }

     return valid;
   }

   // In evolution loop — check after mutation, before scoring
   private async mutateWithConstraints(
     elite: ScoredVariant,
     mutation: Mutation
   ): Promise<SkillVariant | null> {
     const mutated = await this.applyMutation(elite.variant.content, mutation);
     const variant: SkillVariant = {
       id: `${elite.variant.id}-mut-${Date.now()}`,
       skillName: elite.variant.skillName,
       generation: elite.variant.generation + 1,
       content: mutated,
       mutations: [...elite.variant.mutations, mutation],
       parents: [elite.variant.id],
       createdAt: new Date(),
     };

     const check = this.constraintValidator.validateVariant(variant);
     if (!check.valid) {
       console.warn(`[evolver] Mutation produced invalid variant, skipping`);
       return null;
     }

     return variant;
   }
   ```

3. **`src/validation/size-limits.ts`** — Add growth limit check
   ```typescript
   checkGrowth(
     content: string,
     baseline: string
   ): {
     valid: boolean;
     growthRatio: number;
     maxGrowth: number;
     error?: string;
   } {
     const growth = (content.length - baseline.length) / Math.max(1, baseline.length);
     const maxGrowth = 0.5;  // 50% growth limit
     return {
       valid: growth <= maxGrowth,
       growthRatio: growth,
       maxGrowth,
       error: growth > maxGrowth ? `Growth ${growth.toFixed(1%)} exceeds max ${maxGrowth}` : undefined
     };
   }
   ```

4. **`src/index.ts`** — Wire up ConstraintValidator
   - Instantiate `ConstraintValidator` with `SkillValidator` and `SizeLimits`
   - Pass to `GEPAEvolver` constructor

### Estimated Scope

**Size:** Small (S) — ~150 lines across 4 files

**Breakdown:**
- ConstraintValidator class: 80 lines
- Evolver integration: 50 lines
- SizeLimits growth check: 20 lines

### Dependencies

- **None** — uses existing validators
- **Blocks:** Gap 3 (DSPy primary needs constraint validation)

---

## Recommended Implementation Order

```
Week 1:
├── Gap 4: Constraint Validation (S)
│   └── Unlocks safe evolution loop
│
└── Gap 1: Session Importers (L)
    └── Provides rich training data with metadata

Week 2-3:
├── Gap 2: Difficulty/Category Metadata (M)
│   └── Depends on Gap 1
│
└── Gap 3: DSPy as Primary (L)
    └── Depends on Gap 4
    └── Benefits from Gap 2 (better metadata = better optimization)
```

**Rationale:**

1. **Gap 4 first** — Constraint validation is foundational. It prevents wasting compute on invalid variants and is required for DSPy integration.

2. **Gap 1 second** — External importers provide the rich training data needed for meaningful evolution. Without good data, DSPy can't optimize effectively.

3. **Gap 3 third** — DSPy as primary optimizer is the big architectural change. It should happen after constraints are in place and good data is flowing.

4. **Gap 2 parallel** — Metadata enrichment can happen alongside Gap 3. It improves the quality of training data but isn't strictly blocking.

---

## Summary Matrix

| Gap | Scope | Files New | Files Modified | Dependencies | Blocks |
|-----|-------|-----------|----------------|--------------|--------|
| 1. Session Importers | L | 7 | 2 | None | Gap 2 |
| 2. Difficulty/Category | M | 0 | 5 | Gap 1 | None |
| 3. DSPy Primary | L | 0 | 4 | Gap 4 | None |
| 4. Constraint Validation | S | 0 | 4 | None | Gap 3 |

**Total Estimated Effort:** ~1,450 lines across ~20 files

**Timeline:** 3-4 weeks with 1 developer

---

## References

All Hermes reference code is in:
```
/home/stormhierta/.openclaw/workspace/openclaw-self-evolution/reference/hermes-agent-self-evolution/
```

Key files:
- `evolution/core/external_importers.py` — Gap 1 reference
- `evolution/core/dataset_builder.py` — Gap 2 reference
- `evolution/skills/evolve_skill.py` — Gap 3 reference
- `evolution/core/constraints.py` — Gap 4 reference
