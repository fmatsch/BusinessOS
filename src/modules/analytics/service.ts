import { db } from "@/lib/db";
import { Decimal } from "@/lib/money";
import { authorize, can, type Ctx } from "@/platform/authz/authorize";
import type { Permission } from "@/platform/authz/permissions";
import { writeAudit } from "@/platform/audit/audit";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { budgetOverview } from "@/modules/budget/service";
import { BUCKET_LABEL, listOpenItems } from "@/modules/finance/service";
import { revenueByMonth } from "@/modules/finance/queries";
import { orderVolumeBySupplier } from "@/modules/procurement/queries";
import { approvedExpensesByMonth } from "@/modules/expenses/queries";
import { quoteFunnel } from "@/modules/crm/queries";
import { listProjects } from "@/modules/projects/service";
import { listItems } from "@/modules/inventory/service";
import { toCsv, type CsvColumn } from "./csv";

export const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

export interface ReportResult {
  columns: CsvColumn[];
  rows: Record<string, string>[];
  /** Balkendiagramm über eine Zahlenspalte */
  chart?: { labelKey: string; valueKey: string; unit: string };
  note?: string;
}
export interface ReportDef {
  id: string;
  title: string;
  description: string;
  /** zusätzlich zu `analytics.read` nötig – die zugrunde liegenden Daten bleiben an ihre Rechte gebunden */
  permission: Permission;
  usesYear: boolean;
  run(ctx: Ctx, year: number): Promise<ReportResult>;
}

const m2 = (v: Decimal.Value) => new Decimal(v).toFixed(2);
const pct = (a: Decimal, b: Decimal) => (b.isZero() ? "" : a.div(b).times(100).toFixed(1));

