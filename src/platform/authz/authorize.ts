import type { Permission } from "./permissions";

export interface Ctx {
  userId: string;
  organizationId: string;
  permissions: ReadonlySet<Permission>;
}

export class ForbiddenError extends Error {
  constructor(public readonly permission: string) {
    super("Keine Berechtigung");
    this.name = "ForbiddenError";
  }
}

export function can(ctx: Ctx, permission: Permission): boolean {
  return ctx.permissions.has(permission);
}

/** Wirft ForbiddenError. Muss am Anfang jeder geschützten Service-Funktion stehen. */
export function authorize(ctx: Ctx, permission: Permission): void {
  if (!can(ctx, permission)) throw new ForbiddenError(permission);
}
