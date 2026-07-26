/**
 * Process-wide singletons for the in-memory fallback stores.
 *
 * Every store in this codebase that backs a Redis feature with a plain Map
 * assumes "one module instance per process". That assumption is not free:
 * under some loader configurations the same source file gets evaluated twice
 * (CJS + ESM resolution of the same specifier), each copy gets its OWN Map,
 * and state written through one copy is invisible to the other. It looks
 * exactly like state loss — a clarification the bot just stored reads back as
 * null, a rate-limit bucket never fills, a webhook event is processed twice.
 *
 * Anchoring the containers on globalThis makes duplicate evaluation harmless:
 * both copies share one container. This also keeps state alive across Next.js
 * dev hot-reloads, which re-evaluate modules on every edit.
 *
 * Use these instead of a bare `new Map()` for anything that must be consistent
 * across a request lifetime.
 */

const REGISTRY_KEY = Symbol.for("uudam.processState");

type Registry = Map<string, unknown>;

function registry(): Registry {
  const host = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Registry };
  if (!host[REGISTRY_KEY]) host[REGISTRY_KEY] = new Map();
  return host[REGISTRY_KEY];
}

/**
 * Returns the one container registered under `name`, creating it on first use.
 * `name` must be unique per store — collisions silently merge two stores, so
 * prefix it with the owning module ("webhook_dedup.processed_events").
 */
export function sharedState<T>(name: string, create: () => T): T {
  const store = registry();
  const existing = store.get(name);
  if (existing !== undefined) return existing as T;
  const created = create();
  store.set(name, created);
  return created;
}

export function sharedMap<K, V>(name: string): Map<K, V> {
  return sharedState(name, () => new Map<K, V>());
}

export function sharedSet<V>(name: string): Set<V> {
  return sharedState(name, () => new Set<V>());
}
