/**
 * Barrel exports for external importers module.
 * 
 * External session importers for Claude Code, Copilot, and OpenClaw sessions.
 * Includes secret detection and two-stage relevance filtering.
 */

// Base types
export { ParsedSession, ExternalImporter } from './base.js';

// Secret detection
export { SecretDetector } from './secret-detector.js';

// Importers
export { ClaudeCodeImporter } from './claude-code.js';
export { CopilotImporter } from './copilot.js';
export { OpenClawImporter } from './openclaw.js';

// Relevance filtering
export { RelevanceFilter, RelevanceScore } from './relevance-filter.js';

// Orchestrator
export { ExternalSessionImporter, ImportSource } from './orchestrator.js';
