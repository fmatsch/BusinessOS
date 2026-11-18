import { Decimal } from "@/lib/money";

/** Ab diesem Gesamtbetrag (exklusiv) ist zusätzlich eine Freigabe durch Finanzen nötig. */
export const FINANCE_APPROVAL_THRESHOLD = new Decimal(5000);

export type ApprovalStepKey = "MANAGER" | "FINANCE";

export function computeTotal(lines: { quantity: Decimal.Value; unitPrice: Decimal.Value }[]): Decimal {
  return lines.reduce((sum, l) => sum.plus(new Decimal(l.quantity).times(l.unitPrice)), new Decimal(0));
}

export function requiredSteps(total: Decimal.Value): ApprovalStepKey[] {
  return new Decimal(total).greaterThan(FINANCE_APPROVAL_THRESHOLD) ? ["MANAGER", "FINANCE"] : ["MANAGER"];
}

export const STEP_PERMISSION = {
  MANAGER: "procurement.request.approve",
  FINANCE: "procurement.request.approve_finance",
} as const;
