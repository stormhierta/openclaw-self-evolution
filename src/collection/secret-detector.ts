/**
 * Secret detection patterns for filtering sensitive data from trajectories.
 * 
 * Modeled on Hermes: reference/hermes-agent-self-evolution/evolution/core/external_importers.py
 * Patterns detect API keys, tokens, and other sensitive credentials.
 */

/**
 * Regex patterns that detect secrets in text.
 * Each pattern is anchored to known key formats to minimize false positives.
 */
export const SECRET_PATTERNS: RegExp[] = [
  // Anthropic API keys (sk-ant-api08... format and sk-ant-... format)
  /sk-ant-api\S+/,
  /sk-ant-[a-zA-Z0-9\-_]{20,}/,
  // OpenAI API keys
  /sk-[a-zA-Z0-9]{20,}/,
  // OpenRouter keys
  /sk-or-[a-zA-Z0-9\-_]{20,}/,
  // GitHub tokens
  /gh[ps]_[a-zA-Z0-9]{36,}/,
  /ghu_\S+/,
  // Slack tokens
  /xox[baprs]-[a-zA-Z0-9\-]+/,
  /xapp-\S+/,
  // AWS access keys
  /AKIA[A-Z0-9]{16}/,
  // Notion tokens
  /ntn_\S+/,
  // PEM private keys
  /-----BEGIN (RSA |EC )?PRIVATE KEY-----/,
  // Password/secret/token/api_key assignments
  /(password|secret|token|api_key)\s*[=:]\s*["']?\S{8,}/i,
  // Bearer auth headers
  /Bearer\s+\S{20,}/,
  // Literal env-var name matches (case-sensitive)
  /\bANTHROPIC_API_KEY\b/,
  /\bOPENAI_API_KEY\b/,
  /\bOPENROUTER_API_KEY\b/,
  /\bSLACK_BOT_TOKEN\b/,
  /\bGITHUB_TOKEN\b/,
  /\bAWS_SECRET_ACCESS_KEY\b/,
  /\bDATABASE_URL\b/,
];

/**
 * Check if text contains potential secrets.
 * 
 * @param text - The text to check
 * @returns True if any secret pattern matches
 */
export function containsSecret(text: string): boolean {
  if (!text || typeof text !== "string") {
    return false;
  }
  return SECRET_PATTERNS.some(pattern => pattern.test(text));
}

/**
 * Check multiple text fields for secrets.
 * 
 * @param fields - Array of text fields to check
 * @returns True if any field contains a secret
 */
export function containsSecretInAny(...fields: (string | undefined | null)[]): boolean {
  for (const field of fields) {
    if (field && containsSecret(field)) {
      return true;
    }
  }
  return false;
}
