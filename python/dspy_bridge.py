#!/usr/bin/env python3
"""
DSPy Bridge — OpenClaw Self-Evolution Pipeline
Phase T4.1

A subprocess bridge between the TypeScript evolution pipeline and DSPy.
Invoked by src/evolution/gepa/evolver.ts.

Usage:
    echo '{...}' | python dspy_bridge.py
    python dspy_bridge.py '{...}'
"""

import json
import sys
import os
import textwrap
from typing import Any


# ---------------------------------------------------------------------------
# Lazy DSPy imports — fail gracefully if deps are missing
# ---------------------------------------------------------------------------

def _get_dspy():
    """Import and return the dspy module, raising if unavailable."""
    try:
        import dspy
        return dspy
    except ImportError as e:
        raise ImportError(
            f"DSPy not installed. Run: pip install -r python/requirements.txt. "
            f"Import error: {e}"
        )


# ---------------------------------------------------------------------------
# Internal helpers (no DSPy at module load time)
# ---------------------------------------------------------------------------

def _build_lm(config: dict):
    """Build a DSPy LM wrapper for the MiniMax OpenAI-compatible endpoint."""
    dspy = _get_dspy()

    model = config.get("model", "MiniMax-M2.7")
    api_key = config.get("apiKey", os.environ.get("MINIMAX_API_KEY", ""))
    api_base = config.get("apiBase", "https://api.minimax.io/v1")

    if not api_key:
        raise ValueError("No API key provided: set config.apiKey or MINIMAX_API_KEY env var")

    return dspy.LM(
        f"openai/{model}",
        api_key=api_key,
        api_base=api_base,
        temperature=config.get("temperature", 0.7),
        max_tokens=config.get("maxTokens", 4096),
    )


def _llm_judge_score(optimized: str, rubric: dict, lm) -> float:
    """Use the LLM as a judge to score the optimized skill against the rubric."""
    rubric_str = json.dumps(rubric, indent=2)

    judge_prompt = textwrap.dedent(f"""\
        You are an impartial judge evaluating a skill SKILL.md after optimization.

        RUBRIC (criteria weights):
        {rubric_str}

        OPTIMIZED SKILL CONTENT:
        {optimized}

        Evaluate the optimized skill against the rubric.
        Return ONLY a valid JSON object with:
        {{
          "score": a float between 0.0 and 1.0,
          "reason": a brief explanation
        }}
        Do not include any text outside the JSON object.
    """)

    response = lm(judge_prompt)
    raw = response[0] if isinstance(response, (list, tuple)) else str(response)

    try:
        json_start = raw.find("{")
        json_end = raw.rfind("}") + 1
        if json_start != -1 and json_end > json_start:
            judge_data = json.loads(raw[json_start:json_end])
            return float(judge_data.get("score", 0.5))
    except (json.JSONDecodeError, ValueError, TypeError):
        pass

    return 0.5


def _detect_improvements(orig: str, optimized: str) -> list[str]:
    """Heuristically describe what changed between original and optimized."""
    improvements: list[str] = []

    orig_lines = set(l.strip() for l in orig.splitlines() if l.strip())
    opt_lines = set(l.strip() for l in optimized.splitlines() if l.strip())

    added = opt_lines - orig_lines
    removed = orig_lines - opt_lines

    if added:
        improvements.append(f"{len(added)} lines added or modified")
    if removed:
        improvements.append(f"{len(removed)} lines removed or replaced")

    # Content length signals
    delta = len(optimized) - len(orig)
    if delta > 200:
        improvements.append("Expanded skill with additional content")
    elif delta < -200:
        improvements.append("Streamlined skill — removed verbosity")
    elif abs(delta) <= 50:
        improvements.append("Refined wording with minimal length change")

    return improvements


