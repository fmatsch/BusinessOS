import { describe, expect, it } from "vitest";
import { authorize, can, ForbiddenError, type Ctx } from "./authorize";
import { PERMISSIONS, SYSTEM_ROLES } from "./permissions";

const ctx = (perms: string[]): Ctx => ({
  userId: "u1",
  organizationId: "o1",
  permissions: new Set(perms) as Ctx["permissions"],
});

describe("authorize", () => {
  it("erlaubt vorhandene Permission", () => {
    expect(() => authorize(ctx(["org.audit.read"]), "org.audit.read")).not.toThrow();
  });
  it("verweigert fehlende Permission", () => {
    expect(() => authorize(ctx([]), "org.audit.read")).toThrow(ForbiddenError);
    expect(can(ctx([]), "org.audit.read")).toBe(false);
  });
});

describe("Systemrollen", () => {
  it("verwenden nur registrierte Permissions", () => {
    for (const role of Object.values(SYSTEM_ROLES))
      for (const p of role.permissions) expect(PERMISSIONS).toContain(p);
  });
  it("Mitarbeiter hat keinen Zugriff auf sensible HR-Daten", () => {
    expect(SYSTEM_ROLES.employee!.permissions).not.toContain("hr.employee.read_sensitive");
    expect(SYSTEM_ROLES.manager!.permissions).not.toContain("hr.employee.read_sensitive");
  });
});
