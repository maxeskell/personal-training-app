/**
 * Coalesce concurrent async calls that share a key into a single in-flight promise.
 *
 * The first call for a key runs `task`; any call arriving while that promise is still pending gets the SAME
 * promise back instead of starting its own; once it settles the slot is freed (so a later call re-runs).
 * Used to make an expensive, idempotent operation — generating a session's deep feedback, which is one LLM
 * call — run ONCE even if two dashboard tabs request it the same moment (no double spend). Generic + pure
 * (the caller owns the Map) so the dedup guarantee is unit-testable without doing the real work.
 */
export function coalesce<T>(inFlight: Map<string, Promise<T>>, key: string, task: () => Promise<T>): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing;
  // Run eagerly (the work starts now, not on a later microtask); a synchronous throw becomes a rejection
  // so cleanup is consistent either way.
  let raw: Promise<T>;
  try {
    raw = task();
  } catch (e) {
    raw = Promise.reject(e instanceof Error ? e : new Error(String(e)));
  }
  const p = raw.finally(() => {
    // Only clear our own slot — defensive against a slot already replaced by a later call.
    if (inFlight.get(key) === p) inFlight.delete(key);
  });
  inFlight.set(key, p);
  return p;
}
