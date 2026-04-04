# OpenClaw Self-Evolution — Examples

This directory contains example skills, configs, and scripts to help you understand and use the openclaw-self-evolution plugin.

## Contents

### `skills/`
Example **evolved** skills demonstrating what the evolution pipeline can produce.

- **`weather-evolved/SKILL.md`** — An evolved version of the weather skill with improved tool instructions, edge case handling, and better-structured examples.
- **`web-search-evolved/SKILL.md`** — An evolved web search skill with clearer directives and more robust query construction.

These are realistic, usable skills that show the kinds of improvements the evolution pipeline targets: better examples, clearer edge case handling, more specific tool usage instructions, and stricter adherence to the SKILL.md format.

### `config/`
Example configuration files for the evolution pipeline.

- **`evolution-config-example.jsonc`** — A complete configuration showing all available options with comments explaining each section. Use this as a reference when configuring the plugin.
- **`minimal-config.jsonc`** — A minimal working configuration with only the essential options set. Good for getting started quickly.

### `scripts/`
Shell scripts for common evolution tasks.

- **`run-evolution.sh`** — Example script showing how to trigger an evolution run for a specific skill.

## Quick Start

1. Copy `examples/config/minimal-config.jsonc` to your plugin config location (e.g., `~/.openclaw/plugins/openclaw-self-evolution/config.json`)
2. Review `examples/config/evolution-config-example.jsonc` to understand all available options
3. Run an evolution: `bash examples/scripts/run-evolution.sh weather`

## Key Concepts

- **Skill Variants** — Each evolution run produces multiple variants (mutations) of a skill, scored by a fitness function
- **Trajectory Logging** — The pipeline logs agent session trajectories to build training datasets
- **Fitness Scoring** — Variants are evaluated on correctness, format adherence, efficiency, robustness, and clarity
- **Git Integration** — Successful variants can be committed to a branch and opened as a PR for review
