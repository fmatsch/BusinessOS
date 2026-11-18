import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export interface OutboxMessage {
  id: string;
  organizationId: string;
  type: string;
  payload: Prisma.JsonValue;
  attempts: number;
}

/**
 * Handler laufen in derselben Transaktion wie die Markierung „verarbeitet": schlägt einer fehl, werden seine
 * Schreibzugriffe zurückgerollt und der Versuch wird gezählt. Handler müssen trotzdem idempotent sein
 * (z. B. über eindeutige dedupeKeys), weil „mindestens einmal" zugestellt wird.
 */
export type EventHandler = (event: OutboxMessage, tx: Prisma.TransactionClient) => Promise<void>;
export type HandlerMap = Record<string, EventHandler[]>;

export interface DispatchOptions {
  /** maximale Anzahl Events pro Aufruf */
  batch?: number;
  /** nach so vielen fehlgeschlagenen Versuchen wird das Event als fehlgeschlagen (Dead Letter) markiert */
  maxAttempts?: number;
  now?: Date;
  /** nur Events dieser Organisation verarbeiten (Tests, faire Verteilung) */
  organizationId?: string;
}

export interface DispatchResult {
  processed: number;
  retried: number;
  dead: number;
}

/** Wartezeit vor dem n-ten Wiederholungsversuch: 30 s, 60 s, 120 s … (max. 1 h). */
export function backoffMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 60 * 60_000);
}

/** Verarbeitet fällige Outbox-Events. Mehrere parallele Aufrufe (Prozesse) teilen sich die Arbeit ohne Doppelverarbeitung. */
export async function dispatchOutbox(handlers: HandlerMap, opts: DispatchOptions = {}): Promise<DispatchResult> {
  const { batch = 20, maxAttempts = 5, organizationId = null } = opts;
  const result: DispatchResult = { processed: 0, retried: 0, dead: 0 };

  for (let i = 0; i < batch; i++) {
    const now = opts.now ?? new Date();
    try {
      const claimed = await db.$transaction(async (tx) => {
        // SKIP LOCKED: ein Event wird von genau einem Dispatcher gleichzeitig bearbeitet
        const rows = await tx.$queryRaw<OutboxMessage[]>(Prisma.sql`
          SELECT "id", "organizationId", "type", "payload", "attempts"
          FROM "OutboxEvent"
          WHERE "processedAt" IS NULL AND "failedAt" IS NULL AND "nextAttemptAt" <= ${now.toISOString()}::timestamp
            AND (${organizationId}::text IS NULL OR "organizationId" = ${organizationId})
          ORDER BY "createdAt" ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED`);
        // Hinweis: Spalten sind „timestamp without time zone" in UTC; der Vergleichswert wird deshalb als UTC-Text übergeben
        const event = rows[0];
        if (!event) return false;
        try {
          // eigener Savepoint, damit ein Fehler im Handler die Transaktion nicht abbricht
          await tx.$executeRaw`SAVEPOINT handler`;
          for (const h of handlers[event.type] ?? []) await h(event, tx);
          await tx.$executeRaw`RELEASE SAVEPOINT handler`;
        } catch (e) {
          await tx.$executeRaw`ROLLBACK TO SAVEPOINT handler`;
          const attempts = event.attempts + 1;
          const dead = attempts >= maxAttempts;
          await tx.outboxEvent.update({
            where: { id: event.id },
            data: {
              attempts,
              lastError: String(e instanceof Error ? e.message : e).slice(0, 500),
              nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)),
              failedAt: dead ? now : null,
            },
          });
          if (dead) result.dead++;
          else result.retried++;
          return true;
        }
        await tx.outboxEvent.update({ where: { id: event.id }, data: { processedAt: now, lastError: null } });
        result.processed++;
        return true;
      });
      if (!claimed) break;
    } catch (e) {
      // Infrastrukturfehler (z. B. Datenbank nicht erreichbar): abbrechen, beim nächsten Lauf erneut versuchen
      console.error("Outbox dispatch aborted", e);
      break;
    }
  }
  return result;
}
