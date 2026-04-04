# OpenClaw Self-Evolution: DEVPLAN.md

**Date:** 2026-04-04  
**Author:** Kimi (coding subagent)  
**Purpose:** Fix the 4 fundamentally broken components in our self-evolution plugin by porting actual Hermes patterns.

---

## Executive Summary

Our OpenClaw self-evolution plugin has 4 broken core components that don't match the actual Hermes implementation:

1. **GEPA Evolver** — Random line-level mutations instead of trajectory-guided genetic evolution
2. **DSPy bridge** — Just wraps ChainOfThought, not real DSPy optimization (no bootstrap, no metric-driven compilation)
3. **Trajectory reward signals** — Computed from token count ratios (wrong signal — should measure skill outcome quality)
4. **LLM judge** — Evaluates format adherence, not actual task success

This plan maps each broken component to its Hermes reference implementation and provides specific fix instructions.

---

## Gap Analysis Table

| Broken Component | Our File | Hermes Reference | Core Gap |
|-----------------|----------|------------------|----------|
| **GEPA Evolver** | `src/evolution/gepa/evolver.ts` | `evolution/skills/evolve_skill.py` + `evolution/skills/skill_module.py` | We do random LLM mutations; Hermes uses `dspy.GEPA` with execution trace feedback |
| **DSPy Bridge** | `python/dspy_bridge.py` | `evolution/skills/evolve_skill.py` (lines 90-118) | We wrap ChainOfThought in a loop; Hermes uses `dspy.GEPA.compile()` with train/val splits |
| **Trajectory Rewards** | `src/collection/trajectory-logger.ts` | `evolution/core/external_importers.py` + `evolution/core/fitness.py` | We compute token ratios; Hermes uses LLM-as-judge on actual task outcomes |
| **LLM Judge** | `src/evolution/fitness/llm-judge.ts` | `evolution/core/fitness.py` | We score format adherence; Hermes scores `correctness`, `procedure_following`, `conciseness` |

---

## Fix Priority Order

**Priority 1: LLM Judge (S)** — Fastest fix, unlocks everything else. Without correct fitness scoring, evolution is blind.

**Priority 2: DSPy Bridge (M)** — Core infrastructure. Must be fixed before GEPA can work properly.

**Priority 3: GEPA Evolver (L)** — The main algorithm. Depends on working judge and DSPy bridge.

**Priority 4: Trajectory Rewards (M)** — Data pipeline improvement. Can be done in parallel with 2-3.

---

## Fix 1: LLM Judge — Score Task Success, Not Format

**Scope:** Small (~2 days)

### Current Broken Behavior
Our `LlmJudge.scoreVariant()` evaluates whether skill instructions are "clear" and "well-formatted". It doesn't actually test if an agent following the skill would succeed at the task.

### Hermes Reference
File: `reference/hermes-agent-self-evolution/evolution/core/fitness.py`

Key pattern:
```python
@dataclass
class FitnessScore:
    correctness: float = 0.0        # Did the agent produce correct output?
    procedure_following: float = 0.0 # Did it follow the skill's procedure?
    conciseness: float = 0.0        # Was it appropriately concise?
    feedback: str = ""              # Textual feedback for GEPA's reflective analysis

class LLMJudge:
    class JudgeSignature(dspy.Signature):
        """Evaluate an agent's response against expected behavior."""
        task_input: str = dspy.InputField()
        expected_behavior: str = dspy.InputField()  # Rubric, not exact text
        agent_output: str = dspy.InputField()
        skill_text: str = dspy.InputField()
        correctness: float = dspy.OutputField()
        procedure_following: float = dspy.OutputField()
        feedback: str = dspy.OutputField()  # GEPA uses this for reflection
```

### What Needs to Change

**File:** `src/evolution/fitness/llm-judge.ts`

