import { describe, expect, it } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicProvider, DEFAULT_MODEL } from "./anthropic";

/** Prüft nur Anfrageform und Antwortabbildung gegen eine Attrappe – kein echter API-Aufruf. */
function stubClient(responses: unknown[]) {
  const calls: Record<string, any>[] = [];
  let i = 0;
  const client = {
    beta: { messages: { create: async (req: Record<string, any>) => { calls.push(structuredClone(req)); return responses[i++]; } } },
  } as unknown as Anthropic;
  return { client, calls };
}

describe("AnthropicProvider", () => {
  it("sendet Werkzeuge, Standardmodell und Fallback-Parameter; bildet Werkzeugaufrufe ab", async () => {
    const { client, calls } = stubClient([
      {
        stop_reason: "tool_use",
        content: [
          { type: "thinking", thinking: "", signature: "sig" },
          { type: "text", text: "Ich prüfe das." },
          { type: "tool_use", id: "tu_1", name: "budget_overview", input: { year: 2026 } },
        ],
      },
      { stop_reason: "end_turn", content: [{ type: "text", text: "Fertig." }] },
    ]);
    const session = new AnthropicProvider({ apiKey: "x", client }).startSession({
      system: "SYS",
      tools: [{ name: "budget_overview", description: "d", inputSchema: { type: "object", properties: {} } }],
    });

    const t1 = await session.step({ type: "user", text: "Frage" });
    expect(t1.done).toBe(false);
    expect(t1.toolCalls).toEqual([{ id: "tu_1", name: "budget_overview", input: { year: 2026 } }]);

    const t2 = await session.step({ type: "tool_results", results: [{ id: "tu_1", content: "<untrusted_data>{}</untrusted_data>", isError: false }] });
    expect(t2).toMatchObject({ done: true, text: "Fertig.", refused: false });

    expect(calls[0]).toMatchObject({ model: DEFAULT_MODEL, system: "SYS", fallbacks: "default", betas: ["server-side-fallback-2026-07-01"] });
    expect(calls[0]!.tools[0].input_schema.type).toBe("object");
    expect(calls[0]!.tool_choice).toBeUndefined(); // erzwungene Werkzeugwahl wird vom Modell nicht unterstützt
    // Zweite Anfrage: Verlauf enthält die unveränderten Assistenten-Blöcke inkl. Thinking und das Werkzeugergebnis
    const msgs = calls[1]!.messages;
    expect(msgs[1].content[0].type).toBe("thinking");
    expect(msgs[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "tu_1", is_error: false });
  });

  it("erkennt Ablehnung und Abschneiden", async () => {
    const { client } = stubClient([
      { stop_reason: "refusal", content: [] },
      { stop_reason: "max_tokens", content: [{ type: "text", text: "halb" }] },
    ]);
    const s = new AnthropicProvider({ apiKey: "x", client, model: "claude-sonnet-5-5" }).startSession({ system: "", tools: [] });
    expect((await s.step({ type: "user", text: "a" })).refused).toBe(true);
    expect((await s.step({ type: "user", text: "b" })).truncated).toBe(true);
  });
});
