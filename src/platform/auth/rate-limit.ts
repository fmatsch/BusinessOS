const hits = new Map<string, number[]>();

/** In-Memory-Limiter (nur eine Instanz). Liefert false, wenn das Limit überschritten ist. */
export function rateLimit(key: string, max: number, windowMs: number, now = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    hits.set(key, recent);
    return false;
  }
  recent.push(now);
  hits.set(key, recent);
  return true;
}

export function resetRateLimit() {
  hits.clear();
}

/** Ist der Schlüssel im Fenster bereits am Limit? Zählt nicht mit (für „nur Fehlversuche zählen", z. B. Login). */
export function isLimited(key: string, max: number, windowMs: number, now = Date.now()): boolean {
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  hits.set(key, recent);
  return recent.length >= max;
}

export function recordHit(key: string, now = Date.now()) {
  hits.set(key, [...(hits.get(key) ?? []), now]);
}

export function clearKey(key: string) {
  hits.delete(key);
}
