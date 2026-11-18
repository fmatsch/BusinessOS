import Anthropic from "@anthropic-ai/sdk";
import type { AiInput, AiProvider, AiSession, AiTurn, ToolSpec } from "./provider";

type Message = Anthropic.Beta.BetaMessageParam;

export const DEFAULT_MODEL = "claude-opus-5-5";

/** Anthropic-Claude-Anbieter. Der API-Schlüssel bleibt serverseitig (nie NEXT_PUBLIC_). */
export class AnthropicProvider implements AiProvider {
  readonly name = "anthropic";
  private readonly client: Anthropic;

  constructor(opts: { apiKey: string; model?: string; client?: Anthropic }) {
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey });
    this.model = opts.model ?? DEFAULT_MODEL;
  }
  private readonly model: string;

  startSession({ system, tools }: { system: string; tools: ToolSpec[] }): AiSession {
    const messages: Message[] = [];
    const client = this.client;
    const model = this.model;
    const apiTools = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Beta.BetaTool["input_schema"],
    }));

    return {
      async step(input: AiInput): Promise<AiTurn> {
        if (input.type === "user") {
          messages.push({ role: "user", content: input.text });
        } else {
          messages.push({
            role: "user",
            content: input.results.map((r) => ({
              type: "tool_result" as const,
              tool_use_id: r.id,
              content: r.content,
              is_error: r.isError,
            })),
          });
        }

        const response = await client.beta.messages.create({
          model,
          max_tokens: 4096,
          system,
          tools: apiTools,
          messages,
          // Bei einer Sicherheitsablehnung wiederholt die API die Anfrage serverseitig auf dem Ausweichmodell
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        });

        // Verlauf unverändert (inkl. Thinking-Blöcke) zurückgeben – nötig für korrekte Werkzeugschleifen
        messages.push({ role: "assistant", content: response.content });

        const text = response.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n")
          .trim();
        const toolCalls = response.content
          .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
          .map((b) => ({ id: b.id, name: b.name, input: b.input }));

        return {
          text,
          toolCalls,
          done: response.stop_reason !== "tool_use",
          refused: response.stop_reason === "refusal",
          truncated: response.stop_reason === "max_tokens",
        };
      },
    };
  }
}
