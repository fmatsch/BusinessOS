import type { HandlerMap } from "@/platform/events/dispatcher";
import { notify, usersWithPermission } from "@/platform/notifications/service";
import { EVENT_TYPES } from "./catalog";
import { matches, render, safeHref, type Action, type Condition } from "./engine";

const MAX_RECIPIENTS = 200;

/**
 * Für jedes Ereignis des Katalogs: die jeweils aktuelle, eingeschaltete Version jeder Regel der Organisation des Ereignisses auswerten.
 * Idempotent: je Regelversion und Ereignis ein Protokolleintrag (eindeutig), Benachrichtigungen mit dedupeKey. Liest nur innerhalb der Organisation des Ereignisses.
 */
export const workflowHandlers: HandlerMap = Object.fromEntries(
  EVENT_TYPES.map((type) => [type, [async (event, tx) => {
    // jeweils die neueste Version jeder Regel; gilt sie für ein anderes Ereignis, bleibt die Regel hier außen vor
    const all = await tx.workflowDefinition.findMany({ where: { organizationId: event.organizationId }, orderBy: [{ key: "asc" }, { version: "desc" }] });
    const seen = new Set<string>();
    const current = all.filter((d) => (seen.has(d.key) ? false : (seen.add(d.key), true)));
    const payload = event.payload as Record<string, unknown>;
    for (const def of current) {
      if (def.eventType !== type || !def.enabled) continue;
      const ok = matches(def.conditions as Condition[], type, payload);
      let sent = 0;
      if (ok) {
        for (const [i, a] of (def.actions as Action[]).entries()) {
          const users = a.recipient.kind === "ACTOR"
            ? (typeof payload.actorUserId === "string" ? [payload.actorUserId] : [])
            : (await usersWithPermission(tx, event.organizationId, a.recipient.permission)).slice(0, MAX_RECIPIENTS);
          await notify(tx, event.organizationId, users.map((userId) => ({
            userId, title: render(a.title, type, payload, 160), body: a.body ? render(a.body, type, payload, 400) : undefined, href: safeHref(payload), type: "workflow",
            dedupeKey: `wf:${def.id}:${event.id}:${i}:${userId}`,
          })));
          sent += users.length;
        }
      }
      await tx.workflowRun.createMany({ data: [{ organizationId: event.organizationId, definitionId: def.id, eventId: event.id, eventType: type, matched: ok, notifications: sent }], skipDuplicates: true });
    }
  }]]),
);