export const REPORTS: ReportDef[] = [
  {
    id: "revenue", title: "Umsatz je Monat", description: "Netto der ausgestellten Ausgangsrechnungen nach Rechnungsdatum, Gutschriften abgezogen.", permission: "finance.invoice.read", usesYear: true,
    async run(ctx, year) {
      const vals = await revenueByMonth(db, ctx.organizationId, year);
      return { columns: [{ key: "month", label: "Monat" }, { key: "net", label: "Umsatz netto (€)", numeric: true }], rows: vals.map((v, i) => ({ month: `${MONTHS[i]} ${year}`, net: m2(v) })), chart: { labelKey: "month", valueKey: "net", unit: "€" } };
    },
  },
  {
    id: "receivables", title: "Offene Posten nach Alter", description: "Unbezahlte Ausgangsrechnungen (brutto, nach Gutschriften) nach Tagen über Fälligkeit. Stichtag: heute.", permission: "finance.invoice.read", usesYear: false,
    async run(ctx) {
      const { summary } = await listOpenItems(ctx);
      return { columns: [{ key: "bucket", label: "Alter" }, { key: "open", label: "Offen brutto (€)", numeric: true }], rows: (Object.keys(BUCKET_LABEL) as (keyof typeof BUCKET_LABEL)[]).map((b) => ({ bucket: BUCKET_LABEL[b], open: m2(summary[b]) })), chart: { labelKey: "bucket", valueKey: "open", unit: "€" } };
    },
  },
  {
    id: "purchasing", title: "Einkauf nach Lieferant", description: "Bestellvolumen (netto) je Lieferant im Jahr, ohne stornierte Bestellungen.", permission: "procurement.request.read_all", usesYear: true,
    async run(ctx, year) {
      const rows = await orderVolumeBySupplier(db, ctx.organizationId, year);
      return { columns: [{ key: "supplier", label: "Lieferant" }, { key: "orders", label: "Bestellungen", numeric: true }, { key: "total", label: "Volumen (€)", numeric: true }], rows: rows.map((r) => ({ supplier: `${r.number} ${r.name}`, orders: String(r.orders), total: m2(r.total) })), chart: { labelKey: "supplier", valueKey: "total", unit: "€" } };
    },
  },
  {
    id: "budget", title: "Budget und Verbrauch je Kostenstelle", description: "Budget, gebunden (Bestellungen), Ist (freigegebene Rechnungen) und Verfügbares im Geschäftsjahr; Verbrauch in Prozent des Budgets (Gebunden).", permission: "finance.budget.read", usesYear: true,
    async run(ctx, year) {
      const rows = await budgetOverview(ctx, year);
      return {
        columns: [{ key: "cc", label: "Kostenstelle" }, { key: "budget", label: "Budget (€)", numeric: true }, { key: "committed", label: "Gebunden (€)", numeric: true }, { key: "actual", label: "Ist (€)", numeric: true }, { key: "remaining", label: "Verfügbar (€)", numeric: true }, { key: "used", label: "Gebunden in % des Budgets", numeric: true }],
        rows: rows.map((r) => ({ cc: `${r.code} ${r.name}`, budget: r.budget ? m2(r.budget) : "", committed: m2(r.committed), actual: m2(r.actual), remaining: r.remaining ? m2(r.remaining) : "", used: r.budget ? pct(r.committed, r.budget) : "" })),
        chart: { labelKey: "cc", valueKey: "committed", unit: "€" },
      };
    },
  },
  {
    id: "projects", title: "Projektstunden", description: "Gebuchte und noch nicht abgerechnete Stunden je Projekt, Budgetverbrauch.", permission: "project.read", usesYear: false,
    async run(ctx) {
      const rows = await listProjects(ctx);
      return {
        columns: [{ key: "project", label: "Projekt" }, { key: "status", label: "Status" }, { key: "booked", label: "Gebucht (h)", numeric: true }, { key: "open", label: "Offen (h)", numeric: true }, { key: "used", label: "Budgetverbrauch (%)", numeric: true }],
        rows: rows.map((p) => ({ project: `${p.number} ${p.name}`, status: p.status === "ACTIVE" ? "aktiv" : "abgeschlossen", booked: new Decimal(p.bookedMinutes).div(60).toFixed(2), open: new Decimal(p.bookedMinutes - p.billedMinutes).div(60).toFixed(2), used: p.budgetUsed === null ? "" : String(p.budgetUsed) })),
        chart: { labelKey: "project", valueKey: "booked", unit: "h" },
      };
    },
  },
  {
    id: "expenses", title: "Spesen je Monat", description: "Freigegebene und ausbezahlte Spesenabrechnungen nach Monat der Einreichung (brutto).", permission: "expense.read_all", usesYear: true,
    async run(ctx, year) {
      const vals = await approvedExpensesByMonth(db, ctx.organizationId, year);
      return { columns: [{ key: "month", label: "Monat" }, { key: "count", label: "Abrechnungen", numeric: true }, { key: "total", label: "Summe (€)", numeric: true }], rows: vals.map((v, i) => ({ month: `${MONTHS[i]} ${year}`, count: String(v.count), total: m2(v.total) })), chart: { labelKey: "month", valueKey: "total", unit: "€" } };
    },
  },
  {
    id: "quotes", title: "Angebote und Annahmequote", description: "Angebote des Jahres nach Status. Annahmequote = angenommen ÷ (angenommen + abgelehnt + noch offen versendet), nach Anzahl.", permission: "crm.read", usesYear: true,
    async run(ctx, year) {
      const f = await quoteFunnel(db, ctx.organizationId, year);
      const LABEL: Record<string, string> = { DRAFT: "Entwurf", PENDING: "wartet auf Freigabe", APPROVED: "freigegeben", SENT: "versendet (offen)", ACCEPTED: "angenommen", DECLINED: "vom Kunden abgelehnt", REJECTED: "intern abgelehnt", CANCELLED: "verworfen" };
      const by = new Map(f.map((x) => [x.status, x]));
      const sent = ["SENT", "ACCEPTED", "DECLINED"].reduce((a, s) => a + (by.get(s)?.count ?? 0), 0);
      const rate = sent === 0 ? null : ((by.get("ACCEPTED")?.count ?? 0) / sent) * 100;
      return {
        columns: [{ key: "status", label: "Status" }, { key: "count", label: "Anzahl", numeric: true }, { key: "gross", label: "Brutto (€)", numeric: true }],
        rows: Object.keys(LABEL).map((s) => ({ status: LABEL[s]!, count: String(by.get(s)?.count ?? 0), gross: m2(by.get(s)?.gross ?? 0) })),
        chart: { labelKey: "status", valueKey: "count", unit: "" },
        note: rate === null ? "Noch keine versendeten Angebote – keine Annahmequote." : `Annahmequote: ${rate.toFixed(1)} % (${by.get("ACCEPTED")?.count ?? 0} von ${sent} versendeten).`,
      };
    },
  },
  {
    id: "inventory", title: "Lagerbestand", description: "Bestand je Artikel mit Hinweis auf Unterschreiten des Mindestbestands. Stichtag: heute (ohne Bewertung).", permission: "inventory.read", usesYear: false,
    async run(ctx) {
      const rows = await listItems(ctx);
      return {
        columns: [{ key: "item", label: "Artikel" }, { key: "unit", label: "Einheit" }, { key: "onHand", label: "Bestand", numeric: true }, { key: "reorder", label: "Mindestbestand", numeric: true }, { key: "flag", label: "Hinweis" }],
        rows: rows.filter((i) => i.active).map((i) => ({ item: `${i.number} ${i.name}`, unit: i.unit, onHand: i.onHand.toString(), reorder: i.reorderLevel?.toString() ?? "", flag: i.belowReorder ? "nachbestellen" : "" })),
        chart: { labelKey: "item", valueKey: "onHand", unit: "" },
      };
    },
  },
];

const byId = (id: string) => REPORTS.find((r) => r.id === id);
const yearOk = (y: number) => Number.isInteger(y) && y >= 2000 && y <= 2100;

/** Berichte, die die Person sehen darf: `analytics.read` plus das Recht auf die zugrunde liegenden Daten. */
export async function listReports(ctx: Ctx) {
  authorize(ctx, "analytics.read");
  return REPORTS.filter((r) => can(ctx, r.permission)).map(({ id, title, description, usesYear }) => ({ id, title, description, usesYear }));
}

export async function runReport(ctx: Ctx, id: string, year: number): Promise<{ id: string; title: string; description: string; year: number | null } & ReportResult> {
  authorize(ctx, "analytics.read");
  const r = byId(id);
  if (!r) throw new NotFoundError("Bericht");
  authorize(ctx, r.permission);
  if (r.usesYear && !yearOk(year)) throw new ConflictError("Ungültiges Jahr");
  const res = await r.run(ctx, year);
  return { id: r.id, title: r.title, description: r.description, year: r.usesYear ? year : null, ...res };
}

/** CSV-Export eines Berichts; jeder Export steht im Audit-Log. */
export async function exportReportCsv(ctx: Ctx, id: string, year: number) {
  const res = await runReport(ctx, id, year);
  await db.$transaction((tx) => writeAudit(tx, ctx, { action: "analytics.export", entityType: "Report", entityId: id, after: { year: res.year, rows: res.rows.length } }));
  return { filename: `${id}${res.year ? `-${res.year}` : ""}.csv`, csv: toCsv(res.columns, res.rows) };
}
