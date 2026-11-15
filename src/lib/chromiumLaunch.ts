/**
 * One way to start headless Chromium for the poster PDF and the corporate catalogue.
 *
 * On Vercel, @sparticuz/chromium unpacks the browser binary to /tmp/chromium the first time it is needed,
 * and its `executablePath()` returns at once whenever that file EXISTS, even while it is still being
 * written. Two requests in one warm instance: the first starts unpacking, the second sees the half-written
 * file, spawns it and Linux answers `ETXTBSY` ("text file busy"). Production saw that on /api/poster-pdf
 * (2026-10-03, 2026-11-12; the second time a 1.5 s retry was not long enough for the unpack to finish).
 *
 * The fix is `sharedExecutablePath`: every launch in the process waits for the SAME unpack promise, so no
 * caller can see the file before it is complete. `launchWithRetry` stays as the second line (a different
 * process on the same /tmp), retrying only ETXTBSY with waits long enough for an unpack (~5 s in total).
 */

export const LAUNCH_ATTEMPTS = 5;

export function isTextFileBusy(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  return e?.code === "ETXTBSY" || /\bETXTBSY\b/.test(String(e?.message ?? ""));
}

let executablePathPromise: Promise<string> | null = null;

/**
 * Resolve the browser path once per process. Concurrent callers share the first call's promise; a failed
 * resolve is forgotten so the next launch tries again.
 */
export function sharedExecutablePath(resolve: () => Promise<string>): Promise<string> {
  if (!executablePathPromise) {
    executablePathPromise = resolve().catch(error => {
      executablePathPromise = null;
      throw error;
    });
  }
  return executablePathPromise;
}

/** Test hook: forget the shared path. */
export function resetSharedExecutablePath(): void {
  executablePathPromise = null;
}

export async function launchWithRetry<T>(
  launch: () => Promise<T>,
  opts: { attempts?: number; waitMs?: (attempt: number) => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = opts.attempts ?? LAUNCH_ATTEMPTS;
  const waitMs = opts.waitMs ?? (attempt => 500 * attempt);
  const sleep = opts.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await launch();
    } catch (error) {
      if (attempt >= attempts || !isTextFileBusy(error)) throw error;
      await sleep(waitMs(attempt));
    }
  }
}