1. **Change `LlmRawScores` interface:**
   ```typescript
   // OLD (broken):
   interface LlmRawScores {
     accuracy: number;
     relevance: number;
     completeness: number;
     tool_selection: number;
     output_quality: number;
   }
   
   // NEW (correct):
   interface LlmRawScores {
     correctness: number;         // Did the agent produce correct output?
     procedure_following: number; // Did it follow the skill's procedure?
     conciseness: number;         // Was it appropriately concise?
   }
   ```

2. **Change `buildEvaluationPrompt()` to include task simulation:**
   ```typescript
   // OLD: Just evaluates skill content quality
   // NEW: Simulates agent following skill, then judges outcome
   private buildEvaluationPrompt(
     variant: SkillVariant,
     testCase: DatasetEntry,
     rubric: RubricDefinition
   ): string {
     return `You are evaluating whether a skill produces correct agent behavior.
   
   ## SKILL INSTRUCTIONS (what the agent will follow)
   ${variant.content}
   
   ## TASK
   ${testCase.input}
   
   ## EXPECTED BEHAVIOR (rubric)
   ${testCase.expectedOutput}
   
   ## YOUR TASK
   Imagine an agent following the SKILL INSTRUCTIONS above to complete the TASK.
   
   Score the LIKELY outcome on:
   1. correctness (0-1): Would the agent produce correct output?
   2. procedure_following (0-1): Would the agent follow the skill's procedure?
   3. conciseness (0-1): Would the response be appropriately concise?
   
   Also provide specific, actionable feedback on what in the skill could be improved.
   
   Return ONLY JSON: {"correctness": N, "procedure_following": N, "conciseness": N, "feedback": "..."}`;
   }
   ```

3. **Add feedback field to FitnessScore:**
   ```typescript
   // In src/types.ts, add to FitnessScore:
   export interface FitnessScore {
     overall: number;
     components: FitnessComponents;
     feedback?: string;  // NEW: For GEPA's reflective analysis
     evaluatedAt: Date;
     method: string;
     rawScores: Record<string, number>;
   }
   ```

### Success Criteria
- Judge returns `correctness`, `procedure_following`, `conciseness` scores
- Judge provides actionable `feedback` string for each evaluation
- Scores correlate with actual task success (not just format quality)

---

## Fix 2: DSPy Bridge — Real DSPy Optimization

**Scope:** Medium (~4 days)

### Current Broken Behavior
Our `dspy_bridge.py` just wraps `dspy.ChainOfThought` in a manual iteration loop. It doesn't use:
- `dspy.GEPA` optimizer
- Train/val/holdout splits
- Metric-driven compilation
- Bootstrap few-shot examples

### Hermes Reference
File: `reference/hermes-agent-self-evolution/evolution/skills/evolve_skill.py` (lines 90-118)

Key pattern:
```python
# Configure DSPy
lm = dspy.LM(eval_model)
dspy.configure(lm=lm)

# Create the baseline skill module
baseline_module = SkillModule(skill["body"])

# Prepare DSPy examples
trainset = dataset.to_dspy_examples("train")
valset = dataset.to_dspy_examples("val")

# Run GEPA optimization
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

### What Needs to Change

**File:** `python/dspy_bridge.py` — Rewrite entirely

**New structure:**
```python
#!/usr/bin/env python3
"""
DSPy Bridge — Real DSPy + GEPA optimization for OpenClaw.
"""

import json
import sys
import dspy
from dataclasses import dataclass
from typing import List, Optional


@dataclass
class EvalExample:
    task_input: str
    expected_behavior: str  # Rubric, not exact output


class SkillModule(dspy.Module):
    """DSPy module wrapping a skill for optimization.
    
    The skill text is the optimizable parameter.
    """
    class TaskWithSkill(dspy.Signature):
        """Complete a task following the provided skill instructions."""
        skill_instructions: str = dspy.InputField()
        task_input: str = dspy.InputField()
        output: str = dspy.OutputField()
    
    def __init__(self, skill_text: str):
        super().__init__()
        self.skill_text = skill_text
        self.predictor = dspy.ChainOfThought(self.TaskWithSkill)
    
    def forward(self, task_input: str) -> dspy.Prediction:
        return self.predictor(
            skill_instructions=self.skill_text,
            task_input=task_input,
        )


