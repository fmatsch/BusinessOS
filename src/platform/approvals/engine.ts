import { z } from "zod";
import { Decimal } from "@/lib/money";
import { PERMISSIONS } from "@/platform/authz/permissions";

/** Berechtigungen, die als Freigabe-Berechtigung in einer Regel zulässig sind. */
export const APPROVER_PERMISSIONS = [
  "procurement.request.approve",
  "procurement.request.approve_finance",
  "hr.absence.approve",
  "hr.absence.approve_all",
  "crm.quote.approve",
  "expense.approve",
  "expense.approve_all",
] as const;

export const policyStepSchema = z.object({
  key: z.string().trim().min(1).max(30).regex(/^[A-Z0-9_]+$/, "Schlüssel: Großbuchstaben, Ziffern, _"),
  label: z.string().trim().min(1).max(60),
  permission: z.enum(APPROVER_PERMISSIONS),
  /** Schritt gilt nur, wenn der Betrag größer ist (exklusiv). Ohne Angabe: immer. */
  minAmount: z.string().regex(/^\d+(\.\d{1,4})?$/, "Betrag mit Punkt, max. 4 Nachkommastellen").optional(),
});

export const policyStepsSchema = z
  .array(policyStepSchema)
  .min(1)
  .max(5)
  .superRefine((steps, ctx) => {
    if (new Set(steps.map((s) => s.key)).size !== steps.length) ctx.addIssue({ code: "custom", message: "Schlüssel müssen eindeutig sein" });
    // Jeder Vorgang braucht mindestens einen Schritt: der erste gilt immer
    if (steps[0]?.minAmount !== undefined) ctx.addIssue({ code: "custom", message: "Der erste Schritt muss immer gelten (kein Mindestbetrag)" });
    for (const s of steps) if (!PERMISSIONS.includes(s.permission)) ctx.addIssue({ code: "custom", message: "Unbekannte Berechtigung" });
  });

export type PolicyStep = z.infer<typeof policyStepSchema>;

/** Standardregel: Führungskraft immer, Finanzen zusätzlich über 5.000. */
export const DEFAULT_PURCHASE_POLICY: PolicyStep[] = [
  { key: "MANAGER", label: "Führungskraft", permission: "procurement.request.approve" },
  { key: "FINANCE", label: "Finanzen", permission: "procurement.request.approve_finance", minAmount: "5000" },
];

export const DEFAULT_ABSENCE_POLICY: PolicyStep[] = [
  { key: "MANAGER", label: "Führungskraft", permission: "hr.absence.approve" },
];

export const DEFAULT_EXPENSE_POLICY: PolicyStep[] = [
  { key: "MANAGER", label: "Führungskraft", permission: "expense.approve" },
  { key: "FINANCE", label: "Finanzen", permission: "expense.approve_all", minAmount: "1000" },
];

export const DEFAULT_QUOTE_POLICY: PolicyStep[] = [
  { key: "SALES_LEAD", label: "Vertriebsleitung", permission: "crm.quote.approve" },
];

/** Standardregeln je Objektart (werden beim ersten Zugriff als Version 1 angelegt). */
export const DEFAULT_POLICIES: Record<string, PolicyStep[]> = {
  PURCHASE_REQUEST: DEFAULT_PURCHASE_POLICY,
  ABSENCE_REQUEST: DEFAULT_ABSENCE_POLICY,
  QUOTE: DEFAULT_QUOTE_POLICY,
  EXPENSE_REPORT: DEFAULT_EXPENSE_POLICY,
};

/** Die für diesen Betrag nötigen Schritte in Reihenfolge. */
export function stepsFor(steps: PolicyStep[], amount: Decimal.Value): PolicyStep[] {
  const a = new Decimal(amount);
  return steps.filter((s) => s.minAmount === undefined || a.greaterThan(s.minAmount));
}
