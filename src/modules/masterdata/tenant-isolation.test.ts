import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { PERMISSIONS } from "@/platform/authz/permissions";
import type { Ctx } from "@/platform/authz/authorize";
import { createCostCenter, createDepartment, listDepartments, NotFoundError } from "./service";

// Integrationstest: benötigt eine migrierte Datenbank (TEST_DATABASE_URL oder DATABASE_URL).
const hasDb = !!process.env.DATABASE_URL;

describe.skipIf(!hasDb)("Tenant-Isolation (Stammdaten)", () => {
  let ctxA: Ctx, ctxB: Ctx, deptA: string;
  const ids: string[] = [];

  beforeAll(async () => {
    const tenant = await db.tenant.create({ data: { name: "TEST-Tenant" } });
    const [a, b] = await Promise.all(
      ["A", "B"].map((n) => db.organization.create({ data: { tenantId: tenant.id, name: `TEST-Org-${n}` } })),
    );
    ids.push(a!.id, b!.id);
    const perms = new Set(PERMISSIONS) as Ctx["permissions"];
    ctxA = { userId: "t", organizationId: a!.id, permissions: perms };
    ctxB = { userId: "t", organizationId: b!.id, permissions: perms };
    deptA = (await createDepartment(ctxA, { code: "X1", name: "Nur in A" })).id;
  });

  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { organizationId: { in: ids } } });
    await db.costCenter.deleteMany({ where: { organizationId: { in: ids } } });
    await db.department.deleteMany({ where: { organizationId: { in: ids } } });
    const orgs = await db.organization.findMany({ where: { id: { in: ids } } });
    await db.organization.deleteMany({ where: { id: { in: ids } } });
    await db.tenant.deleteMany({ where: { id: { in: orgs.map((o) => o.tenantId) } } });
    await db.$disconnect();
  });

  it("Org B sieht keine Abteilungen von Org A", async () => {
    expect((await listDepartments(ctxB)).map((d) => d.id)).not.toContain(deptA);
    expect((await listDepartments(ctxA)).map((d) => d.id)).toContain(deptA);
  });

  it("Org B kann keine Kostenstelle an eine Abteilung von Org A hängen", async () => {
    await expect(createCostCenter(ctxB, { code: "K9", name: "Fremd", departmentId: deptA })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});
