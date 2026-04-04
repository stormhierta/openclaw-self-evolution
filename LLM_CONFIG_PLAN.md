# LLM Configuration Implementation Plan

## Overview

This plan describes how to add per-component LLM model configuration to the openclaw-self-evolution plugin. Currently, all LLM calls hardcode `MiniMax-M2.7` with `https://api.minimax.io` endpoint. The goal is to make this configurable per component.

---

## 1. New Config Structure

### 1.1 TypeScript Interfaces (add to `src/types.ts`)

```typescript
/**
 * LLM configuration for a single component.
 * All fields are optional; defaults maintain backward compatibility.
 */
export interface LlmConfig {
  /** Model name (default: "MiniMax-M2.7") */
  model?: string;
  /** API base URL (default: "https://api.minimax.io") */
  apiBase?: string;
  /** Environment variable name for API key (default: "MINIMAX_API_KEY") */
  apiKeyEnvVar?: string;
  /** Temperature for generation (default: component-specific) */
  temperature?: number;
  /** Max tokens for generation (default: component-specific) */
  maxTokens?: number;
}

/**
 * Per-component LLM configuration for the evolution pipeline.
 */
export interface EvolutionLlmConfig {
  /** LLM judge for fitness scoring (src/evolution/fitness/llm-judge.ts) */
  judge?: LlmConfig;
  /** Synthetic test case generator (src/dataset/synthetic-generator.ts) */
  generator?: LlmConfig;
  /** Trajectory outcome labeler (src/collection/outcome-labeler.ts) */
  labeler?: LlmConfig;
  /** Relevance filter for external importers (src/dataset/external-importers/relevance-filter.ts) */
  relevance?: LlmConfig;
  /** DSPy bridge configuration (python/dspy_bridge.py) */
  dspy?: LlmConfig;
}
```

### 1.2 Updated EvolutionConfig Interface (`src/types.ts`)

Add to the existing `EvolutionConfig` interface:

```typescript
/** Main plugin configuration interface */
export interface EvolutionConfig {
  enabled: boolean;
  trajectory: TrajectoryConfig;
  evolution: EvolutionEngineConfig;
  costLimits: CostLimits;
  sizeLimits?: SizeLimitsConfig;
  retentionDays: number;
  storage: StorageConfig;
  /** Per-component LLM configuration (optional, defaults to MiniMax-M2.7) */
  llm?: EvolutionLlmConfig;
}
```

---

## 2. Files to Change

### 2.1 `src/evolution/fitness/llm-judge.ts`

**Current hardcoded values:**
- Model: `"MiniMax-M2.7"`
- API base: `"https://api.minimax.io"`
- API key env: `MINIMAX_API_KEY`
- Temperature: `0.1`
- Max tokens: `1000`

**Changes needed:**

1. **Constructor modification:** Accept optional `LlmConfig` for judge component
   ```typescript
   constructor(
     config: EvolutionConfig,
     rubricRegistry: RubricRegistry,
     llmConfig?: LlmConfig
   ) {
     this.config = config;
     this.rubricRegistry = rubricRegistry;
     
     // Use provided config or fall back to defaults
     this.model = llmConfig?.model ?? "MiniMax-M2.7";
     this.apiBaseUrl = llmConfig?.apiBase ?? "https://api.minimax.io";
     this.apiKeyEnvVar = llmConfig?.apiKeyEnvVar ?? "MINIMAX_API_KEY";
     this.temperature = llmConfig?.temperature ?? 0.1;
     this.maxTokens = llmConfig?.maxTokens ?? 1000;
     
     this.apiKey = process.env[this.apiKeyEnvVar] ?? "";
   }
   ```

2. **Add private fields:**
   ```typescript
   private model: string;
   private apiKeyEnvVar: string;
   private temperature: number;
   private maxTokens: number;
   ```

3. **Update `callMiniMax()` method:** Use instance variables instead of hardcoded values

4. **Instantiation location:** Find where `LlmJudge` is instantiated (likely in `src/evolution/` index or orchestrator) and pass `config.llm?.judge`

### 2.2 `src/dataset/synthetic-generator.ts`

**Current hardcoded values:**
- Model: `"MiniMax-M2.7"`
- API base: `"https://api.minimax.io"`
- API key env: `MINIMAX_API_KEY`
- Temperature: `0.7`
- Max tokens: `4000`

**Changes needed:**

