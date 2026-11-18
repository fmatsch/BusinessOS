import { requireContext } from "@/platform/tenancy/context";
import { getProvider } from "@/modules/copilot/service";
import { CopilotChat } from "./chat";

export const dynamic = "force-dynamic";

export default async function CopilotPage() {
  await requireContext();
  const configured = getProvider() !== null;
  return (
    <div className="max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">KI-Copilot</h1>
      <p className="text-sm text-muted">
        Beantwortet Fragen zu den Daten Ihrer aktiven Organisation – nur lesend und nur mit Ihren Berechtigungen.
        Der Copilot kann nichts anlegen, ändern oder freigeben. Jede Frage und jeder Datenzugriff wird im Audit-Log protokolliert.
        Verfügbar sind Beschaffung, Budgets, Lieferanten, Kostenstellen und Abteilungen; Rechnungen, Personal, Lager und CRM sind noch nicht umgesetzt.
        Jede Frage wird einzeln beantwortet (kein Gesprächsverlauf).
      </p>
      {!configured && (
        <p role="status" className="rounded-lg border border-line bg-surface px-3 py-2 text-sm">
          Der Copilot ist nicht konfiguriert: <code>ANTHROPIC_API_KEY</code> ist auf dem Server nicht gesetzt.
        </p>
      )}
      <CopilotChat />
    </div>
  );
}
