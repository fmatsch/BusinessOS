import { z } from "zod";

const code = z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9._-]+$/, "Nur Buchstaben, Ziffern, . _ -");
const name = z.string().trim().min(1).max(120);

export const departmentInput = z.object({
  code,
  name,
  parentId: z.string().min(1).nullish(),
});

export const costCenterInput = z.object({
  code,
  name,
  departmentId: z.string().min(1).nullish(),
});

export type DepartmentInput = z.infer<typeof departmentInput>;
export type CostCenterInput = z.infer<typeof costCenterInput>;
