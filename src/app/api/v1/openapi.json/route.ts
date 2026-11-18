import { OPENAPI } from "../_openapi";

export const dynamic = "force-static";

/** Maschinenlesbare API-Beschreibung (öffentlich; enthält keine Daten). */
export function GET() {
  return new Response(JSON.stringify(OPENAPI), { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}