def skill_fitness_metric(example: dspy.Example, prediction: dspy.Prediction, trace=None) -> float:
    """DSPy metric function — scores prediction quality.
    
    This is what GEPA uses to guide optimization.
    """
    # Quick heuristic scoring for speed during optimization
    # Full LLM-as-judge is too expensive for every GEPA step
    agent_output = getattr(prediction, "output", "") or ""
    expected = getattr(example, "expected_behavior", "") or ""
    
    if not agent_output.strip():
        return 0.0
    
    # Keyword overlap as fast proxy
    expected_words = set(expected.lower().split())
    output_words = set(agent_output.lower().split())
    if expected_words:
        overlap = len(expected_words & output_words) / len(expected_words)
        return 0.3 + (0.7 * overlap)
    
    return 0.5


def optimize_skill(request: dict) -> dict:
    """Main entry point — runs real DSPy + GEPA optimization."""
    
    skill_content = request["skillContent"]
    test_cases = request.get("testCases", [])
    config = request.get("config", {})
    
    max_iterations = int(config.get("maxIterations", 10))
    model = config.get("model", "MiniMax-M2.7")
    api_key = config.get("apiKey") or os.environ.get("MINIMAX_API_KEY")
    
    # Configure DSPy with MiniMax
    lm = dspy.LM(
        model=f"openai/{model}",
        api_key=api_key,
        api_base="https://api.minimax.io/v1",
    )
    dspy.configure(lm=lm)
    
    # Parse test cases into DSPy Examples
    examples = [
        dspy.Example(
            task_input=tc["input"],
            expected_behavior=tc.get("expectedOutput", ""),
        ).with_inputs("task_input")
        for tc in test_cases
    ]
    
    # Split: 50% train / 25% val / 25% holdout (or adjust based on count)
    n = len(examples)
    n_train = max(1, int(n * 0.5))
    n_val = max(1, int(n * 0.25))
    
    trainset = examples[:n_train]
    valset = examples[n_train:n_train + n_val]
    holdout = examples[n_train + n_val:]
    
    # Create baseline module
    baseline = SkillModule(skill_content)
    
    # Run GEPA optimization
    try:
        optimizer = dspy.GEPA(
            metric=skill_fitness_metric,
            max_steps=max_iterations,
        )
        optimized = optimizer.compile(
            baseline,
            trainset=trainset,
            valset=valset,
        )
    except Exception as e:
        # Fallback to MIPROv2 if GEPA unavailable
        optimizer = dspy.MIPROv2(
            metric=skill_fitness_metric,
            auto="light",
        )
        optimized = optimizer.compile(
            baseline,
            trainset=trainset,
        )
    
    # Evaluate on holdout set
    baseline_scores = []
    optimized_scores = []
    
    for ex in holdout:
        with dspy.context(lm=lm):
            baseline_pred = baseline(task_input=ex.task_input)
            baseline_scores.append(skill_fitness_metric(ex, baseline_pred))
            
            optimized_pred = optimized(task_input=ex.task_input)
            optimized_scores.append(skill_fitness_metric(ex, optimized_pred))
    
    avg_baseline = sum(baseline_scores) / max(1, len(baseline_scores))
    avg_optimized = sum(optimized_scores) / max(1, len(optimized_scores))
    
    return {
        "success": True,
        "optimizedContent": optimized.skill_text,
        "baselineScore": round(avg_baseline, 4),
        "optimizedScore": round(avg_optimized, 4),
        "improvement": round(avg_optimized - avg_baseline, 4),
        "trainExamples": len(trainset),
        "valExamples": len(valset),
        "holdoutExamples": len(holdout),
    }


