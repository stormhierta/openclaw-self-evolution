# API Reference

## EvolutionOptimizer

Core orchestrator for skill evolution runs. Manages the full lifecycle from variant generation through selection and best-variant retrieval.

---

### `optimizeSkill(skillName, skillPath, options?)`

- **params:** `skillName: string`, `skillPath: string`, `options?: OptimizeOptions`
- **returns:** `Promise<EvolutionRun>`

Runs a full genetic evolution cycle for the named skill: initializes a population, evaluates fitness across generations, and returns the completed run record.

---

### `getRunStatus(runId)`

- **params:** `runId: string`
- **returns:** `Promise<EvolutionRun | null>`

Retrieves the current state of an evolution run, including generation progress, variant scores, and best fitness so far. Returns `null` if not found.

---

### `listRuns(filter?)`

- **params:** `filter?: { skillName?: string; status?: string }`
- **returns:** `Promise<EvolutionRun[]>`

Lists evolution runs with optional filtering by skill name or status.

---

### `applyBestVariant(runId, confirm)`

- **params:** `runId: string`, `confirm: boolean` (must be `true`)
- **returns:** `Promise<void>`

Marks the best variant from a completed run as approved and writes it to the skill file. Requires `confirm: true` to prevent accidental overwrites.

---

### `cancelRun(runId)`

- **params:** `runId: string`
- **returns:** `Promise<void>`

Cancels a running or pending evolution run. The run status is set to `cancelled` and partial progress is preserved.

---

## BenchmarkGate

Evaluates skill variants against datasets and enforces a pass threshold before a variant can proceed to deployment.

---

### `evaluate(variant, validationResult, testRunResult)`

- **params:** `variant: SkillVariant`, `validationResult: ValidationResult`, `testRunResult: TestRunResult`
- **returns:** `GateResult` (synchronous)

Runs the variant through all configured gates and returns a `GateResult` with `passed` (boolean), `reasons` (failure reasons), and `scores` (passRate, fitnessScore, validationPassed).

---

### `canApply(variant, validationResult, testRunResult)`

- **params:** `variant: SkillVariant`, `validationResult: ValidationResult`, `testRunResult: TestRunResult`
- **returns:** `boolean`

Convenience method — returns `true` if the variant passes all gates.

---

## PrBuilder

Creates git branches with evolved variant content and manages PR records in SQLite.

---

### `buildPr(run, variantContent, baselineFitnessScore?)`

- **params:** `run: EvolutionRun`, `variantContent: string`, `baselineFitnessScore?: number`
- **returns:** `Promise<PrRecord>`

Creates a git branch, commits the variant content, and inserts a PR record with status `pending`. The run must have status `completed` and a best variant.

---

### `getPr(prId)`

- **params:** `prId: string`
- **returns:** `Promise<PrRecord | null>`

Retrieves a single PR record by ID. Returns `null` if not found.

---

### `listPrs(filter?)`

- **params:** `filter?: { skillName?: string; status?: PrRecord['status'] }`
- **returns:** `Promise<PrRecord[]>`

Lists PR records with optional filtering by skill name and/or status.

---

### `updatePrStatus(prId, status, reviewNote?)`

- **params:** `prId: string`, `status: PrRecord['status']`, `reviewNote?: string`
- **returns:** `Promise<void>`

Updates the status (`pending` | `approved` | `rejected` | `merged`) and optionally records a review note. Throws if PR not found.

---

## ReviewQueue

Manages the ordered queue of pending PRs awaiting human review.

---

### `getPending()`

- **params:** none
- **returns:** `Promise<ReviewQueueItem[]>`

Returns all pending review queue items ordered by priority (descending) and then by queue time (oldest first).

---

### `approve(prId, reviewNote?)`

- **params:** `prId: string`, `reviewNote?: string`
- **returns:** `Promise<PrRecord>`

Approves a PR: updates its status to `approved` and records the review note. Does NOT apply the variant — the caller is responsible for that.

---

### `reject(prId, reviewNote?)`

- **params:** `prId: string`, `reviewNote?: string`
- **returns:** `Promise<PrRecord>`

Rejects a PR: updates its status to `rejected`, records the review note, and deletes the corresponding git branch via GitManager.

---

### `getStats()`

- **params:** none
- **returns:** `Promise<{ pendingCount: number; oldestPendingAgeMs: number | null }>`

Returns the number of pending PRs and the age of the oldest one in milliseconds (null if no pending PRs).

---

### `getHistory(limit?)`

- **params:** `limit?: number` (default 100)
- **returns:** `Promise<PrRecord[]>`

Returns all PR records ordered by creation time (newest first), up to `limit` entries.

---

## GitManager

Low-level git operations for applying skill variants to branches and managing the evolution branch lifecycle.

---

### `applyVariantToBranch(skillName, runId, variantContent, commitMessage?)`

- **params:** `skillName: string`, `runId: string`, `variantContent: string`, `commitMessage?: string`
- **returns:** `Promise<BranchResult>`

Full flow: creates a branch `evolution/<skillName>/<runId>`, writes `variantContent` to `<skillName>/SKILL.md`, commits, and optionally pushes. Returns `{ branchName, commitSha, pushed }`.

---

### `listEvolutionBranches(skillName?)`

- **params:** `skillName?: string`
- **returns:** `Promise<string[]>`

Lists all branches under `evolution/<skillName>/` (or `evolution/` if skillName omitted).

---

### `deleteBranch(branchName, remote?)`

- **params:** `branchName: string`, `remote?: boolean`
- **returns:** `Promise<void>`

Deletes the local branch. If `remote` is true, also deletes the remote branch. Switches to base branch if currently checked out.
