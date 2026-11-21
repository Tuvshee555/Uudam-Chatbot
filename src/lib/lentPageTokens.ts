// Page tokens lent by the Ursgal hub (ursgalHub.ts), kept in this process's memory only and never
// stored or logged. Each one answers for one account id (the Instagram account the hub forwards),
// and comes with the appsecret_proof the hub computed: this deployment never holds the hub app's
// secret. Filled before a hub delivery is processed; read synchronously by pageTokenForRecipient
// and appsecretProofFor in env.ts. No imports, so env.ts can use it without an import cycle.

/** Matches the hub client's own token cache (ursgalHubClient.ts TOKEN_CACHE_MS). */
export const LENT_TOKEN_TTL_MS = 10 * 60 * 1000;

const byAccount = new Map<string, { token: string; expires: number }>();
const proofs = new Map<string, string>();

export function rememberLentToken(accountId: string, token: string, proof: string, now = Date.now()): void {
  byAccount.set(accountId, { token, expires: now + LENT_TOKEN_TTL_MS });
  proofs.set(token, proof);
}

/** The lent token for this account id, while it is fresh. */
export function lentTokenFor(accountId: string, now = Date.now()): string | undefined {
  const hit = byAccount.get(accountId);
  if (!hit) return undefined;
  if (hit.expires <= now) {
    byAccount.delete(accountId);
    return undefined;
  }
  return hit.token;
}

/** The hub's appsecret_proof for a lent token. */
export function lentProofFor(token: string): string | undefined {
  return proofs.get(token);
}

export function forgetLentTokens(): void {
  byAccount.clear();
  proofs.clear();
}
