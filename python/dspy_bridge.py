#!/usr/bin/env python3
"""
DSPy Bridge — OpenClaw Self-Evolution Pipeline
Real DSPy + GEPA/MIPROv2 optimization for skill evolution.

Usage:
    echo '{...}' | python dspy_bridge.py
    python dspy_bridge.py '{...}'

Returns JSON via stdout with the optimization results.
"""

import json
import sys
import os
from typing import Any, List, Optional
from dataclasses import dataclass


# ---------------------------------------------------------------------------
# DSPy imports — fail gracefully if deps are missing
# ---------------------------------------------------------------------------

try:
    import dspy as _dspy
except ImportError as _dspy_import_err:
    _dspy = None  # type: ignore[assignment]
    _dspy_import_err_msg = str(_dspy_import_err)
else:
    _dspy_import_err_msg = ""


def _get_dspy():
    """Return the dspy module, raising if unavailable."""
    if _dspy is None:
        raise ImportError(
            f"DSPy not installed. Run: pip install -r python/requirements.txt. "
            f"Import error: {_dspy_import_err_msg}"
        )
    return _dspy


# ---------------------------------------------------------------------------
# SkillModule — DSPy module where skill text is the optimizable parameter
# ---------------------------------------------------------------------------

class SkillModule:
    """A DSPy module that wraps a skill file for optimization.
    
    The skill text is set as the signature instruction, which DSPy optimizers
    can modify during compilation. This is the correct pattern for optimization.
    
    Note: Does not inherit dspy.Module at class definition time to avoid
    import-time failures. Inherits dynamically in build_skill_module().
    """
    pass


def build_skill_module(dspy, skill_text: str):
    """Build a SkillModule class and instance with the given skill text.
    
    Deferred to runtime to avoid class-level DSPy import errors.
    """
    class TaskSignature(dspy.Signature):
        """Complete a task following the provided skill instructions."""
        task_input: str = dspy.InputField(desc="The task to complete")
        output: str = dspy.OutputField(desc="Your response following the skill instructions")

    class _SkillModule(dspy.Module):
        def __init__(self, skill_text: str):
            super().__init__()
            self.skill_text = skill_text
            # Set the skill as the signature instruction — this is what optimizers modify
            self.predict = dspy.ChainOfThought(
                TaskSignature.with_instructions(skill_text)
            )

        def forward(self, task_input: str):
            return self.predict(task_input=task_input)

    return _SkillModule(skill_text)


# ---------------------------------------------------------------------------
# Metric function for GEPA — fast keyword overlap as proxy
# ---------------------------------------------------------------------------

def skill_fitness_metric(example, prediction, trace=None) -> float:
    """DSPy metric function — scores prediction quality.
    
    Uses fast keyword overlap as a proxy for correctness.
    Full LLM-as-judge is too expensive for every GEPA step.
    
    Returns a score between 0.0 and 1.0.
    """
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


# ---------------------------------------------------------------------------
# Dataset splitting — train/val/holdout (50%/25%/25%, minimum 1 per split)
# ---------------------------------------------------------------------------

def split_dataset(examples: List[Any]) -> tuple[List[Any], List[Any], List[Any]]:
    """Split examples into train/val/holdout sets (50%/25%/25%).
    
    Ensures at least 1 example per split when possible.
    """
    n = len(examples)
    
    if n == 0:
        return [], [], []
    
    if n == 1:
        return examples, [], []
    
    if n == 2:
        return examples[:1], examples[1:], []
    
    # Minimum 1 per split
    n_train = max(1, int(n * 0.5))
    n_val = max(1, int(n * 0.25))
    n_holdout = max(1, n - n_train - n_val)
    
    # Adjust if we over-allocated
    if n_train + n_val + n_holdout > n:
        n_train = n - n_val - n_holdout
    
    trainset = examples[:n_train]
    valset = examples[n_train:n_train + n_val]
    holdout = examples[n_train + n_val:]
    
    return trainset, valset, holdout


# ---------------------------------------------------------------------------
# LM configuration — MiniMax API
# ---------------------------------------------------------------------------

def _build_lm(config: dict):
    """Build a DSPy LM wrapper for the MiniMax OpenAI-compatible endpoint."""
    dspy = _get_dspy()
    
    model = config.get("model", "MiniMax-M2.7")
    api_key = config.get("apiKey") or os.environ.get("MINIMAX_API_KEY", "")
    api_base = config.get("apiBase", "https://api.minimax.io/v1")
    
    if not api_key:
        raise ValueError("No API key provided: set config.apiKey or MINIMAX_API_KEY env var")
    
    return dspy.LM(
        model=f"openai/{model}",
        api_key=api_key,
        api_base=api_base,
        temperature=config.get("temperature", 0.7),
        max_tokens=config.get("maxTokens", 4096),
    )


