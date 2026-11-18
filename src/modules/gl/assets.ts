import { db } from "@/lib/db";
import { Decimal } from "@/lib/money";
import { authorize, type Ctx } from "@/platform/authz/authorize";
import { writeAudit } from "@/platform/audit/audit";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { dateFromIso, isoFromDate } from "@/modules/hr/queries";
import { z } from "zod";
import { decimalString } from "@/lib/zod-decimal";
import { isValidIsoDate } from "@/modules/hr/queries";
import { accumulatedDepreciation, assetTermsProblem, bookValue, monthlyDepreciation } from "./depreciation";
import { writeEntry } from "./service";

const assetInput = z.object({
  name: z.string().trim().min(1).max(120),
  acquiredOn: z.string().refine(isValidIsoDate, "Ungültiges Datum (JJJJ-MM-TT)"),
  cost: decimalString.refine((d) => d.decimalPlaces() <= 2, "Höchstens 2 Nachkommastellen"),
  residualValue: decimalString.refine((d) => d.decimalPlaces() <= 2, "Höchstens 2 Nachkommastellen").default("0" as never),
  usefulLifeMonths: z.coerce.number().int(),
  assetAccountId: z.string().min(1),
  depreciationAccountId: z.string().min(1),
});

async function nextNumber(tx: Parameters<Parameters<typeof db.$transaction>[0]>[0], organizationId: string, year: number) {
  const key = `AV-${year}`;
  const seq = await tx.sequence.upsert({ where: { organizationId_key: { organizationId, key } }, create: { organizationId, key, value: 1 }, update: { value: { increment: 1 } } });
  return `${key}-${String(seq.value).padStart(4, "0")}`;
}

/** Anlagegut anlegen. Die Anschaffung selbst wird über die Rechnung gebucht (Anlagenkonto als Konto der Position); hier entsteht das Verzeichnis für die Abschreibung. */
export async function createAsset(ctx: Ctx, raw: unknown) {
  authorize(ctx, "gl.post");
  const input = assetInput.parse(raw);
  const residual = new Decimal(String(input.residualValue)); // der Standardwert läuft nicht durch die Zahlenumwandlung
  const problem = assetTermsProblem({ cost: input.cost, residual, lifeMonths: input.usefulLifeMonths });
  if (problem) throw new ConflictError(problem);
  return db.$transaction(async (tx) => {
    const accounts = await tx.account.findMany({ where: { organizationId: ctx.organizationId, id: { in: [input.assetAccountId, input.depreciationAccountId] }, type: "GL", active: true }, select: { id: true } });
    if (accounts.length !== new Set([input.assetAccountId, input.depreciationAccountId]).size) throw new NotFoundError("Konto");
    const created = await tx.fixedAsset.create({
      data: {
        organizationId: ctx.organizationId, number: await nextNumber(tx, ctx.organizationId, Number(input.acquiredOn.slice(0, 4))), name: input.name, acquiredOn: dateFromIso(input.acquiredOn),
        cost: input.cost.toString(), residualValue: residual.toString(), usefulLifeMonths: input.usefulLifeMonths, assetAccountId: input.assetAccountId, depreciationAccountId: input.depreciationAccountId, createdById: ctx.userId,
      },
    });
    await writeAudit(tx, ctx, { action: "asset.create", entityType: "FixedAsset", entityId: created.id, after: { number: created.number, cost: input.cost.toString() } });
    return created;
  });
}

const terms = (a: { cost: { toString(): string }; residualValue: { toString(): string }; usefulLifeMonths: number; acquiredOn: Date }) => ({ cost: a.cost.toString(), residual: a.residualValue.toString(), lifeMonths: a.usefulLifeMonths, acquiredOn: isoFromDate(a.acquiredOn) });