1. **Constructor modification:**
   ```typescript
   constructor(config: EvolutionConfig, llmConfig?: LlmConfig) {
     this.config = config;
     
     this.model = llmConfig?.model ?? "MiniMax-M2.7";
     this.apiBaseUrl = llmConfig?.apiBase ?? "https://api.minimax.io";
     this.apiKeyEnvVar = llmConfig?.apiKeyEnvVar ?? "MINIMAX_API_KEY";
     this.temperature = llmConfig?.temperature ?? 0.7;
     this.maxTokens = llmConfig?.maxTokens ?? 4000;
     
     this.apiKey = process.env[this.apiKeyEnvVar] ?? "";
   }
   ```

2. **Add private fields** matching the config values

3. **Update `callMiniMax()` method:** Use instance variables

4. **Instantiation location:** Pass `config.llm?.generator` where `SyntheticGenerator` is instantiated

### 2.3 `src/collection/trajectory-logger.ts`

**Current hardcoded values:**
- Model: `"MiniMax-M2.7"`
- API base: `"https://api.minimax.io"`
- API key env: `MINIMAX_API_KEY`
- Temperature: `0.1`
- Max tokens: `500`

**Note:** The `evaluateOutcome` method uses LLM calls. This is related to labeling functionality.

**Changes needed:**

1. **Constructor modification:**
   ```typescript
   constructor(
     config: EvolutionConfig,
     handler: TrajectoryHookHandler,
     outcomeLabeler?: OutcomeLabeler,
     llmConfig?: LlmConfig
   ) {
     // ... existing code ...
     this.model = llmConfig?.model ?? "MiniMax-M2.7";
     this.apiBaseUrl = llmConfig?.apiBase ?? "https://api.minimax.io";
     this.apiKeyEnvVar = llmConfig?.apiKeyEnvVar ?? "MINIMAX_API_KEY";
     this.temperature = llmConfig?.temperature ?? 0.1;
     this.maxTokens = llmConfig?.maxTokens ?? 500;
     
     this.apiKey = process.env[this.apiKeyEnvVar] ?? "";
   }
   ```

2. **Add private fields** for config values

3. **Update `callMiniMax()` method:** Use instance variables

**Alternative approach:** Since `TrajectoryLogger` has an `OutcomeLabeler` dependency and the `evaluateOutcome` method is essentially labeling logic, consider delegating to `OutcomeLabeler` entirely. However, for minimal changes, pass the same `llmConfig` to both.

### 2.4 `src/collection/outcome-labeler.ts`

**Current hardcoded values:**
- Model: `"MiniMax-M2.7"`
- API base: `"https://api.minimax.io"`
- API key env: `MINIMAX_API_KEY`
- Temperature: `0.1`
- Max tokens: `500`

**Changes needed:**

1. **Constructor modification:**
   ```typescript
   constructor(
     config: EvolutionConfig,
     sharedDb?: Database.Database,
     llmConfig?: LlmConfig
   ) {
     // ... existing code ...
     this.model = llmConfig?.model ?? "MiniMax-M2.7";
     this.apiBaseUrl = llmConfig?.apiBase ?? "https://api.minimax.io";
     this.apiKeyEnvVar = llmConfig?.apiKeyEnvVar ?? "MINIMAX_API_KEY";
     this.temperature = llmConfig?.temperature ?? 0.1;
     this.maxTokens = llmConfig?.maxTokens ?? 500;
     
     this.apiKey = process.env[this.apiKeyEnvVar] ?? "";
   }
   ```

2. **Add private fields** for config values

3. **Update `callMiniMax()` method:** Use instance variables

4. **Instantiation location:** Pass `config.llm?.labeler` where `OutcomeLabeler` is instantiated

### 2.5 `src/dataset/external-importers/relevance-filter.ts`

**Current hardcoded values:**
- Model: `"MiniMax-M2.7"`
- API base: `"https://api.minimax.io"`
- API key env: `MINIMAX_API_KEY`
- Temperature: `0.1`
- Max tokens: `500`

**Changes needed:**

1. **Constructor modification:**
   ```typescript
   constructor(config: EvolutionConfig, llmConfig?: LlmConfig) {
     this.config = config;
     
     this.model = llmConfig?.model ?? "MiniMax-M2.7";
     this.apiBaseUrl = llmConfig?.apiBase ?? "https://api.minimax.io";
     this.apiKeyEnvVar = llmConfig?.apiKeyEnvVar ?? "MINIMAX_API_KEY";
     this.temperature = llmConfig?.temperature ?? 0.1;
     this.maxTokens = llmConfig?.maxTokens ?? 500;
     
     this.apiKey = process.env[this.apiKeyEnvVar] ?? "";
   }
   ```