# ---------------------------------------------------------------------------
# Optimizer selection — GEPA with fallback to MIPROv2
# ---------------------------------------------------------------------------

def _get_optimizer(dspy_module, metric, max_iterations: int):
    """Get the best available optimizer (GEPA preferred, MIPROv2 fallback).
    
    Checks both dspy.X and dspy.teleprompt.X for compatibility across DSPy versions.
    """
    
    # Try root namespace first, then teleprompt
    for attr in ['GEPA', 'MIPROv2', 'MIPRO']:
        cls = getattr(dspy_module, attr, None) or getattr(dspy_module.teleprompt, attr, None)
        if cls:
            try:
                if attr == 'GEPA':
                    return cls(metric=metric, max_steps=max_iterations), attr
                elif attr == 'MIPROv2':
                    return cls(metric=metric, auto="light"), attr
                elif attr == 'MIPRO':
                    return cls(metric=metric), attr
            except Exception:
                continue
    
    raise RuntimeError("No suitable optimizer found (tried GEPA, MIPROv2, MIPRO)")


# ---------------------------------------------------------------------------
# Primary optimization entry point (G3: DSPy as primary optimizer)
# ---------------------------------------------------------------------------

def optimize_skill_primary(request: dict) -> dict:
    """Primary optimization entry point — uses DSPy GEPA as the main loop.
    
    Accepts multiple starting candidates from the pre-warm phase and uses
    the highest-scoring candidate as the baseline for DSPy optimization.
    
    Args:
        request: Dict containing candidates, testCases, skillName, config
        
    Returns:
        Dict with optimization results in the standard JSON format.
    """
    dspy = _get_dspy()
    
    # Extract request fields
    candidates = request.get("candidates", [])
    test_cases = request.get("testCases", [])
    skill_name = request.get("skillName", "unknown")
    config = request.get("config", {})
    
    max_iterations = int(config.get("maxIterations", 10))
    
    # Validate candidates
    if not candidates:
        return {
            "success": False,
            "optimizedContent": "",
            "baselineScore": 0.0,
            "optimizedScore": 0.0,
            "improvement": 0.0,
            "trainExamples": 0,
            "valExamples": 0,
            "holdoutExamples": 0,
            "optimizer": "none",
            "error": "No candidates provided for primary optimization",
        }
    
    # Select the highest-scoring candidate as baseline
    best_candidate = max(candidates, key=lambda c: c.get("score", 0.0))
    skill_content = best_candidate.get("content", "")
    baseline_score = float(best_candidate.get("score", 0.0))
    
    # Validate minimum test cases
    if len(test_cases) < 3:
        return {
            "success": False,
            "optimizedContent": skill_content,
            "baselineScore": baseline_score,
            "optimizedScore": baseline_score,
            "improvement": 0.0,
            "trainExamples": 0,
            "valExamples": 0,
            "holdoutExamples": 0,
            "optimizer": "none",
            "error": f"Insufficient test cases: {len(test_cases)} provided, minimum 3 required for optimization",
        }
    
    try:
        # Configure DSPy with MiniMax
        lm = _build_lm(config)
        dspy.configure(lm=lm)
        
        # Parse test cases into DSPy Examples
        examples = []
        for tc in test_cases:
            ex = dspy.Example(
                task_input=tc.get("input", ""),
                expected_behavior=tc.get("expectedOutput", tc.get("expected_behavior", "")),
            ).with_inputs("task_input")
            examples.append(ex)
        
        # Split into train/val/holdout
        trainset, valset, holdout = split_dataset(examples)
        
        # Create baseline skill module from best candidate
        baseline_module = build_skill_module(dspy, skill_content)
        
        # Get optimizer (GEPA preferred, fallback to MIPROv2)
        import dspy.teleprompt  # noqa: F401 — ensures teleprompt is accessible
        optimizer, optimizer_name = _get_optimizer(dspy, skill_fitness_metric, max_iterations)
        
        # Run optimization
        if optimizer_name == "GEPA":
            optimized_module = optimizer.compile(
                baseline_module,
                trainset=trainset,
                valset=valset,
            )
        else:
            # MIPROv2 and MIPRO don't use valset in the same way
            optimized_module = optimizer.compile(
                baseline_module,
                trainset=trainset,
            )
        
        # Evaluate on holdout set
        baseline_scores = []
        optimized_scores = []
        
        for ex in holdout:
            with dspy.context(lm=lm):
                # Score baseline
                baseline_pred = baseline_module(ex.task_input)
                baseline_scores.append(skill_fitness_metric(ex, baseline_pred))
                
                # Score optimized
                optimized_pred = optimized_module(ex.task_input)
                optimized_scores.append(skill_fitness_metric(ex, optimized_pred))
        
        # Calculate averages
        avg_baseline = sum(baseline_scores) / max(1, len(baseline_scores)) if baseline_scores else baseline_score
        avg_optimized = sum(optimized_scores) / max(1, len(optimized_scores)) if optimized_scores else baseline_score
        improvement = avg_optimized - avg_baseline
        
        # Extract optimized skill text from the predictor's signature instructions
        try:
            optimized_content = (
                optimized_module.predict.signature.instructions
                or skill_content
            )
        except Exception:
            try:
                # Fallback paths for other DSPy versions
                optimized_content = (
                    getattr(optimized_module, 'predictor', None) and
                    getattr(optimized_module.predictor, 'signature', None) and
                    optimized_module.predictor.signature.instructions
                ) or skill_content
            except Exception:
                optimized_content = skill_content
        
        return {
            "success": True,
            "optimizedContent": optimized_content,
            "baselineScore": round(avg_baseline, 4),
            "optimizedScore": round(avg_optimized, 4),
            "improvement": round(improvement, 4),
            "trainExamples": len(trainset),
            "valExamples": len(valset),
            "holdoutExamples": len(holdout),
            "optimizer": optimizer_name,
            "candidateCount": len(candidates),
            "bestCandidateId": best_candidate.get("id", "unknown"),
        }
        
    except Exception as e:
        # Return original content with error info
        return {
            "success": False,
            "optimizedContent": skill_content,
            "baselineScore": baseline_score,
            "optimizedScore": baseline_score,
            "improvement": 0.0,
            "trainExamples": 0,
            "valExamples": 0,
            "holdoutExamples": 0,
            "optimizer": "none",
            "error": f"Primary optimization failed: {str(e)}",
        }


