import assert from "node:assert/strict";
import test from "node:test";
import Redis from "ioredis";
import { applyTestEnv } from "./helpers/env";

test("multipart delivery resumes from durable receipts across a Redis reconnect", async context => {
  applyTestEnv();
  const { getEnv } = await import("../src/lib/env");
  const { resetRedisStateForTests } = await import("../src/lib/redisState");
  const { deliverMessengerText } = await import("../src/lib/metaTextDelivery");
  const env = getEnv();
  env.redisStateEnabled = true;
  env.redisReplayEnabled = true;
  env.redisUrl = "redis://127.0.0.1:6379";
  const receipts = new Map<string, string>();
  const writes: Array<{ key: string; value: string; ttl: number }> = [];
  context.mock.method(Redis.prototype, "connect", async function (this: Redis) { this.status = "ready"; });
  context.mock.method(Redis.prototype, "disconnect", () => {});
  context.mock.method(Redis.prototype, "get", async (key: string) => receipts.get(key) ?? null);
  context.mock.method(Redis.prototype, "set", async (key: string, value: string, mode: string, ttl: number) => {
    assert.equal(mode, "PX");
    writes.push({ key, value, ttl });
    receipts.set(key, value);
    return "OK";
  });
  const text = "Хөтөлбөрийн эх сурвалжид байгаа бүх мэдээлэл. ".repeat(140);
  const accepted: string[] = [];
  let calls = 0;
  try {
    await assert.rejects(deliverMessengerText("private-fixture-customer", text, async part => {
      if (++calls === 2) throw new Error("fixture delivery interruption");
      accepted.push(part);
    }, "private-fixture-event"), /fixture delivery interruption/);
    assert.equal(accepted.length, 1);
    assert.equal(receipts.size, 1);
    assert.ok(writes.every(write => write.ttl === 86_400_000 && /^webhook:text_parts:[a-f0-9]{64}$/.test(write.key)));
    assert.equal([...receipts.values()][0], "1");
    resetRedisStateForTests();
    await deliverMessengerText("private-fixture-customer", text, async part => { accepted.push(part); }, "private-fixture-event");
    assert.equal(accepted.join(""), text);
    await deliverMessengerText("private-fixture-customer", text, async () => { assert.fail("accepted parts must not replay"); }, "private-fixture-event");
    assert.ok(!JSON.stringify([...receipts]).includes("private-fixture"), "durable receipt exposes no event, customer or message text");
  } finally {
    resetRedisStateForTests();
    env.redisStateEnabled = false;
    env.redisReplayEnabled = false;
  }
});
