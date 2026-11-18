export const LOCALES = ["de", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const LANG_COOKIE = "bos_lang";

const dict = {
  de: {
    "nav.dashboard": "Dashboard",
    "nav.finance": "Finanzen",
    "nav.hr": "Personal",
    "nav.procurement": "Beschaffung",
    "nav.inventory": "Lager",
    "nav.projects": "Projekte",
    "nav.crm": "CRM",
    "nav.workflows": "Workflows",
    "nav.analytics": "Analysen",
    "nav.copilot": "KI-Copilot",
    "nav.settings": "Einstellungen",
    "nav.departments": "Abteilungen",
    "nav.costcenters": "Kostenstellen",
    "nav.budgets": "Budgets",
    "nav.suppliers": "Lieferanten",
    "nav.audit": "Audit-Log",
    "planned": "Geplant",
    "planned.text": "Dieses Modul ist noch nicht umgesetzt. Es erscheint hier, damit die Roadmap sichtbar ist – es gibt noch keine Funktion.",
    "logout": "Abmelden",
    "org": "Organisation",
    "empty": "Noch keine Einträge.",
    "code": "Code",
    "name": "Name",
    "department": "Abteilung",
    "create": "Anlegen",
    "forbidden": "Dafür fehlt Ihnen die Berechtigung.",
  },
  en: {
    "nav.dashboard": "Dashboard",
    "nav.finance": "Finance",
    "nav.hr": "HR",
    "nav.procurement": "Procurement",
    "nav.inventory": "Inventory",
    "nav.projects": "Projects",
    "nav.crm": "CRM",
    "nav.workflows": "Workflows",
    "nav.analytics": "Analytics",
    "nav.copilot": "AI Copilot",
    "nav.settings": "Settings",
    "nav.departments": "Departments",
    "nav.costcenters": "Cost centers",
    "nav.budgets": "Budgets",
    "nav.suppliers": "Suppliers",
    "nav.audit": "Audit log",
    "planned": "Planned",
    "planned.text": "This module is not implemented yet. It is listed so the roadmap is visible – it has no functionality.",
    "logout": "Sign out",
    "org": "Organization",
    "empty": "No entries yet.",
    "code": "Code",
    "name": "Name",
    "department": "Department",
    "create": "Create",
    "forbidden": "You do not have permission for this.",
  },
} as const;

export type TKey = keyof (typeof dict)["de"];

export function t(locale: Locale, key: TKey): string {
  return dict[locale][key];
}
