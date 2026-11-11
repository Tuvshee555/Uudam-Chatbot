/**
 * One way to start headless Chromium for the poster PDF and the corporate catalogue.
 *
 * On Vercel, @sparticuz/chromium unpacks the browser binary to /tmp the first time it is needed. When
 * two requests in one warm instance launch at once, the second can spawn the file while the first is
 * still writing it and Linux answers `ETXTBSY` ("text file busy"). Production saw exactly that on
 * /api/poster-pdf. The file is complete a moment later, so that one error is retried after a short
 * wait; every other launch error is thrown at once.
 */

export const LAUNCH_ATTEMPTS = 4;

export function isTextFileBusy(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  return e?.code === "ETXTBSY" || /\bETXTBSY\b/.test(String(e?.message ?? ""));
}

export async function launchWithRetry<T>(
  launch: () => Promise<T>,
  opts: { attempts?: number; waitMs?: (attempt: number) => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const attempts = opts.attempts ?? LAUNCH_ATTEMPTS;
  const waitMs = opts.waitMs ?? (attempt => 250 * attempt);
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
