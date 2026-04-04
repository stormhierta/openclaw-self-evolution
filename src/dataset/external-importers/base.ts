export interface ParsedSession {
  source: 'claude-code' | 'copilot' | 'openclaw';
  taskInput: string;
  assistantResponse?: string;
  project?: string;
  sessionId: string;
  timestamp: string;
}

export abstract class ExternalImporter {
  abstract readonly sourceName: string;
  abstract extractMessages(limit?: number): Promise<ParsedSession[]>;
}