/** Anlagenverzeichnis mit Abschreibung und Buchwert zum Stichtag (rechnerisch) sowie dem tatsächlich gebuchten Stand. */
export async function listAssets(ctx: Ctx, asOf = isoFromDate(new Date())) {
  authorize(ctx, "gl.read");
  const y = Number(asOf.slice(0, 4)), m = Number(asOf.slice(5, 7));
  const rows = await db.fixedAsset.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { number: "asc" }, include: { depreciations: true } });
  return rows.map((a) => {
    const t = terms(a);
    const booked = a.depreciations.reduce((s, x) => s.plus(x.amount.toString()), new Decimal(0));
    return { ...a, accumulated: accumulatedDepreciation(t, y, m), bookValue: bookValue(t, y, m), bookedDepreciation: booked, bookedBookValue: new Decimal(a.cost.toString()).minus(booked) };
  });
}

/**
 * Bucht die Monatsabschreibung (Soll AfA-Aufwand, Haben Anlagenkonto) aller aktiven Anlagegüter für den Monat.
 * Je Anlagegut und Monat höchstens einmal; geschlossene Perioden werden abgewiesen; ausgeschiedene Anlagen werden nicht mehr abgeschrieben.
 */
export async function runDepreciation(ctx: Ctx, year: number, month: number) {
  authorize(ctx, "gl.post");
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) throw new ConflictError("Ungültiger Monat");
  const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  if (last > isoFromDate(new Date())) throw new ConflictError("Der Monat ist noch nicht abgelaufen");
  return db.$transaction(async (tx) => {
    if (!(await tx.glSettings.findUnique({ where: { organizationId: ctx.organizationId } }))) throw new ConflictError("Das Hauptbuch ist noch nicht eingeschaltet");
    const assets = await tx.fixedAsset.findMany({ where: { organizationId: ctx.organizationId, status: "ACTIVE" }, include: { depreciations: { where: { year, month } } }, orderBy: { number: "asc" } });
    let posted = 0, total = new Decimal(0);
    for (const a of assets) {
      if (a.depreciations.length > 0) continue;
      const amount = monthlyDepreciation(terms(a), year, month);
      if (amount.lte(0)) continue;
      const text = `AfA ${String(month).padStart(2, "0")}/${year} ${a.number} ${a.name}`;
      const entry = await writeEntry(tx, ctx, {
        date: last, text, source: "DEPRECIATION", sourceId: `${a.id}:${year}-${String(month).padStart(2, "0")}`,
        lines: [{ accountId: a.depreciationAccountId, debit: amount, credit: new Decimal(0), text }, { accountId: a.assetAccountId, debit: new Decimal(0), credit: amount }],
      });
      await tx.assetDepreciation.create({ data: { organizationId: ctx.organizationId, assetId: a.id, year, month, amount: amount.toString(), entryId: entry.id } });
      posted++; total = total.plus(amount);
    }
    await writeAudit(tx, ctx, { action: "asset.depreciation", entityType: "FixedAsset", entityId: ctx.organizationId, after: { year, month, posted, total: total.toString() } });
    return { posted, total };
  });
}

/** Ausscheiden: keine weitere Abschreibung. Der Restbuchwert und ein etwaiger Verkaufserlös werden von Hand gebucht (manuelle Buchung). */
export async function disposeAsset(ctx: Ctx, assetId: string, disposedOn: string) {
  authorize(ctx, "gl.post");
  if (!isValidIsoDate(disposedOn)) throw new ConflictError("Ungültiges Datum");
  return db.$transaction(async (tx) => {
    const r = await tx.fixedAsset.updateMany({ where: { id: assetId, organizationId: ctx.organizationId, status: "ACTIVE" }, data: { status: "DISPOSED", disposedOn: dateFromIso(disposedOn) } });
    if (r.count !== 1) throw new ConflictError("Das Anlagegut ist nicht aktiv");
    await writeAudit(tx, ctx, { action: "asset.dispose", entityType: "FixedAsset", entityId: assetId, after: { disposedOn } });
  });
}
