export const ADMIN_SESSION_COOKIE: string;
export type DevAdminCookie = { name: string; value: string; url: string; httpOnly: boolean; sameSite: "Strict" };
export function assertLocalTarget(baseUrl: string): void;
export function readEnvFile(path: string): Record<string, string>;
export function devAdminSessionToken(input: { key: string | undefined; email: string | undefined; now?: number; ttlMs?: number }): string;
export function devAdminCookie(
  baseUrl: string,
  options?: { key?: string; email?: string; now?: number; ttlMs?: number },
): DevAdminCookie;
export function devAdminCookieFromEnv(
  baseUrl: string,
  options?: { envPath?: string; email?: string; ttlMs?: number },
): DevAdminCookie;