2. **Add private fields** for config values

3. **Update `callMiniMax()` method:** Use instance variables

4. **Instantiation location:** Pass `config.llm?.relevance` where `RelevanceFilter` is instantiated

### 2.6 `python/dspy_bridge.py`

**Current hardcoded values:**
- Model: `"MiniMax-M2.7"` (in `_build_lm` function)
- API base: `"https://api.minimax.io/v1"`
- API key env: `MINIMAX_API_KEY`

**Changes needed:**

The `_build_lm` function already accepts a `config` dict. Update it to use the nested `llm.dspy` config:

```python
def _build_lm(config: dict):
    """Build a DSPy LM wrapper for the MiniMax OpenAI-compatible endpoint."""
    dspy = _get_dspy()
    
    # Check for nested dspy LLM config first
    llm_config = config.get("llm", {}).get("dspy", {})
    
    model = llm_config.get("model", config.get("model", "MiniMax-M2.7"))
    api_key = llm_config.get("apiKey") or os.environ.get(
        llm_config.get("apiKeyEnvVar", "MINIMAX_API_KEY"),
        os.environ.get("MINIMAX_API_KEY", "")
    )
    api_base = llm_config.get("apiBase", config.get("apiBase", "https://api.minimax.io/v1"))
    
    if not api_key:
        raise ValueError("No API key provided: set config.llm.dspy.apiKey, config.llm.dspy.apiKeyEnvVar, or MINIMAX_API_KEY env var")
    
    return dspy.LM(
        model=f"openai/{model}",
        api_key=api_key,
        api_base=api_base,
        temperature=config.get("temperature", 0.7),
        max_tokens=config.get("maxTokens", 4096),
    )
```

**Note:** The Python side uses snake_case keys (`apiKey`, `apiBase`, `apiKeyEnvVar`) since it receives JSON from TypeScript.

---

## 3. Schema Changes

### 3.1 `src/types.ts` Additions

Add after the `StorageConfig` interface:

```typescript
/** LLM configuration for a single component */
export interface LlmConfig {
  model?: string;
  apiBase?: string;
  apiKeyEnvVar?: string;
  temperature?: number;
  maxTokens?: number;
}

/** Per-component LLM configuration */
export interface EvolutionLlmConfig {
  judge?: LlmConfig;
  generator?: LlmConfig;
  labeler?: LlmConfig;
  relevance?: LlmConfig;
  dspy?: LlmConfig;
}
```

Update `EvolutionConfig`:

```typescript
export interface EvolutionConfig {
  enabled: boolean;
  trajectory: TrajectoryConfig;
  evolution: EvolutionEngineConfig;
  costLimits: CostLimits;
  sizeLimits?: SizeLimitsConfig;
  retentionDays: number;
  storage: StorageConfig;
  llm?: EvolutionLlmConfig;  // <-- ADD THIS
}
```

### 3.2 `src/config.ts` Zod Schema Additions

Add after `StorageConfigSchema`:

```typescript
/**
 * LLM configuration schema for a single component
 */
export const LlmConfigSchema = z.object({
  model: z.string().optional(),
  apiBase: z.string().optional(),
  apiKeyEnvVar: z.string().optional(),
  temperature: z.number().optional(),
  maxTokens: z.number().int().optional(),
}).strict();

/**
 * Per-component LLM configuration schema
 */
export const EvolutionLlmConfigSchema = z.object({
  judge: LlmConfigSchema.optional(),
  generator: LlmConfigSchema.optional(),
  labeler: LlmConfigSchema.optional(),
  relevance: LlmConfigSchema.optional(),
  dspy: LlmConfigSchema.optional(),
}).strict();
```

Update `EvolutionConfigSchema`:

```typescript
export const EvolutionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  trajectory: TrajectoryConfigSchema.default({}),
  evolution: EvolutionEngineConfigSchema.default({}),
  costLimits: CostLimitsSchema.default({}),
  sizeLimits: SizeLimitsSchema.optional(),
  retentionDays: z.number().int().min(1).default(90),
  storage: StorageConfigSchema.default({}),
  llm: EvolutionLlmConfigSchema.optional(),  // <-- ADD THIS
}).strict();
```

Add inferred types:

```typescript
export type ParsedLlmConfig = z.infer<typeof LlmConfigSchema>;
export type ParsedEvolutionLlmConfig = z.infer<typeof EvolutionLlmConfigSchema>;
```

### 3.3 `openclaw.plugin.json` Schema Updates

Add to the `configSchema.properties`:

