export const CONTEXT_THREAT_PATTERNS: Array<[RegExp, string]> = [
  [/ignore\s+(previous|all|above|prior)\s+instructions/i, "prompt_injection"],
  [/do\s+not\s+tell\s+the\s+user/i, "deception_hide"],
  [/system\s+prompt\s+override/i, "sys_prompt_override"],
  [/disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, "disregard_rules"],
  [/act\s+as\s+(if|though)\s+you\s+(have\s+no|don't\s+have)\s+(restrictions|limits|rules)/i, "bypass_restrictions"],
  [/<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->/i, "html_comment_injection"],
  [/<\s*div\s+style\s*=\s*["'].*display\s*:\s*none/i, "hidden_div"],
  [/translate\s+.*\s+into\s+.*\s+and\s+(execute|run|eval)/i, "translate_execute"],
  [/curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, "exfil_curl"],
  [/cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass)/i, "read_secrets"],
];

export const CONTEXT_INVISIBLE_CHARS = new Set([
  '\u200b', '\u200c', '\u200d', '\u2060', '\ufeff',
  '\u202a', '\u202b', '\u202c', '\u202d', '\u202e',
]);

/**
 * Scan context file content for prompt injection and invisible unicode.
 * Returns sanitized content or a BLOCKED message string.
 * Identical logic to Hermes _scan_context_content().
 */
export function scanContextContent(content: string, filename: string): string {
  const findings: string[] = [];

  // Check invisible unicode
  CONTEXT_INVISIBLE_CHARS.forEach((char: string) => {
    if (content.includes(char)) {
      findings.push(`invisible unicode U+${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
    }
  });

  // Check threat patterns
  for (const [pattern, pid] of CONTEXT_THREAT_PATTERNS) {
    if (pattern.test(content)) {
      findings.push(pid);
    }
  }

  if (findings.length > 0) {
    return `[BLOCKED: ${filename} contained potential prompt injection (${findings.join(', ')}). Content not loaded.]`;
  }

  return content;
}
