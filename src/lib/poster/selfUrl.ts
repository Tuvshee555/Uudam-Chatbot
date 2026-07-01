/**
 * Resolves this deployment's own base URL so a route can fire a follow-up
 * request to another route on itself (used to kick off the extract-worker
 * without the client's request waiting on it).
 *
 * VERCEL_URL is set automatically by Vercel at runtime to the current
 * deployment's hostname — more reliable than a manually-maintained BASE_URL
 * env var, which can go stale across deployments/domains/ports. Local dev
 * ignores BASE_URL entirely and derives the port from PORT/the npm script
 * (3004 here) since a stale BASE_URL silently pointing at the wrong port
 * causes "fetch failed" with no useful error.
 */
export function resolveSelfBaseUrl(): string {
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  const port = process.env.PORT || "3004";
  return `http://localhost:${port}`;
}