```json
{
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      // ... existing properties ...
      "llm": {
        "type": "object",
        "description": "Per-component LLM configuration",
        "additionalProperties": false,
        "properties": {
          "judge": {
            "$ref": "#/configSchema/definitions/llmConfig",
            "description": "LLM configuration for fitness scoring (llm-judge.ts)"
          },
          "generator": {
            "$ref": "#/configSchema/definitions/llmConfig",
            "description": "LLM configuration for synthetic test case generation"
          },
          "labeler": {
            "$ref": "#/configSchema/definitions/llmConfig",
            "description": "LLM configuration for trajectory outcome labeling"
          },
          "relevance": {
            "$ref": "#/configSchema/definitions/llmConfig",
            "description": "LLM configuration for relevance filtering in importers"
          },
          "dspy": {
            "$ref": "#/configSchema/definitions/llmConfig",
            "description": "LLM configuration for DSPy bridge"
          }
        }
      }
    },
    "definitions": {
      "llmConfig": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "model": {
            "type": "string",
            "description": "Model name (default: MiniMax-M2.7)",
            "default": "MiniMax-M2.7"
          },
          "apiBase": {
            "type": "string",
            "description": "API base URL (default: https://api.minimax.io)",
            "default": "https://api.minimax.io"
          },
          "apiKeyEnvVar": {
            "type": "string",
            "description": "Environment variable name for API key (default: MINIMAX_API_KEY)",
            "default": "MINIMAX_API_KEY"
          },
          "temperature": {
            "type": "number",
            "description": "Temperature for generation",
            "minimum": 0,
            "maximum": 2
          },
          "maxTokens": {
            "type": "integer",
            "description": "Maximum tokens to generate",
            "minimum": 1
          }
        }
      }
    }
  }
}
```

**Note:** JSON Schema doesn't support `$ref` to external definitions in all contexts. Inline the definition or use a proper JSON Schema structure.

---

## 4. Backward Compatibility

### 4.1 Default Behavior

When no `llm` config is provided:
- All components use `MiniMax-M2.7`
- All components use `https://api.minimax.io`
- All components use `MINIMAX_API_KEY` environment variable
- Temperature and maxTokens use component-specific defaults

### 4.2 Partial Configuration

Users can configure only specific components:

```typescript
// Only configure the judge, others use defaults
{
  llm: {
    judge: { model: "gpt-4o", apiBase: "https://api.openai.com/v1" }
  }
}
```

### 4.3 Environment Variable Fallback

Each component defaults to `MINIMAX_API_KEY` if `apiKeyEnvVar` is not specified:

```typescript
this.apiKeyEnvVar = llmConfig?.apiKeyEnvVar ?? "MINIMAX_API_KEY";
this.apiKey = process.env[this.apiKeyEnvVar] ?? "";
```

---

## 5. Implementation Order

### Phase 1: Core Types and Schema (Foundation)
1. **Add types to `src/types.ts`**
   - Add `LlmConfig` interface
   - Add `EvolutionLlmConfig` interface
   - Update `EvolutionConfig` interface

2. **Add schemas to `src/config.ts`**
   - Add `LlmConfigSchema`
   - Add `EvolutionLlmConfigSchema`
   - Update `EvolutionConfigSchema`

3. **Update `openclaw.plugin.json`**
   - Add LLM config schema definitions

### Phase 2: TypeScript Components (Bottom-up)
4. **`src/dataset/synthetic-generator.ts`**
   - Independent component, no dependencies
   - Good first test case

5. **`src/dataset/external-importers/relevance-filter.ts`**
   - Independent component
   - Test with importer workflows

6. **`src/collection/outcome-labeler.ts`**
   - Required by TrajectoryLogger
   - Update before TrajectoryLogger

7. **`src/collection/trajectory-logger.ts`**
   - Depends on OutcomeLabeler
   - Pass same `llm?.labeler` config to both

8. **`src/evolution/fitness/llm-judge.ts`**
   - Core evolution component
   - Update after other components are working

### Phase 3: Python Bridge
9. **`python/dspy_bridge.py`**
   - Update `_build_lm` to read nested `llm.dspy` config
   - Test with DSPy optimization workflows

### Phase 4: Integration and Testing
10. **Update instantiation sites**
    - Find all locations where these classes are instantiated
    - Pass the appropriate `config.llm?.<component>` config

11. **Add unit tests**
    - Test default behavior (no config)
    - Test partial config
    - Test full custom config
    - Test environment variable resolution

---

## 6. Example Configurations

### 6.1 Use Gemini for Judging, GPT-4 for Generation

