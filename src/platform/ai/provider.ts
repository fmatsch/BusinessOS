/** Anbieterunabhängige KI-Schnittstelle. Konkrete Anbieter (z. B. Anthropic) implementieren sie. */

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema der Eingabe */
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResult {
  id: string;
  content: string;
  isError: boolean;
}

export interface AiTurn {
  text: string;
  toolCalls: ToolCall[];
  /** true, wenn das Modell fertig ist (keine weiteren Werkzeugaufrufe) */
  done: boolean;
  /** Das Modell hat die Antwort aus Sicherheitsgründen verweigert */
  refused: boolean;
  /** Antwort wurde abgeschnitten (Token-Limit) */
  truncated: boolean;
}

export type AiInput = { type: "user"; text: string } | { type: "tool_results"; results: ToolResult[] };

/** Eine Unterhaltung mit eigenem Verlauf. Der Anbieter verwaltet den nativen Nachrichtenverlauf selbst. */
export interface AiSession {
  step(input: AiInput): Promise<AiTurn>;
}

export interface AiProvider {
  readonly name: string;
  startSession(opts: { system: string; tools: ToolSpec[] }): AiSession;
}
