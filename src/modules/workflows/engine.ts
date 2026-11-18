/** Regelauswertung und Textvorlagen für Workflows – rein, ohne Datenbank. */
import { z } from "zod";
import { Decimal } from "@/lib/money";
import { PERMISSIONS } from "@/platform/authz/permissions";
import { EVENT_CATALOG, type EventSpec } from "./catalog";

export const OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "contains"] as const;
export type Op = (typeof OPS)[number];
export const OP_LABEL: Record<Op, string> = { eq: "ist gleich", neq: "ist ungleich", gt: "größer als", gte: "mindestens", lt: "kleiner als", lte: "höchstens", contains: "enthält" };

export const conditionSchema = z.object({ field: z.string().min(1).max(40), op: z.enum(OPS), value: z.string().trim().min(1).max(100) });
export type Condition = z.infer<typeof conditionSchema>;

export const actionSchema = z.object({
  type: z.literal("NOTIFY"),
  recipient: z.union([z.object({ kind: z.literal("PERMISSION"), permission: z.string() }), z.object({ kind: z.literal("ACTOR") })]),
  title: z.string().trim().min(1).max(160),
  body: z.string().trim().max(400).optional(),
});
export type Action = z.infer<typeof actionSchema>;

export const MAX_CONDITIONS = 5;
export const MAX_ACTIONS = 3;

export const definitionSchema = z.object({
  key: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{1,38}$/, "Schlüssel: Kleinbuchstaben, Ziffern, Bindestrich (2–39 Zeichen)"),
  name: z.string().trim().min(1).max(100),
  eventType: z.string().refine((t) => t in EVENT_CATALOG, "Unbekanntes Ereignis"),
  conditions: z.array(conditionSchema).max(MAX_CONDITIONS).default([]),
  actions: z.array(actionSchema).min(1, "Mindestens eine Aktion").max(MAX_ACTIONS),
  enabled: z.boolean().default(true),
}).superRefine((d, ctx) => {
  const spec: EventSpec | undefined = EVENT_CATALOG[d.eventType];
  if (!spec) return;
  d.conditions.forEach((c, i) => {
    const f = spec.fields[c.field];
    if (!f) return ctx.addIssue({ code: "custom", path: ["conditions", i, "field"], message: `Das Feld „${c.field}“ gibt es bei diesem Ereignis nicht` });
    if (f.kind === "number") {
      if (c.op === "contains") ctx.addIssue({ code: "custom", path: ["conditions", i, "op"], message: "„enthält“ gilt nur für Text" });
      if (!/^-?\d+([.,]\d+)?$/.test(c.value)) ctx.addIssue({ code: "custom", path: ["conditions", i, "value"], message: "Für Zahlenfelder wird eine Zahl erwartet" });
    } else if (!["eq", "neq", "contains"].includes(c.op)) ctx.addIssue({ code: "custom", path: ["conditions", i, "op"], message: "Für Textfelder gelten nur „ist gleich“, „ist ungleich“ und „enthält“" });
  });
  d.actions.forEach((a, i) => {
    if (a.recipient.kind === "PERMISSION" && !(PERMISSIONS as readonly string[]).includes(a.recipient.permission))
      ctx.addIssue({ code: "custom", path: ["actions", i, "recipient"], message: "Unbekannte Berechtigung" });
  });
});
export type DefinitionInput = z.infer<typeof definitionSchema>;

type Payload = Record<string, unknown>;
const asPayload = (v: unknown): Payload => (v && typeof v === "object" && !Array.isArray(v) ? (v as Payload) : {});

/** Alle Bedingungen müssen zutreffen (UND). Fehlt ein Feld in der Nutzlast, trifft die Bedingung nicht zu. */
export function matches(conditions: Condition[], eventType: string, payload: unknown): boolean {
  const spec = EVENT_CATALOG[eventType];
  const p = asPayload(payload);
  if (!spec) return false;
  return conditions.every((c) => {
    const f = spec.fields[c.field];
    const raw = p[c.field];
    if (!f || raw === undefined || raw === null) return false;
    if (f.kind === "number") {
      let a: Decimal, b: Decimal;
      try { a = new Decimal(String(raw)); b = new Decimal(c.value.replace(",", ".")); } catch { return false; }
      return { eq: a.eq(b), neq: !a.eq(b), gt: a.gt(b), gte: a.gte(b), lt: a.lt(b), lte: a.lte(b), contains: false }[c.op];
    }
    const a = String(raw).toLowerCase(), b = c.value.toLowerCase();
    return c.op === "eq" ? a === b : c.op === "neq" ? a !== b : c.op === "contains" ? a.includes(b) : false;
  });
}

/** Ersetzt {{feld}} durch Werte der Nutzlast; nur deklarierte Felder, alles andere wird leer. Ergebnis ist reiner Text. */
export function render(template: string, eventType: string, payload: unknown, max = 200): string {
  const spec = EVENT_CATALOG[eventType];
  const p = asPayload(payload);
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, name: string) => (spec?.fields[name] && p[name] !== undefined && p[name] !== null ? String(p[name]) : "")).slice(0, max);
}

/** Interner Link aus der Nutzlast (nur Pfade der eigenen Anwendung). */
export function safeHref(payload: unknown): string | undefined {
  const h = asPayload(payload).href;
  return typeof h === "string" && /^\/[A-Za-z0-9/_\-.?=&]*$/.test(h) && !h.startsWith("//") ? h : undefined;
}
