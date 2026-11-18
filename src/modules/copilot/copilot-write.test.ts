import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import type { AiProvider, AiTurn } from "@/platform/ai/provider";
import type { Ctx } from "@/platform/authz/authorize";
import { SYSTEM_ROLES, type Permission } from "@/platform/authz/permissions";
import { ConflictError, NotFoundError } from "@/platform/errors";
import { createCostCenter } from "@/modules/masterdata/service";
import { createCustomer } from "@/modules/finance/service";
import { createProject, setProjectStatus } from "@/modules/projects/service";
import { askCopilot, confirmProposal, PROPOSAL_TTL_MS, rejectProposal } from "./service";

const hasDb = !!process.env.DATABASE_URL;
const ctxFor = (organizationId: string, userId: string, role: keyof typeof SYSTEM_ROLES, extra: Permission[] = []): Ctx => ({
  userId, organizationId, permissions: new Set([...(SYSTEM_ROLES[role]!.permissions as readonly Permission[]), ...extra]) as Ctx["permissions"],
});
const turn = (p: Partial<AiTurn>): AiTurn => ({ text: "", toolCalls: [], done: false, refused: false, truncated: false, ...p });
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

function scripted(turns: AiTurn[]) {
  const toolResults: string[] = [];
  const toolNames: string[] = [];
  const provider: AiProvider = {
    name: "fake",
    startSession({ tools }) {
      toolNames.push(...tools.map((t) => t.name));
      let i = 0;
      return { async step(input) { if (input.type === "tool_results") toolResults.push(...input.results.map((r) => r.content)); return turns[Math.min(i++, turns.length - 1)]!; } };
    },
  };
  return { provider, toolResults, toolNames };
}
const call = (name: string, input: unknown, id = "1") => turn({ toolCalls: [{ id, name, input }] });
const done = turn({ done: true, text: "Der Vorschlag liegt zur Bestätigung bereit." });

