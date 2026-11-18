import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { backoffMs, dispatchOutbox, type HandlerMap } from "./dispatcher";
import { notify } from "@/platform/notifications/service";

const hasDb = !!process.env.DATABASE_URL;

describe("backoffMs", () => {
  it("wächst exponentiell und ist nach oben begrenzt", () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(3)).toBe(120_000);
    expect(backoffMs(50)).toBe(3_600_000);
  });
});

describe.skipIf(!hasDb)("Outbox-Dispatcher", () => {
  let tenantId = "", org = "";
  const emit = (type: string, payload: object = {}) => db.outboxEvent.create({ data: { organizationId: org, type, payload } });
  const run = (handlers: HandlerMap, o: Parameters<typeof dispatchOutbox>[1] = {}) => dispatchOutbox(handlers, { organizationId: org, ...o });

  beforeAll(async () => {
    tenantId = (await db.tenant.create({ data: { name: "TEST-Outbox" } })).id;
    org = (await db.organization.create({ data: { tenantId, name: "TEST-Outbox-A" } })).id;
  });
  afterAll(async () => {
    await db.notification.deleteMany({ where: { organizationId: org } });
    await db.outboxEvent.deleteMany({ where: { organizationId: org } });
    await db.organization.delete({ where: { id: org } });
    await db.tenant.delete({ where: { id: tenantId } });
    await db.$disconnect();
  });

  it("verarbeitet ein Event genau einmal und markiert es", async () => {
    const e = await emit("t.ok");
    let calls = 0;
    const r = await run({ "t.ok": [async () => { calls++; }] });
    expect(r).toEqual({ processed: 1, retried: 0, dead: 0 });
    expect((await db.outboxEvent.findUniqueOrThrow({ where: { id: e.id } })).processedAt).not.toBeNull();
    await run({ "t.ok": [async () => { calls++; }] });
    expect(calls).toBe(1);
  });

  it("Event ohne Handler wird als verarbeitet markiert (kein Stau)", async () => {
    const e = await emit("t.nobody-listens");
    await run({});
    expect((await db.outboxEvent.findUniqueOrThrow({ where: { id: e.id } })).processedAt).not.toBeNull();
  });

  it("Handler-Fehler: Schreibzugriffe werden zurückgerollt, Versuch gezählt, Wiederholung erst nach Backoff", async () => {
    const e = await emit("t.flaky");
    const t0 = new Date();
    let fail = true;
    const handlers: HandlerMap = {
      "t.flaky": [async (ev, tx) => {
        await notify(tx, org, [{ userId: "u1", title: "Test", dedupeKey: `${ev.id}:u1` }]);
        if (fail) throw new Error("kaputt");
      }],
    };
    expect(await run(handlers, { now: t0 })).toEqual({ processed: 0, retried: 1, dead: 0 });
    let row = await db.outboxEvent.findUniqueOrThrow({ where: { id: e.id } });
    expect(row).toMatchObject({ attempts: 1, lastError: "kaputt", processedAt: null, failedAt: null });
    expect(await db.notification.count({ where: { organizationId: org, dedupeKey: `${e.id}:u1` } })).toBe(0); // zurückgerollt
    expect(row.nextAttemptAt.getTime()).toBe(t0.getTime() + backoffMs(1));

    // noch nicht fällig
    expect(await run(handlers, { now: new Date(t0.getTime() + 1000) })).toEqual({ processed: 0, retried: 0, dead: 0 });
    // fällig und Fehler behoben
    fail = false;
    expect(await run(handlers, { now: new Date(t0.getTime() + backoffMs(1) + 1) })).toMatchObject({ processed: 1 });
    row = await db.outboxEvent.findUniqueOrThrow({ where: { id: e.id } });
    expect(row.processedAt).not.toBeNull();
    expect(row.lastError).toBeNull();
    expect(await db.notification.count({ where: { organizationId: org, dedupeKey: `${e.id}:u1` } })).toBe(1);
  });

  it("nach maxAttempts wird das Event als fehlgeschlagen markiert und nicht mehr versucht", async () => {
    const e = await emit("t.dead");
    let calls = 0;
    const handlers: HandlerMap = { "t.dead": [async () => { calls++; throw new Error("immer kaputt"); }] };
    let now = new Date();
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await run(handlers, { now, maxAttempts: 3 }));
      now = new Date(now.getTime() + 3_600_000 * 2);
    }
    expect(results.map((r) => [r.retried, r.dead])).toEqual([[1, 0], [1, 0], [0, 1], [0, 0]]);
    expect(calls).toBe(3);
    expect((await db.outboxEvent.findUniqueOrThrow({ where: { id: e.id } })).failedAt).not.toBeNull();
  });

  it("Datenbankfehler im Handler bricht die Verarbeitung nicht ab (Savepoint)", async () => {
    const bad = await emit("t.dberror");
    const good = await emit("t.after");
    const handlers: HandlerMap = {
      "t.dberror": [async (_ev, tx) => { await tx.organization.create({ data: { tenantId: "gibt-es-nicht", name: "x" } }); }],
      "t.after": [async () => {}],
    };
    const r = await run(handlers);
    expect(r).toMatchObject({ processed: 1, retried: 1 });
    expect((await db.outboxEvent.findUniqueOrThrow({ where: { id: bad.id } })).attempts).toBe(1);
    expect((await db.outboxEvent.findUniqueOrThrow({ where: { id: good.id } })).processedAt).not.toBeNull();
  });

  it("parallele Dispatcher verarbeiten jedes Event genau einmal", async () => {
    const ids = (await Promise.all(Array.from({ length: 12 }, () => emit("t.parallel")))).map((e) => e.id);
    const seen = new Map<string, number>();
    const handlers: HandlerMap = {
      "t.parallel": [async (ev) => { await new Promise((r) => setTimeout(r, 15)); seen.set(ev.id, (seen.get(ev.id) ?? 0) + 1); }],
    };
    await Promise.all([run(handlers), run(handlers), run(handlers), run(handlers)]);
    expect([...seen.keys()].sort()).toEqual([...ids].sort());
    expect([...seen.values()].every((n) => n === 1)).toBe(true);
  });

  it("notify ist idempotent über dedupeKey", async () => {
    await db.$transaction(async (tx) => {
      const n = { userId: "u9", title: "Doppelt", dedupeKey: "same-key" };
      await notify(tx, org, [n]);
      await notify(tx, org, [n]);
    });
    expect(await db.notification.count({ where: { organizationId: org, dedupeKey: "same-key" } })).toBe(1);
  });
});
