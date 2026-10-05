import type { PoolClient } from "pg";

export function sameDatabase(first: string | null | undefined, second: string | null | undefined): boolean {
  if (!first || !second) return false;
  try {
    const identity = (value: string) => {
      const url = new URL(value);
      if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return null;
      return `${url.hostname.replace(/-pooler(?=\.)/, "")}:${url.port || "5432"}${url.pathname}`;
    };
    const firstIdentity = identity(first);
    return firstIdentity !== null && firstIdentity === identity(second);
  } catch {
    return false;
  }
}

export async function websiteProjectionTransaction<T>(
  client: PoolClient,
  sharesSourceTransaction: boolean,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  // In the shared database the caller owns the transaction, including sync status.
  if (sharesSourceTransaction) return operation(client);
  await client.query("BEGIN");
  try {
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