# ---------------------------------------------------------------------------
# Main optimization entry point
# ---------------------------------------------------------------------------

def optimize_skill(request: dict) -> dict:
    """Main optimization entry point — runs real DSPy + GEPA/MIPROv2 optimization.
    
    Args:
        request: Dict containing skillContent, testCases, rubric, baselineScore, config
        
    Returns:
        Dict with optimization results in the standard JSON format.
    """
    dspy = _get_dspy()
    
    # Extract request fields
    skill_content = request.get("skillContent", "")
    test_cases = request.get("testCases", [])
    rubric = request.get("rubric", {})
    baseline_score = float(request.get("baselineScore", 0.5))
    config = request.get("config", {})
    
    max_iterations = int(config.get("maxIterations", 10))
    
    # Validate minimum test cases
    if len(test_cases) < 3:
        return {
            "success": False,
            "optimizedContent": skill_content,
            "baselineScore": baseline_score,
            "optimizedScore": baseline_score,
            "improvement": 0.0,
            "trainExamples": 0,
            "valExamples": 0,
            "holdoutExamples": 0,
            "optimizer": "none",
            "error": f"Insufficient test cases: {len(test_cases)} provided, minimum 3 required for optimization",
        }
    
    try:
        # Configure DSPy with MiniMax
        lm = _build_lm(config)
        dspy.configure(lm=lm)
        
        # Parse test cases into DSPy Examples
        examples = []
        for tc in test_cases:
            ex = dspy.Example(
                task_input=tc.get("input", ""),
                expected_behavior=tc.get("expectedOutput", tc.get("expected_behavior", "")),
            ).with_inputs("task_input")
            examples.append(ex)
        
        # Split into train/val/holdout
        trainset, valset, holdout = split_dataset(examples)
        
        # Create baseline skill module
        baseline_module = build_skill_module(dspy, skill_content)
        
        # Get optimizer (GEPA preferred, fallback to MIPROv2)
        # Also make dspy.teleprompt available for older DSPy versions
        import dspy.teleprompt  # noqa: F401 — ensures teleprompt is accessible
        optimizer, optimizer_name = _get_optimizer(dspy, skill_fitness_metric, max_iterations)
        
        # Run optimization
        if optimizer_name == "GEPA":
            optimized_module = optimizer.compile(
                baseline_module,
                trainset=trainset,
                valset=valset,
            )
        else:
            # MIPROv2 and MIPRO don't use valset in the same way
            optimized_module = optimizer.compile(
                baseline_module,
                trainset=trainset,
            )
        
        # Evaluate on holdout set
        baseline_scores = []
        optimized_scores = []
        
        for ex in holdout:
            with dspy.context(lm=lm):
                # Score baseline
                baseline_pred = baseline_module(ex.task_input)
                baseline_scores.append(skill_fitness_metric(ex, baseline_pred))
                
                # Score optimized
                optimized_pred = optimized_module(ex.task_input)
                optimized_scores.append(skill_fitness_metric(ex, optimized_pred))
        
        # Calculate averages
        avg_baseline = sum(baseline_scores) / max(1, len(baseline_scores)) if baseline_scores else baseline_score
        avg_optimized = sum(optimized_scores) / max(1, len(optimized_scores)) if optimized_scores else baseline_score
        improvement = avg_optimized - avg_baseline
        
        # Extract optimized skill text from the predictor's signature instructions
        # In DSPy 3.x, the path is module.predict.signature.instructions
        try:
            optimized_content = (
                optimized_module.predict.signature.instructions
                or skill_content
            )
        except Exception:
            try:
                # Fallback paths for other DSPy versions
                optimized_content = (
                    getattr(optimized_module, 'predictor', None) and
                    getattr(optimized_module.predictor, 'signature', None) and
                    optimized_module.predictor.signature.instructions
                ) or skill_content
            except Exception:
                optimized_content = skill_content
        
        return {
            "success": True,
            "optimizedContent": optimized_content,
            "baselineScore": round(avg_baseline, 4),
            "optimizedScore": round(avg_optimized, 4),
            "improvement": round(improvement, 4),
            "trainExamples": len(trainset),
            "valExamples": len(valset),
            "holdoutExamples": len(holdout),
            "optimizer": optimizer_name,
        }
        
    except Exception as e:
        # Return original content with error info
        return {
            "success": False,
            "optimizedContent": skill_content,
            "baselineScore": baseline_score,
            "optimizedScore": baseline_score,
            "improvement": 0.0,
            "trainExamples": 0,
            "valExamples": 0,
            "holdoutExamples": 0,
            "optimizer": "none",
            "error": f"Optimization failed: {str(e)}",
        }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    """Main entry point — handles CLI args or stdin input."""
    
    # Determine input source: CLI arg first, then stdin
    if len(sys.argv) > 1:
        try:
            request = json.loads(sys.argv[1])
        except json.JSONDecodeError as e:
            print(json.dumps({
                "success": False,
                "error": f"Invalid JSON argument: {e}",
            }))
            sys.exit(1)
    elif not sys.stdin.isatty():
        raw = sys.stdin.read()
        try:
            request = json.loads(raw) if raw.strip() else {}
        except json.JSONDecodeError as e:
            print(json.dumps({
                "success": False,
                "error": f"Invalid JSON on stdin: {e}",
            }))
            sys.exit(1)
    else:
        print(json.dumps({
            "success": False,
            "error": "No input: pass JSON as a command-line argument or via stdin",
        }))
        sys.exit(1)
    
    action = request.get("action", "")
    
    if action == "optimize_skill_primary":
        try:
            result = optimize_skill_primary(request)
            print(json.dumps(result))
            sys.exit(0 if result.get("success") else 1)
        except ImportError as e:
            print(json.dumps({
                "success": False,
                "error": str(e),
            }))
            sys.exit(1)
        except Exception as e:
            print(json.dumps({
                "success": False,
                "error": f"Unexpected error: {str(e)}",
            }))
            sys.exit(1)
    elif action == "optimize_skill":
        try:
            result = optimize_skill(request)
            print(json.dumps(result))
            sys.exit(0 if result.get("success") else 1)
        except ImportError as e:
            print(json.dumps({
                "success": False,
                "error": str(e),
            }))
            sys.exit(1)
        except Exception as e:
            print(json.dumps({
                "success": False,
                "error": f"Unexpected error: {str(e)}",
            }))
            sys.exit(1)
    else:
        print(json.dumps({
            "success": False,
            "error": f"Unknown action: {action}",
        }))
        sys.exit(1)


if __name__ == "__main__":
    main()
