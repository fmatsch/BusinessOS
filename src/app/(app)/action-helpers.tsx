import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { ForbiddenError } from "@/platform/authz/authorize";
import { ConflictError, NotFoundError } from "@/platform/errors";

/** Führt eine Server Action aus und leitet bei erwarteten Fehlern mit Meldung zurück. Unerwartete Fehler werden weitergeworfen. */
export async function runAction<T>(backTo: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    let message: string | null = null;
    if (e instanceof ZodError) message = e.issues.map((i) => i.message).join("; ");
    else if (e instanceof ForbiddenError) message = "Dafür fehlt die Berechtigung.";
    else if (e instanceof NotFoundError || e instanceof ConflictError) message = e.message;
    else if (e instanceof Error && "code" in e && (e as { code?: string }).code === "P2002") message = "Dieser Eintrag existiert bereits.";
    if (message === null) throw e;
    redirect(`${backTo}${backTo.includes("?") ? "&" : "?"}error=${encodeURIComponent(message)}`);
  }
}

export function ErrorBanner({ message }: { message?: string }) {
  if (!message) return null;
  return <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">{message}</p>;
}