def _run_optimization_iteration(
    skill_content: str,
    test_cases: list,
    rubric: dict,
    lm,
) -> tuple[str, float, list[str]]:
    """
    Single DSPy-backed optimization iteration.
    Returns (optimized_content, score, improvements).
    """
    dspy = _get_dspy()

    # Build the DSPy module inside the iteration to avoid top-level dspy references
    class SkillOptimizer(dspy.Module):
        def __init__(inner_self):
            super().__init__()
            inner_self.rewrite = dspy.ChainOfThought(
                "skill_content, test_cases, rubric -> optimized_skill"
            )

        def forward(inner_self, skill_content: str, test_cases: list, rubric: dict):
            test_str = json.dumps(test_cases, indent=2)
            rubric_str = json.dumps(rubric, indent=2)
            return inner_self.rewrite(
                skill_content=skill_content,
                test_cases=test_str,
                rubric=rubric_str,
            )

    optimizer = SkillOptimizer()

    with dspy.context(lm=lm):
        pred = optimizer(
            skill_content=skill_content,
            test_cases=test_cases,
            rubric=rubric,
        )

    optimized = pred.optimized_skill.strip()
    improvements = _detect_improvements(skill_content, optimized)
    score = _llm_judge_score(optimized, rubric, lm)

    return optimized, score, improvements


def optimize_skill(request: dict) -> dict:
    """
    Main optimization entry point.
    Wraps skill in DSPy, runs iterative optimization against test cases + rubric,
    returns improved content + score.
    """
    dspy = _get_dspy()

    skill_content = request["skillContent"]
    test_cases = request.get("testCases", [])
    rubric = request.get("rubric", {})
    baseline_score = float(request.get("baselineScore", 0.5))
    config = request.get("config", {})

    max_iterations = int(config.get("maxIterations", 10))

    lm = _build_lm(config)
    dspy.configure(lm=lm)

    current_content = skill_content
    best_content = skill_content
    best_score = baseline_score
    iterations = 0
    all_improvements: list[str] = []
    plateau_count = 0

    for i in range(max_iterations):
        iterations = i + 1

        optimized, score, improvements = _run_optimization_iteration(
            current_content, test_cases, rubric, lm
        )

        # Merge new improvements
        for imp in improvements:
            if imp not in all_improvements:
                all_improvements.append(imp)

        # Update best if improved
        if score > best_score:
            best_score = score
            best_content = optimized
            plateau_count = 0
        else:
            plateau_count += 1

        # Early exit conditions
        if plateau_count >= 3:
            all_improvements.append(f"Plateau detected at iteration {i + 1}, stopping early")
            break
        if score >= 0.98:
            all_improvements.append("Score reached near-perfect threshold (0.98)")
            break

        # Prepare next iteration's input: use the latest optimized version
        current_content = optimized

    return {
        "success": True,
        "optimizedContent": best_content,
        "score": round(best_score, 4),
        "iterations": iterations,
        "improvements": all_improvements[:10],
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    # Determine input source: CLI arg first, then stdin
    if len(sys.argv) > 1:
        try:
            request = json.loads(sys.argv[1])
        except json.JSONDecodeError as e:
            print(json.dumps({"success": False, "error": f"Invalid JSON argument: {e}"}))
            sys.exit(1)
    elif not sys.stdin.isatty():
        raw = sys.stdin.read()
        try:
            request = json.loads(raw) if raw.strip() else {}
        except json.JSONDecodeError as e:
            print(json.dumps({"success": False, "error": f"Invalid JSON on stdin: {e}"}))
            sys.exit(1)
    else:
        print(json.dumps({
            "success": False,
            "error": "No input: pass JSON as a command-line argument or via stdin"
        }))
        sys.exit(1)

    action = request.get("action", "")

    if action == "optimize_skill":
        try:
            result = optimize_skill(request)
            print(json.dumps(result))
            sys.exit(0)
        except ImportError as e:
            print(json.dumps({"success": False, "error": str(e)}))
            sys.exit(1)
        except Exception as e:
            print(json.dumps({"success": False, "error": str(e)}))
            sys.exit(1)
    else:
        print(json.dumps({"success": False, "error": f"Unknown action: {action}"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
