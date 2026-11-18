/** Zentrale Registrierung aller Permissions (modul.ressource.aktion). */
export const PERMISSIONS = [
  "org.settings.manage",
  "org.members.manage",
  "org.audit.read",
  "master.department.read",
  "master.department.write",
  "master.costcenter.read",
  "master.costcenter.write",
  "procurement.supplier.read",
  "procurement.supplier.write",
  "procurement.request.create",
  "procurement.request.approve",
  "procurement.request.approve_finance",
  "procurement.request.read_all",
  "procurement.order.create",
  "finance.budget.read",
  "finance.budget.write",
  "hr.employee.read",
  "hr.employee.read_sensitive",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** Systemrollen, die pro Organisation angelegt werden. */
export const SYSTEM_ROLES: Record<string, { name: string; permissions: readonly Permission[] }> = {
  owner: { name: "Inhaber", permissions: PERMISSIONS },
  finance: {
    name: "Finanzen",
    permissions: [
      "org.audit.read",
      "master.department.read",
      "master.costcenter.read",
      "master.costcenter.write",
      "procurement.supplier.read",
      "procurement.supplier.write",
      "procurement.request.create",
      "procurement.request.approve_finance",
      "procurement.request.read_all",
      "procurement.order.create",
      "finance.budget.read",
      "finance.budget.write",
    ],
  },
  manager: {
    name: "Führungskraft",
    permissions: [
      "master.department.read",
      "master.costcenter.read",
      "procurement.supplier.read",
      "procurement.request.create",
      "procurement.request.approve",
      "procurement.request.read_all",
      "finance.budget.read",
      "hr.employee.read",
    ],
  },
  employee: {
    name: "Mitarbeiter",
    permissions: ["master.department.read", "master.costcenter.read", "procurement.request.create"],
  },
};
