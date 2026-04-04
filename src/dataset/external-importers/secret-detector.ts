/**
 * Secret detection and redaction for session data.
 * 
 * Ported from Hermes reference: evolution/core/external_importers.py
 * Lines 45-66: SECRET_PATTERNS regex compilation
 */
export class SecretDetector {
  // Regex patterns that indicate secrets — NEVER include these in datasets.
  // Each pattern is intentionally anchored to known key formats to minimize
  // false positives on normal prose.
  private static readonly PATTERNS: RegExp[] = [
    /sk-ant-api\S+/gi,              // Anthropic API keys
    /sk-or-v1-\S+/gi,               // OpenRouter API keys
    /sk-\S{20,}/gi,                 // Generic OpenAI-style keys (20+ chars after sk-)
    /ghp_\S+/gi,                    // GitHub personal access tokens
    /ghu_\S+/gi,                    // GitHub user tokens
    /xoxb-\S+/gi,                   // Slack bot tokens
    /xapp-\S+/gi,                   // Slack app tokens
    /ntn_\S+/gi,                    // Notion integration tokens
    /AKIA[0-9A-Z]{16}/g,            // AWS access key IDs
    /Bearer\s+\S{20,}/gi,           // Bearer auth headers (20+ char tokens)
    /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,  // PEM private keys
    /ANTHROPIC_API_KEY/gi,          // Known env var names (exact match)
    /OPENAI_API_KEY/gi,
    /OPENROUTER_API_KEY/gi,
    /SLACK_BOT_TOKEN/gi,
    /GITHUB_TOKEN/gi,
    /AWS_SECRET_ACCESS_KEY/gi,
    /DATABASE_URL/gi,
    /\bpassword\s*[=:]\s*\S+/gi,    // password assignments (password=xxx, password: xxx)
    /\bsecret\s*[=:]\s*\S+/gi,      // secret assignments (secret=xxx, secret: xxx)
    /\btoken\s*[=:]\s*\S{10,}/gi,   // token assignments with 10+ char values
  ];

  /**
   * Check if text contains potential API keys or tokens.
   * Matches Hermes _contains_secret() function.
   */
  static containsSecret(text: string): boolean {
    if (!text) return false;
    return this.PATTERNS.some(pattern => {
      pattern.lastIndex = 0;
      return pattern.test(text);
    });
  }

  /**
   * Redact secrets from text by replacing them with [REDACTED].
   * Preserves the structure of the text while removing sensitive data.
   */
  static redact(text: string): string {
    if (!text) return text;
    
    let redacted = text;
    for (const pattern of this.PATTERNS) {
      redacted = redacted.replace(pattern, '[REDACTED]');
    }
    return redacted;
  }
}
