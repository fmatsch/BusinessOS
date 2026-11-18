import { z } from "zod";
import type { AiTool } from "@/platform/ai/agent";
import { budgetOverview, committedByDepartment } from "@/modules/budget/service";
import { listCostCenters, listDepartments } from "@/modules/masterdata/service";
import { getRequest, listPendingApprovals, listRequests, listSuppliers } from "@/modules/procurement/service";
import { listProjects } from "@/modules/projects/service";
import { listCrmCustomers } from "@/modules/crm/service";

const year = z.number().int().min(2000).max(2100).optional().describe("Geschäftsjahr, Standard: aktuelles Jahr");
const currentYear = () => new Date().getFullYear();
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/**
 * Nur lesende Werkzeuge. Jedes ruft denselben Service-Layer wie die Oberfläche mit dem Kontext des angemeldeten
 * Benutzers auf – kein Service-Konto, kein freies SQL. Quellen werden serverseitig aus den Ergebnissen abgeleitet.
 */
export const copilotTools: AiTool<any>[] = [
  {
    name: "list_purchase_requests",
    description:
      "Listet Bestellanforderungen (Nummer, Titel, Status, Betrag, Kostenstelle). Status: DRAFT, SUBMITTED (wartet auf Freigabe), APPROVED (freigegeben, noch nicht bestellt), REJECTED, ORDERED. Benutzer ohne Gesamtansicht sehen nur eigene.",
    permission: "procurement.request.create",
    input: z.object({ status: z.enum(["DRAFT", "SUBMITTED", "APPROVED", "REJECTED", "ORDERED"]).optional(), limit: z.number().int().min(1).max(50).optional() }),
    async run(ctx, input: { status?: string; limit?: number }) {
      const rows = (await listRequests(ctx)).filter((r) => !input.status || r.status === input.status).slice(0, input.limit ?? 25);
      return {
        data: rows.map((r) => ({
          id: r.id, number: r.number, title: r.title, status: r.status, total: r.totalAmount.toString(), currency: r.currency,
          costCenter: r.costCenter?.code ?? null, submittedAt: iso(r.submittedAt),
        })),
        sources: rows.map((r) => ({ type: "PurchaseRequest", id: r.id, label: `${r.number} · ${r.title}`, href: `/procurement/${r.id}` })),
      };
    },
  },
  {
    name: "get_purchase_request",
    description: "Details einer Bestellanforderung inkl. Positionen, Freigabeschritten und Bestellungen. Eingabe: id aus list_purchase_requests.",
    permission: "procurement.request.create",
    input: z.object({ id: z.string().min(1).max(60) }),
    async run(ctx, input: { id: string }) {
      const r = await getRequest(ctx, input.id);
      return {
        data: {
          number: r.number, title: r.title, status: r.status, total: r.totalAmount.toString(), currency: r.currency,
          lines: r.lines.map((l) => ({ description: l.description, quantity: l.quantity.toString(), unitPrice: l.unitPrice.toString() })),
          approvals: r.approvals.map((a) => ({ step: a.stepKey, status: a.status, decidedAt: iso(a.decidedAt), comment: a.comment })),
          orders: r.orders.map((o) => ({ number: o.number, supplier: o.supplier.name, costCenter: o.costCenter.code, total: o.totalAmount.toString() })),
        },
        sources: [{ type: "PurchaseRequest", id: r.id, label: `${r.number} · ${r.title}`, href: `/procurement/${r.id}` }],
      };
    },
  },
  {
    name: "list_pending_approvals",
    description: "Freigaben, die der aktuelle Benutzer jetzt entscheiden darf.",
    permission: "procurement.request.approve",
    input: z.object({}),
    async run(ctx) {
      const rows = await listPendingApprovals(ctx);
      return {
        data: rows.map((a) => ({ requestId: a.requestId, number: a.request.number, title: a.request.title, total: a.request.totalAmount.toString(), step: a.stepKey })),
        sources: rows.map((a) => ({ type: "PurchaseRequest", id: a.requestId, label: `${a.request.number} · ${a.request.title}`, href: `/procurement/${a.requestId}` })),
      };
    },
  },
  {
    name: "budget_overview",
    description:
      "Budget, gebundenes Budget (Summe der Bestellungen) und Verfügbares je Kostenstelle für ein Geschäftsjahr. remaining < 0 bedeutet Budget überschritten. Auch geeignet für 'Ausgaben je Kostenstelle'.",
    permission: "finance.budget.read",
    input: z.object({ year }),
    async run(ctx, input: { year?: number }) {
      const y = input.year ?? currentYear();
      const rows = await budgetOverview(ctx, y);
      return {
        data: {
          year: y,
          costCenters: rows.map((r) => ({
            code: r.code, name: r.name, budget: r.budget?.toString() ?? null, committed: r.committed.toString(),
            remaining: r.remaining?.toString() ?? null, overBudget: r.remaining?.isNegative() ?? false,
          })),
        },
        sources: [{ type: "Budget", id: String(y), label: `Budgetübersicht ${y}`, href: `/budgets?year=${y}` }],
      };
    },
  },
  {
    name: "committed_by_department",
    description: "Gebundene Beträge (Bestellungen) je Abteilung im Geschäftsjahr, absteigend sortiert – für Fragen nach den höchsten Kosten je Abteilung. Das sind Bestellvolumina, keine vollständigen Betriebskosten.",
    permission: "finance.budget.read",
    input: z.object({ year }),
    async run(ctx, input: { year?: number }) {
      const y = input.year ?? currentYear();
      const rows = await committedByDepartment(ctx, y);
      return {
        data: { year: y, departments: rows.map((r) => ({ department: r.department, committed: r.committed.toString(), orders: r.orderCount })) },
        sources: [{ type: "Budget", id: `dept-${y}`, label: `Bestellungen je Abteilung ${y}`, href: `/budgets?year=${y}` }],
      };
    },
  },
  {
    name: "list_suppliers",
    description: "Lieferanten (Nummer, Name, aktiv).",
    permission: "procurement.supplier.read",
    input: z.object({}),
    async run(ctx) {
      const rows = await listSuppliers(ctx);
      return {
        data: rows.map((s) => ({ number: s.number, name: s.name, active: s.active })),
        sources: [{ type: "Supplier", id: "all", label: "Lieferanten", href: "/suppliers" }],
      };
    },
  },
  {
    name: "list_cost_centers",
    description: "Kostenstellen mit zugehöriger Abteilung.",
    permission: "master.costcenter.read",
    input: z.object({}),
    async run(ctx) {
      const rows = await listCostCenters(ctx);
      return {
        data: rows.map((c) => ({ code: c.code, name: c.name, department: c.department?.name ?? null, active: c.active })),
        sources: [{ type: "CostCenter", id: "all", label: "Kostenstellen", href: "/cost-centers" }],
      };
    },
  },
  {
    name: "list_departments",
    description: "Abteilungen mit übergeordneter Abteilung und Anzahl Kostenstellen.",
    permission: "master.department.read",
    input: z.object({}),
    async run(ctx) {
      const rows = await listDepartments(ctx);
      return {
        data: rows.map((d) => ({ code: d.code, name: d.name, parent: d.parent?.name ?? null, costCenters: d._count.costCenters })),
        sources: [{ type: "Department", id: "all", label: "Abteilungen", href: "/departments" }],
      };
    },
  },
  {
    name: "list_projects",
    description: "Projekte (Nummer, Name, Status, gebuchte Stunden, Budgetverbrauch). Die Projektnummer wird für Vorschläge zum Zeitbuchen gebraucht.",
    permission: "project.read",
    input: z.object({}),
    async run(ctx) {
      const rows = await listProjects(ctx);
      return {
        data: rows.slice(0, 50).map((p) => ({ number: p.number, name: p.name, status: p.status, bookedMinutes: p.bookedMinutes, budgetUsedPercent: p.budgetUsed })),
        sources: [{ type: "Project", id: "all", label: "Projekte", href: "/projects" }],
      };
    },
  },
  {
    name: "list_crm_customers",
    description: "Kunden (Nummer, Name, Ort, letzte Aktivität, offene Angebote). Die Kundennummer wird für Vorschläge zu Aktivitäten gebraucht.",
    permission: "crm.read",
    input: z.object({}),
    async run(ctx) {
      const rows = await listCrmCustomers(ctx);
      return {
        data: rows.slice(0, 100).map((c) => ({ number: c.number, name: c.name, city: c.city, lastActivity: iso(c.lastActivity), openQuotes: c.openQuotes })),
        sources: [{ type: "Customer", id: "all", label: "Kunden (CRM)", href: "/crm" }],
      };
    },
  },
];
