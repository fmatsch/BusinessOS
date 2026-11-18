import { dispatchOutbox, type DispatchOptions, type HandlerMap } from "@/platform/events/dispatcher";
import { hrHandlers } from "./hr/handlers";
import { procurementHandlers } from "./procurement/handlers";
import { rosterHandlers } from "./roster/handlers";

/** Zentrale Registrierung aller Event-Handler der Fachmodule. */
export function allHandlers(): HandlerMap {
  const maps = [procurementHandlers, hrHandlers, rosterHandlers];
  const merged: HandlerMap = {};
  for (const m of maps) for (const [type, hs] of Object.entries(m)) (merged[type] ??= []).push(...hs);
  return merged;
}

export function runOutbox(opts?: DispatchOptions) {
  return dispatchOutbox(allHandlers(), opts);
}
