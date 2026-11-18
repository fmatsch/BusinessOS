import { z } from "zod";
import { Decimal } from "@/lib/money";
import type { AiWriteTool } from "@/platform/ai/agent";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { listCostCenters } from "@/modules/masterdata/service";
import { createRequest } from "@/modules/procurement/service";
import { bookProjectTime, listProjects } from "@/modules/projects/service";
import { addActivity, listCrmCustomers } from "@/modules/crm/service";

/**
 * Schreibende Werkzeuge: Sie schlagen nur vor. Bezeichnungen (Codes, Nummern) werden serverseitig aufgelöst; die Beschreibung,
 * die die Person zu sehen bekommt, entsteht hier aus den geprüften Daten – nicht aus Text des Modells. Ausgeführt wird erst nach
 * Bestätigung, über denselben Service wie die Oberfläche und mit den Berechtigungen der bestätigenden Person.
 * Freigeben, Entscheiden, Löschen und Zahlungen gibt es hier bewusst nicht.
 */

const ACTIVITY_TYPES = ["CALL", "MAIL", "MEETING", "NOTE"] as const;
const ACTIVITY_LABEL: Record<(typeof ACTIVITY_TYPES)[number], string> = { CALL: "Anruf", MAIL: "E-Mail", MEETING: "Termin", NOTE: "Notiz" };
const amount = z.string().trim().regex(/^\d+([.,]\d{1,4})?$/, "Zahl mit höchstens 4 Nachkommastellen");
const num = (v: string) => v.replace(",", ".");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Datum als JJJJ-MM-TT");
const fmt = (d: Decimal) => d.toDecimalPlaces(2).toString().replace(".", ",");

const requestInput = z.object({
  title: z.string().trim().min(1).max(120),
  costCenterCode: z.string().trim().min(1).max(20).optional().describe("Code der Kostenstelle aus list_cost_centers"),
  lines: z.array(z.object({ description: z.string().trim().min(1).max(200), quantity: amount, unitPrice: amount.describe("Stückpreis netto in EUR") })).min(1).max(5),
});

const timeInput = z.object({
  projectNumber: z.string().trim().min(1).max(30).describe("Projektnummer aus list_projects, z. B. PJ-2026-0001"),
  date: isoDate.describe("Arbeitstag, nicht in der Zukunft"),
  hours: amount.describe("Stunden, z. B. 1,5"),
  note: z.string().trim().max(200).optional(),
});

const activityInput = z.object({
  customerNumber: z.string().trim().min(1).max(20).describe("Kundennummer aus list_crm_customers"),
  type: z.enum(ACTIVITY_TYPES),
  date: isoDate.describe("Datum der Aktivität, nicht in der Zukunft"),
  subject: z.string().trim().min(1).max(160),
  body: z.string().trim().max(2000).optional(),
});

async function costCenterId(ctx: Parameters<typeof listCostCenters>[0], code?: string) {
  if (!code) return null;
  const cc = (await listCostCenters(ctx)).find((c) => c.code === code && c.active);
  if (!cc) throw new NotFoundError(`Kostenstelle ${code}`);
  return cc.id;
}

export const copilotWriteTools: AiWriteTool<any>[] = [
  {
    name: "propose_create_purchase_request",
    description: "Schlägt vor, eine Bestellanforderung einzureichen (Titel, optional Kostenstelle, 1–5 Positionen mit Menge und Netto-Stückpreis). Wird erst nach Bestätigung durch den Benutzer eingereicht und folgt dann der normalen Freigabe.",
    permission: "procurement.request.create",
    input: requestInput,
    async propose(ctx, input: z.infer<typeof requestInput>) {
      await costCenterId(ctx, input.costCenterCode);
      const total = input.lines.reduce((a, l) => a.plus(new Decimal(num(l.quantity)).times(num(l.unitPrice))), new Decimal(0));
      return { summary: `Bestellanforderung „${input.title}“ einreichen: ${input.lines.length} Position(en), Summe netto ${fmt(total)} €${input.costCenterCode ? `, Kostenstelle ${input.costCenterCode}` : ""}.` };
    },
    async execute(ctx, input: z.infer<typeof requestInput>) {
      const r = await createRequest(ctx, { title: input.title, costCenterId: await costCenterId(ctx, input.costCenterCode), lines: input.lines.map((l) => ({ description: l.description, quantity: num(l.quantity), unitPrice: num(l.unitPrice) })) });
      return { message: `Bestellanforderung ${r.number} eingereicht.`, href: `/procurement/${r.id}` };
    },
  },
  {
    name: "propose_book_project_time",
    description: "Schlägt vor, Projektstunden für den Benutzer selbst zu buchen (Projektnummer, Datum, Stunden). Wird erst nach Bestätigung gebucht.",
    permission: "project.time.book",
    input: timeInput,
    async propose(ctx, input: z.infer<typeof timeInput>) {
      const p = (await listProjects(ctx)).find((x) => x.number === input.projectNumber);
      if (!p) throw new NotFoundError(`Projekt ${input.projectNumber}`);
      if (p.status !== "ACTIVE") throw new ConflictError(`Das Projekt ${p.number} ist abgeschlossen`);
      return { summary: `${num(input.hours).replace(".", ",")} Stunden am ${input.date} auf Projekt ${p.number} „${p.name}“ buchen${input.note ? ` (${input.note})` : ""}.` };
    },
    async execute(ctx, input: z.infer<typeof timeInput>) {
      const p = (await listProjects(ctx)).find((x) => x.number === input.projectNumber);
      if (!p) throw new NotFoundError(`Projekt ${input.projectNumber}`);
      await bookProjectTime(ctx, { projectId: p.id, workDate: input.date, hours: num(input.hours), note: input.note });
      return { message: `${num(input.hours)} Stunden auf ${p.number} gebucht.`, href: `/projects/${p.id}` };
    },
  },
  {
    name: "propose_add_customer_activity",
    description: "Schlägt vor, einen Eintrag im Aktivitätsprotokoll eines Kunden anzulegen (Anruf, E-Mail, Termin oder Notiz). Wird erst nach Bestätigung eingetragen; Einträge sind unveränderlich.",
    permission: "crm.write",
    input: activityInput,
    async propose(ctx, input: z.infer<typeof activityInput>) {
      const c = (await listCrmCustomers(ctx)).find((x) => x.number === input.customerNumber);
      if (!c) throw new NotFoundError(`Kunde ${input.customerNumber}`);
      return { summary: `${ACTIVITY_LABEL[input.type]} am ${input.date} bei Kunde ${c.number} „${c.name}“ eintragen: ${input.subject}.` };
    },
    async execute(ctx, input: z.infer<typeof activityInput>) {
      const c = (await listCrmCustomers(ctx)).find((x) => x.number === input.customerNumber);
      if (!c) throw new NotFoundError(`Kunde ${input.customerNumber}`);
      await addActivity(ctx, { customerId: c.id, type: input.type, occurredOn: input.date, subject: input.subject, body: input.body });
      return { message: `Aktivität bei ${c.number} eingetragen.`, href: `/crm/${c.id}` };
    },
  },
];
