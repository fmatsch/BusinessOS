import { db } from "@/lib/db";
import { authorize, type Ctx } from "@/platform/authz/authorize";
import { writeAudit } from "@/platform/audit/audit";
import { NotFoundError } from "@/platform/errors";
import { costCenterInput, departmentInput } from "./schema";

export { NotFoundError };

export async function listDepartments(ctx: Ctx) {
  authorize(ctx, "master.department.read");
  return db.department.findMany({
    where: { organizationId: ctx.organizationId },
    orderBy: { code: "asc" },
    include: { parent: { select: { name: true } }, _count: { select: { costCenters: true } } },
  });
}

export async function createDepartment(ctx: Ctx, raw: unknown) {
  authorize(ctx, "master.department.write");
  const input = departmentInput.parse(raw);

  return db.$transaction(async (tx) => {
    if (input.parentId) {
      const parent = await tx.department.findFirst({
        where: { id: input.parentId, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!parent) throw new NotFoundError("Übergeordnete Abteilung");
    }
    const created = await tx.department.create({
      data: {
        organizationId: ctx.organizationId,
        code: input.code,
        name: input.name,
        parentId: input.parentId ?? null,
      },
    });
    await writeAudit(tx, ctx, {
      action: "department.create",
      entityType: "Department",
      entityId: created.id,
      after: { code: created.code, name: created.name, parentId: created.parentId },
    });
    return created;
  });
}

export async function listCostCenters(ctx: Ctx) {
  authorize(ctx, "master.costcenter.read");
  return db.costCenter.findMany({
    where: { organizationId: ctx.organizationId },
    orderBy: { code: "asc" },
    include: { department: { select: { name: true } } },
  });
}

export async function createCostCenter(ctx: Ctx, raw: unknown) {
  authorize(ctx, "master.costcenter.write");
  const input = costCenterInput.parse(raw);

  return db.$transaction(async (tx) => {
    if (input.departmentId) {
      const dept = await tx.department.findFirst({
        where: { id: input.departmentId, organizationId: ctx.organizationId },
        select: { id: true },
      });
      if (!dept) throw new NotFoundError("Abteilung");
    }
    const created = await tx.costCenter.create({
      data: {
        organizationId: ctx.organizationId,
        code: input.code,
        name: input.name,
        departmentId: input.departmentId ?? null,
      },
    });
    await writeAudit(tx, ctx, {
      action: "costcenter.create",
      entityType: "CostCenter",
      entityId: created.id,
      after: { code: created.code, name: created.name, departmentId: created.departmentId },
    });
    return created;
  });
}