describe.skipIf(!hasDb)("KI-Copilot: Schreibvorschläge mit Bestätigung", () => {
  let tenantId = "", orgA = "", orgB = "", projectId = "";
  let emp: Ctx, emp2: Ctx, mgr: Ctx, fin: Ctx, finB: Ctx;
  const requestsOf = () => db.purchaseRequest.count({ where: { organizationId: orgA } });
  const REQ = { title: "Bürostühle", costCenterCode: "CP1", lines: [{ description: "Stuhl", quantity: "4", unitPrice: "125,50" }] };

  beforeAll(async () => {
    tenantId = (await db.tenant.create({ data: { name: "TEST-AIW" } })).id;
    orgA = (await db.organization.create({ data: { tenantId, name: "TEST-AIW-A" } })).id;
    orgB = (await db.organization.create({ data: { tenantId, name: "TEST-AIW-B" } })).id;
    emp = ctxFor(orgA, "aw-emp", "employee");
    emp2 = ctxFor(orgA, "aw-emp2", "employee");
    mgr = ctxFor(orgA, "aw-mgr", "manager");
    fin = ctxFor(orgA, "aw-fin", "finance", ["master.costcenter.write"]);
    finB = ctxFor(orgB, "aw-fin-b", "finance", ["master.costcenter.write"]);
    await createCostCenter(fin, { code: "CP1", name: "Copilot-Test" });
    await createCustomer(fin, { number: "KC1", name: "Kunde Copilot" });
    for (const [u, n] of [["aw-emp", "1"], ["aw-emp2", "2"]] as const) await db.employee.create({ data: { organizationId: orgA, number: `AW${n}`, firstName: u, lastName: "Test", userId: u } });
    projectId = (await createProject(mgr, { name: "Relaunch", hourlyRate: "100" })).id;
  });

  afterAll(async () => {
    const orgs = [orgA, orgB];
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.allow_journal_delete', 'on', true)`;
      await tx.projectTime.deleteMany({ where: { organizationId: { in: orgs }, kind: "REVERSAL" } });
      for (const m of ["projectTime", "outboxEvent", "auditLog", "copilotProposal", "activity", "contact", "project", "customer", "purchaseRequest", "employee", "costCenter", "sequence"] as const)
        await (tx[m] as unknown as { deleteMany(a: unknown): Promise<unknown> }).deleteMany({ where: { organizationId: { in: orgs } } });
      await tx.organization.deleteMany({ where: { id: { in: orgs } } });
      await tx.tenant.delete({ where: { id: tenantId } });
    });
    await db.$disconnect();
  });

  it("Vorschlag ändert nichts: Beschreibung vom Server, Modell erfährt „nichts geändert“, Audit als KI-Aktion", async () => {
    const before = await requestsOf();
    const { provider, toolResults } = scripted([call("propose_create_purchase_request", REQ), done]);
    const r = await askCopilot(emp, "Bestelle 4 Bürostühle für 125,50 €", provider);
    expect(r.proposals).toHaveLength(1);
    expect(r.proposals[0]!.summary).toBe("Bestellanforderung „Bürostühle“ einreichen: 1 Position(en), Summe netto 502 €, Kostenstelle CP1.");
    expect(toolResults[0]).toContain("NICHTS geändert");
    expect(await requestsOf()).toBe(before);
    const row = await db.copilotProposal.findUniqueOrThrow({ where: { id: r.proposals[0]!.id } });
    expect(row).toMatchObject({ status: "PENDING", userId: "aw-emp", tool: "propose_create_purchase_request" });
    const audit = await db.auditLog.findMany({ where: { organizationId: orgA, action: "ai.proposal" } });
    expect(audit.every((a) => a.actorType === "AI")).toBe(true);
  });

  it("Bestätigen führt über den Service mit den Rechten der Person aus – genau einmal; fremde Personen können nicht", async () => {
    const { provider } = scripted([call("propose_create_purchase_request", { ...REQ, title: "Bestätigt" }), done]);
    const { proposals } = await askCopilot(emp, "Bestelle", provider);
    const id = proposals[0]!.id;
    await expect(confirmProposal(mgr, id)).rejects.toBeInstanceOf(NotFoundError); // anderer Benutzer
    await expect(confirmProposal(finB, id)).rejects.toBeInstanceOf(NotFoundError); // andere Organisation
    expect(await db.purchaseRequest.count({ where: { organizationId: orgA, title: "Bestätigt" } })).toBe(0);

    const res = await confirmProposal(emp, id);
    expect(res.message).toMatch(/^Bestellanforderung PR-\d{4}-\d{4} eingereicht\.$/);
    const req = await db.purchaseRequest.findFirstOrThrow({ where: { organizationId: orgA, title: "Bestätigt" } });
    expect(req.requesterId).toBe("aw-emp"); // als die bestätigende Person, nicht als „KI“
    expect(String(req.totalAmount)).toBe("502");
    await expect(confirmProposal(emp, id)).rejects.toBeInstanceOf(ConflictError); // nicht zweimal
    expect(await db.purchaseRequest.count({ where: { organizationId: orgA, title: "Bestätigt" } })).toBe(1);
    const log = await db.auditLog.findFirstOrThrow({ where: { organizationId: orgA, action: "ai.proposal_confirmed", entityId: id } });
    expect(log.actorType).toBe("USER");
  });

  it("parallele Bestätigung: höchstens eine Ausführung", async () => {
    const { proposals } = await askCopilot(emp, "Bestelle", scripted([call("propose_create_purchase_request", { ...REQ, title: "Doppelklick" }), done]).provider);
    const r = await Promise.allSettled([confirmProposal(emp, proposals[0]!.id), confirmProposal(emp, proposals[0]!.id)]);
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await db.purchaseRequest.count({ where: { organizationId: orgA, title: "Doppelklick" } })).toBe(1);
  });

  it("Verwerfen und Ablauf führen nichts aus", async () => {
    const a = (await askCopilot(emp, "x", scripted([call("propose_create_purchase_request", { ...REQ, title: "Verworfen" }), done]).provider)).proposals[0]!;
    await rejectProposal(emp, a.id);
    await expect(confirmProposal(emp, a.id)).rejects.toThrow(/bereits entschieden/);
    await expect(rejectProposal(emp, a.id)).rejects.toBeInstanceOf(ConflictError);
    const b = (await askCopilot(emp, "x", scripted([call("propose_create_purchase_request", { ...REQ, title: "Abgelaufen" }), done]).provider)).proposals[0]!;
    await expect(confirmProposal(emp, b.id, Date.now() + PROPOSAL_TTL_MS + 1000)).rejects.toThrow(/abgelaufen/);
    expect((await db.copilotProposal.findUniqueOrThrow({ where: { id: b.id } })).status).toBe("EXPIRED");
    expect(await db.purchaseRequest.count({ where: { organizationId: orgA, title: { in: ["Verworfen", "Abgelaufen"] } } })).toBe(0);
  });

  it("Zeit buchen: nur für sich selbst, Beschreibung nennt das Projekt; Änderungen bis zur Bestätigung werden berücksichtigt", async () => {
    const number = (await db.project.findUniqueOrThrow({ where: { id: projectId } })).number;
    const input = { projectNumber: number, date: day(-1), hours: "1,5", note: "Konzept" };
    const { proposals } = await askCopilot(emp, "Buche 1,5 h", scripted([call("propose_book_project_time", input), done]).provider);
    expect(proposals[0]!.summary).toBe(`1,5 Stunden am ${day(-1)} auf Projekt ${number} „Relaunch“ buchen (Konzept).`);
    expect(await db.projectTime.count({ where: { projectId } })).toBe(0);
    await confirmProposal(emp, proposals[0]!.id);
    const t = await db.projectTime.findFirstOrThrow({ where: { projectId } });
    expect(t).toMatchObject({ minutes: 90, kind: "WORK" });
    expect((await db.employee.findFirstOrThrow({ where: { organizationId: orgA, userId: "aw-emp" } })).id).toBe(t.employeeId);

    // Projekt wird geschlossen, bevor bestätigt wird → Ausführung scheitert sauber, nichts wird gebucht
    const late = (await askCopilot(emp2, "Buche", scripted([call("propose_book_project_time", { ...input, note: "später" }), done]).provider)).proposals[0]!;
    await setProjectStatus(mgr, projectId, "CLOSED");
    await expect(confirmProposal(emp2, late.id)).rejects.toThrow(/abgeschlossene/);
    expect((await db.copilotProposal.findUniqueOrThrow({ where: { id: late.id } })).status).toBe("FAILED");
    expect(await db.projectTime.count({ where: { projectId } })).toBe(1);
    // geschlossene Projekte werden gar nicht erst vorgeschlagen
    const none = scripted([call("propose_book_project_time", input), done]);
    expect((await askCopilot(emp, "Buche", none.provider)).proposals).toHaveLength(0);
    expect(none.toolResults[0]).toContain("abgeschlossen");
    await setProjectStatus(mgr, projectId, "ACTIVE");
  });

  it("Kundenaktivität: nur mit CRM-Schreibrecht angeboten; unbekannter Kunde ergibt keinen Vorschlag", async () => {
    const e = scripted([done]);
    await askCopilot(emp, "Hallo", e.provider);
    expect(e.toolNames).not.toContain("propose_add_customer_activity"); // Mitarbeiter: kein crm.write
    expect(e.toolNames).toContain("propose_create_purchase_request");
    const f = scripted([call("propose_add_customer_activity", { customerNumber: "NIX", type: "CALL", date: day(0), subject: "x" }), done]);
    expect((await askCopilot(fin, "Notiz", f.provider)).proposals).toHaveLength(0);
    expect(f.toolResults[0]).toContain("Kunde NIX");
    const ok = scripted([call("propose_add_customer_activity", { customerNumber: "KC1", type: "CALL", date: day(0), subject: "Rückruf vereinbart", body: "Interesse an Wartung" }), done]);
    const { proposals } = await askCopilot(fin, "Notiz", ok.provider);
    expect(proposals[0]!.summary).toBe(`Anruf am ${day(0)} bei Kunde KC1 „Kunde Copilot“ eintragen: Rückruf vereinbart.`);
    await confirmProposal(fin, proposals[0]!.id);
    expect(await db.activity.count({ where: { organizationId: orgA, subject: "Rückruf vereinbart" } })).toBe(1);
  });

  it("Grenzen: Vorschläge je Frage begrenzt, Eingaben geprüft, kein Werkzeug zum Bestätigen/Freigeben/Löschen, Rechtsentzug wirkt", async () => {
    const many = scripted([turn({ toolCalls: [1, 2, 3, 4].map((i) => ({ id: String(i), name: "propose_create_purchase_request", input: { ...REQ, title: `Viele ${i}` } })) }), done]);
    expect((await askCopilot(emp, "x", many.provider)).proposals).toHaveLength(3);
    expect(many.toolResults.some((t) => t.includes("höchstens 3"))).toBe(true);

    const bad = scripted([call("propose_create_purchase_request", { title: "", lines: [] }), call("propose_create_purchase_request", { ...REQ, costCenterCode: "NIX" }, "2"), done]);
    expect((await askCopilot(emp, "x", bad.provider)).proposals).toHaveLength(0);
    expect(bad.toolResults.join(" ")).toContain("Ungültige Eingabe");
    expect(bad.toolResults.join(" ")).toContain("Kostenstelle NIX");

    const evil = scripted([call("confirm_proposal", { id: "x" }), call("approve_request", { id: "x" }, "2"), call("delete_everything", {}, "3"), done]);
    expect((await askCopilot(mgr, "x", evil.provider)).proposals).toHaveLength(0);
    expect(evil.toolResults.every((t) => t.includes("nicht erlaubt"))).toBe(true);
    expect(evil.toolNames.every((n) => !/confirm|approve|delete|pay|release/.test(n))).toBe(true);

    const p = (await askCopilot(emp, "x", scripted([call("propose_create_purchase_request", { ...REQ, title: "Rechte weg" }), done]).provider)).proposals[0]!;
    const demoted = { ...emp, permissions: new Set<Permission>() as Ctx["permissions"] };
    await expect(confirmProposal(demoted, p.id)).rejects.toThrow(/Berechtigung/);
    expect(await db.purchaseRequest.count({ where: { organizationId: orgA, title: "Rechte weg" } })).toBe(0);
  });
});
