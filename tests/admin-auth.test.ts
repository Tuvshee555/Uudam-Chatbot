import assert from "node:assert/strict";
import test from "node:test";
import { pickFirst, safeSecretCompare } from "../src/lib/adminAuth";

test("safeSecretCompare matches only exact secret", () => {
  assert.equal(safeSecretCompare("abc123", "abc123"), true);
  assert.equal(safeSecretCompare("abc123", "abc124"), false);
  assert.equal(safeSecretCompare("abc123", "abc1234"), false);
  assert.equal(safeSecretCompare("abc123", ""), false);
});

test("pickFirst handles array and scalar headers safely", () => {
  assert.equal(pickFirst([" first ", "second"]), "first");
  assert.equal(pickFirst(" value "), "value");
  assert.equal(pickFirst(undefined), "");
});

test("metrics rejects a wrong secret, then rate-limits repeated attempts", async () => {
  const { applyTestEnv } = await import("./helpers/env");
  applyTestEnv({ ADMIN_AUTH_RATE_LIMIT: "3" });
  const envModule = await import("../src/lib/env");
  envModule.resetEnvCacheForTests();
  const { resetRateLimitForTests } = await import("../src/lib/rateLimit");
  resetRateLimitForTests();
  const { default: handler } = await import("../src/pages/api/metrics");

  function call(secret: string) {
    const req = {
      method: "GET",
      url: "/api/metrics",
      headers: { "x-admin-secret": secret },
      query: {},
      socket: { remoteAddress: "203.0.113.7" },
    } as unknown as import("next").NextApiRequest;
    const res = {
      statusCode: 200,
      body: undefined as unknown,
      status(code: number) { this.statusCode = code; return this; },
      json(body: unknown) { this.body = body; return this; },
      end() { return this; },
      setHeader() {},
    };
    return { res, done: handler(req, res as never) };
  }

  // A wrong secret is unauthorized, not a generic error...
  const first = call("nope");
  await first.done;
  assert.equal(first.res.statusCode, 401);

  // ...and repeated guesses from the same client run out of budget.
  for (let i = 0; i < 3; i += 1) await call("nope").done;
  const blocked = call("nope");
  await blocked.done;
  assert.equal(blocked.res.statusCode, 429);
  assert.equal((blocked.res.body as { error: string }).error, "too_many_attempts");

  // The correct secret still gets the snapshot.
  resetRateLimitForTests();
  const ok = call("test-admin-secret");
  await ok.done;
  assert.equal(ok.res.statusCode, 200);
  assert.ok((ok.res.body as { metrics?: unknown }).metrics);
});