```json
{
  "enabled": true,
  "llm": {
    "judge": {
      "model": "gemini-2.0-flash",
      "apiBase": "https://generativelanguage.googleapis.com/v1beta",
      "apiKeyEnvVar": "GEMINI_API_KEY",
      "temperature": 0.1,
      "maxTokens": 1000
    },
    "generator": {
      "model": "gpt-4o",
      "apiBase": "https://api.openai.com/v1",
      "apiKeyEnvVar": "OPENAI_API_KEY",
      "temperature": 0.7,
      "maxTokens": 4000
    }
  },
  "evolution": {
    "autoRun": true,
    "maxGenerations": 10
  }
}
```

### 6.2 Use OpenRouter for All Components

```json
{
  "enabled": true,
  "llm": {
    "judge": {
      "model": "openai/gpt-4o-mini",
      "apiBase": "https://openrouter.ai/api/v1",
      "apiKeyEnvVar": "OPENROUTER_API_KEY",
      "temperature": 0.1
    },
    "generator": {
      "model": "anthropic/claude-3.5-sonnet",
      "apiBase": "https://openrouter.ai/api/v1",
      "apiKeyEnvVar": "OPENROUTER_API_KEY",
      "temperature": 0.7
    },
    "labeler": {
      "model": "openai/gpt-4o-mini",
      "apiBase": "https://openrouter.ai/api/v1",
      "apiKeyEnvVar": "OPENROUTER_API_KEY",
      "temperature": 0.1
    },
    "relevance": {
      "model": "openai/gpt-4o-mini",
      "apiBase": "https://openrouter.ai/api/v1",
      "apiKeyEnvVar": "OPENROUTER_API_KEY",
      "temperature": 0.1
    },
    "dspy": {
      "model": "anthropic/claude-3.5-sonnet",
      "apiBase": "https://openrouter.ai/api/v1",
      "apiKeyEnvVar": "OPENROUTER_API_KEY"
    }
  }
}
```

### 6.3 Keep MiniMax Defaults (Backward Compatible)

```json
{
  "enabled": true,
  "evolution": {
    "autoRun": true
  }
}
```

No `llm` key needed — all components use MiniMax defaults.

### 6.4 Override Only Temperature

```json
{
  "enabled": true,
  "llm": {
    "generator": {
      "temperature": 0.9
    }
  }
}
```

Only the generator uses temperature 0.9; everything else uses MiniMax defaults.

---

## 7. Component-Specific Defaults Reference

| Component | Default Model | Default API Base | Default Temp | Default Max Tokens |
|-----------|--------------|------------------|--------------|-------------------|
| judge | MiniMax-M2.7 | https://api.minimax.io | 0.1 | 1000 |
| generator | MiniMax-M2.7 | https://api.minimax.io | 0.7 | 4000 |
| labeler | MiniMax-M2.7 | https://api.minimax.io | 0.1 | 500 |
| relevance | MiniMax-M2.7 | https://api.minimax.io | 0.1 | 500 |
| dspy | MiniMax-M2.7 | https://api.minimax.io/v1 | 0.7 | 4096 |

---

## 8. Testing Checklist

- [ ] Default config (no `llm` key) works exactly as before
- [ ] Partial config (only some components) uses defaults for unspecified components
- [ ] Full custom config for all components works
- [ ] Custom `apiKeyEnvVar` is respected
- [ ] Custom `temperature` and `maxTokens` are applied
- [ ] DSPy bridge receives nested config correctly
- [ ] Error handling when env var is missing
- [ ] JSON Schema validation passes for all example configs

---

## 9. Migration Guide for Users

### Before (current hardcoded):
```bash
export MINIMAX_API_KEY="your-key"
```

Config file: No changes needed, works as before.

### After (custom models):
```bash
export GEMINI_API_KEY="your-gemini-key"
export OPENAI_API_KEY="your-openai-key"
```

Config file:
```json
{
  "llm": {
    "judge": {
      "model": "gemini-2.0-flash",
      "apiBase": "https://generativelanguage.googleapis.com/v1beta",
      "apiKeyEnvVar": "GEMINI_API_KEY"
    },
    "generator": {
      "model": "gpt-4o",
      "apiKeyEnvVar": "OPENAI_API_KEY"
    }
  }
}
```

---

## Summary

This plan adds a nested `llm` configuration object to the evolution plugin config, allowing per-component LLM model selection while maintaining full backward compatibility. The implementation follows a bottom-up approach: types → schemas → independent components → dependent components → Python bridge → integration.