def main():
    # Read JSON from stdin
    raw = sys.stdin.read()
    request = json.loads(raw) if raw.strip() else {}
    
    if request.get("action") == "optimize_skill":
        result = optimize_skill(request)
        print(json.dumps(result))
    else:
        print(json.dumps({"success": False, "error": "Unknown action"}))


if __name__ == "__main__":
    main()
```

### Success Criteria
- Uses `dspy.GEPA` optimizer (not manual loop)
- Proper train/val/holdout splits
- Metric-driven compilation
- Returns baseline vs optimized scores on holdout set

---

## Fix 3: GEPA Evolver — Trajectory-Guided Evolution

**Scope:** Large (~6 days)

### Current Broken Behavior
Our `GEPAEvolver` does:
1. Random line-level mutations via LLM
2. Elite selection by overall score only
3. No use of execution traces or trajectory feedback

### Hermes Reference
Files:
- `reference/hermes-agent-self-evolution/evolution/skills/evolve_skill.py`
- `reference/hermes-agent-self-evolution/evolution/core/fitness.py`

Key patterns:
1. **GEPA reads execution traces** to understand WHY things fail
2. **Reflective mutation** — GEPA uses LLM feedback to guide mutations
3. **Population-based search** with Pareto-optimal selection
4. **Constraint validation** before accepting variants

### What Needs to Change

**File:** `src/evolution/gepa/evolver.ts` — Major refactor

**Key changes:**

1. **Add trajectory feedback to mutation:**
   ```typescript
   interface MutationContext {
     variant: SkillVariant;
     fitnessScore: FitnessScore;
     // NEW: Include feedback from failed evaluations
     failureFeedback?: string[];
     // NEW: Include execution traces for reflective analysis
     executionTraces?: ExecutionTrace[];
   }
   
   interface ExecutionTrace {
     testCase: DatasetEntry;
     predictedOutput: string;
     score: number;
     feedback: string;  // Why did this fail?
   }
   ```

2. **Change mutation strategy from random to feedback-guided:**
   ```typescript
   // OLD: Random mutation type selection
   const mutation = mutationsToApply[Math.floor(Math.random() * mutationsToApply.length)];
   
   // NEW: Use fitness feedback to select mutation type
   private selectMutationType(context: MutationContext): Mutation["type"] {
     const feedback = context.fitnessScore.feedback?.toLowerCase() || "";
     
     // If feedback mentions "unclear" or "confusing" → prompt_rewrite
     if (feedback.includes("unclear") || feedback.includes("confusing")) {
       return "prompt_rewrite";
     }
     // If feedback mentions "missing example" or "need example" → example_add
     if (feedback.includes("missing example") || feedback.includes("need example")) {
       return "example_add";
     }
     // If feedback mentions "too long" or "verbose" → example_remove
     if (feedback.includes("too long") || feedback.includes("verbose")) {
       return "example_remove";
     }
     // If feedback mentions "wrong order" or "structure" → structure_change
     if (feedback.includes("wrong order") || feedback.includes("structure")) {
       return "structure_change";
     }
     
     // Default: random
     const types: Mutation["type"][] = ["prompt_rewrite", "example_add", "structure_change"];
     return types[Math.floor(Math.random() * types.length)];
   }
   ```

3. **Add reflective mutation prompt:**
   ```typescript
   private async applyReflectiveMutation(
     skillContent: string,
     context: MutationContext
   ): Promise<string> {
     const feedbackContext = context.fitnessScore.feedback 
       ? `\n## PREVIOUS FEEDBACK\nThe previous variant scored ${context.fitnessScore.overall}/100.\nFeedback: ${context.fitnessScore.feedback}`
       : "";
     
     const traceContext = context.executionTraces
       ?.filter(t => t.score < 0.5)
       .map(t => `- Task: ${t.testCase.input}\n  Issue: ${t.feedback}`)
       .join("\n");
     
     const prompt = `You are an expert at improving AI agent skills through reflective mutation.
   
   ## CURRENT SKILL
   ${skillContent}
   
   ${feedbackContext}
   
   ${traceContext ? `## FAILURE PATTERNS\n${traceContext}` : ""}
   
   ## TASK
   Analyze the feedback and failure patterns above, then produce an improved version of the skill that addresses these issues.
   
   Return ONLY the improved skill content (Markdown with frontmatter).`;
   
     return this.callMiniMax(prompt);
   }
   ```

4. **Integrate with DSPy bridge for final optimization:**
   ```typescript
   // After genetic evolution, run DSPy GEPA on the best variant
   if (engineConfig.useDspyBridge && bestScored.score.overall < targetScore * 100) {
     const bridgeResult = await this.invokeDspyBridge({
       skillName,
       skillContent: bestScored.variant.content,
       testCases: testCases.map(tc => ({
         input: tc.input,
         expectedOutput: tc.expectedOutput,
       })),
       config: {
         maxIterations: 10,
         model: "MiniMax-M2.7",
       },
     });
     
     // Use DSPy result if better
     if (bridgeResult.success && bridgeResult.optimizedScore > bestScored.score.overall / 100) {
       // Update best variant with DSPy result
     }
   }
   ```

### Success Criteria
- Mutations are guided by fitness feedback (not random)
- Execution traces inform mutation strategy
- Integration with DSPy bridge for final polish
- Improvement over baseline is measurable and consistent

---

## Fix 4: Trajectory Rewards — Outcome Quality, Not Token Count

**Scope:** Medium (~3 days)

### Current Broken Behavior
Our `TrajectoryLogger` computes reward signals from token count ratios. This is meaningless — it doesn't measure whether the skill actually succeeded.

### Hermes Reference
Files:
- `reference/hermes-agent-self-evolution/evolution/core/external_importers.py` (SessionDB mining)
- `reference/hermes-agent-self-evolution/evolution/core/fitness.py` (LLM-as-judge scoring)

Key pattern:
```python
# Hermes mines real sessions and uses LLM-as-judge to score outcomes
class RelevanceFilter:
    def filter_and_score(self, messages, skill_name, skill_text):
        # Use LLM to score whether (task_input, assistant_response) is a success
        scoring = self.scorer(
            skill_name=skill_name,
            skill_description=skill_desc,
            user_message=msg["task_input"],
            assistant_response=msg.get("assistant_response", ""),
        )
        # Returns: relevant, expected_behavior, difficulty, category
```

### What Needs to Change

**File:** `src/collection/trajectory-logger.ts`

1. **Change reward signal computation:**
   ```typescript
   // OLD (broken):
   // reward_signal computed from token count ratios
   
   // NEW (correct):
   interface OutcomeEvaluation {
     success: boolean;
     quality: number;  // 0-1 score from LLM-as-judge
     feedback: string; // Why this outcome succeeded/failed
   }
   
   async computeRewardSignal(
     turn: TurnRecordRow,
     skillContent: string
   ): Promise<number> {
     // Use LLM to evaluate outcome quality
     const evaluation = await this.evaluateOutcome(turn, skillContent);
     return evaluation.quality;
   }
   
   private async evaluateOutcome(
     turn: TurnRecordRow,
     skillContent: string
   ): Promise<OutcomeEvaluation> {
     const prompt = `Evaluate the outcome of an agent following skill instructions.
   
   ## SKILL INSTRUCTIONS
   ${skillContent}
   
   ## TASK
   ${turn.user_message}
   
   ## AGENT OUTPUT
   ${turn.outcome_json}
   
   ## YOUR TASK
   Evaluate whether the agent successfully completed the task.
   
   Return JSON: {"success": true/false, "quality": 0.0-1.0, "feedback": "..."}`;
   
     const response = await this.callMiniMax(prompt);
     return JSON.parse(response);
   }
   ```

2. **Add outcome labeling to trajectory storage:**
   ```typescript
   // In src/types.ts, add to TurnRecordRow:
   export interface TurnRecordRow {
     // ... existing fields ...
     outcome_evaluation?: OutcomeEvaluation;  // NEW
   }
   ```

3. **Add trajectory labeling method:**
   ```typescript
   /**
    * Label trajectories with outcome quality for use in evolution.
    * 
    * This mines real session data and uses LLM-as-judge to score outcomes,
    * similar to Hermes' SessionDB mining approach.
    */
   async labelTrajectories(
     skillName: string,
     skillContent: string,
     sessionKey?: string
   ): Promise<LabeledTrajectory[]> {
     // Query turns for this skill
     const turns = await this.query({ skillName, sessionKey });
     
     const labeled: LabeledTrajectory[] = [];
     
     for (const turn of turns) {
       const evaluation = await this.evaluateOutcome(turn, skillContent);
       
       labeled.push({
         turn,
         evaluation,
         // Compute reward signal based on outcome quality, not tokens
         rewardSignal: evaluation.quality,
       });
     }
     
     return labeled;
   }
   ```

### Success Criteria
- Reward signals reflect actual task outcome quality (0-1)
- Outcomes are labeled with LLM-as-judge
- Labeled trajectories can be used as training data for evolution
- Feedback strings provide signal for reflective mutation

---

## Implementation Order & Dependencies

```
Week 1:
├── Fix 1: LLM Judge (S) ──► Unblocks all other fixes
│   └── src/evolution/fitness/llm-judge.ts
│
├── Fix 4: Trajectory Rewards (M) ──► Can run in parallel
│   └── src/collection/trajectory-logger.ts
│
Week 2:
├── Fix 2: DSPy Bridge (M)
│   └── python/dspy_bridge.py (rewrite)
│
Week 3-4:
└── Fix 3: GEPA Evolver (L)
    └── src/evolution/gepa/evolver.ts (major refactor)
    └── Depends on: Fix 1, Fix 2
```

---

## Testing Strategy

For each fix:

1. **Unit tests:** Test individual functions with mocked LLM responses
2. **Integration tests:** Test full pipeline with small synthetic dataset
3. **Regression tests:** Ensure evolved skills don't break existing functionality

**Test dataset (synthetic):**
```json
{
  "skillName": "test-skill",
  "skillContent": "# Test Skill\n\nWhen asked to greet, say 'Hello!'",
  "testCases": [
    {
      "input": "Greet the user",
      "expectedOutput": "The agent should say 'Hello!'"
    },
    {
      "input": "Say hi",
      "expectedOutput": "The agent should respond with a greeting"
    }
  ]
}
```

---

## Files to Modify

| File | Change Type | Lines (approx) |
|------|-------------|----------------|
| `src/evolution/fitness/llm-judge.ts` | Edit | ~100 lines |
| `src/types.ts` | Edit | ~20 lines (add feedback field) |
| `python/dspy_bridge.py` | Rewrite | ~200 lines |
| `src/evolution/gepa/evolver.ts` | Major refactor | ~300 lines |
| `src/collection/trajectory-logger.ts` | Edit | ~100 lines |

---

## References

All Hermes reference code is in:
```
/home/stormhierta/.openclaw/workspace/openclaw-self-evolution/reference/hermes-agent-self-evolution/
```

Key files:
- `evolution/skills/evolve_skill.py` — Main GEPA orchestration
- `evolution/skills/skill_module.py` — SkillModule DSPy wrapper
- `evolution/core/fitness.py` — LLM-as-judge scoring
- `evolution/core/external_importers.py` — SessionDB mining
- `evolution/core/dataset_builder.py` — Train/val/holdout splits
