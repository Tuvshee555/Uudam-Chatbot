import assert from "node:assert/strict";
import test from "node:test";
import Redis from "ioredis";
import { applyTestEnv } from "./helpers/env";
import type { PendingConversationPayload } from "../src/lib/webhookDedup";
import { sharedMap } from "../src/lib/processState";

applyTestEnv({ WEBHOOK_MAX_PENDING_CONVERSATIONS: "100" });
let getEnv: typeof import("../src/lib/env").getEnv;
let queue: typeof import("../src/lib/webhookDedup");
let resetRedisStateForTests: typeof import("../src/lib/redisState").resetRedisStateForTests;
test.before(async () => {
  ({ getEnv } = await import("../src/lib/env"));
  queue = await import("../src/lib/webhookDedup");
  ({ resetRedisStateForTests } = await import("../src/lib/redisState"));
});
const payload = (text: string): PendingConversationPayload => ({
  platform: "instagram", senderId: "sender", pageId: "page", igUserId: "ig",
  text, token: "secret-token", trace: { requestId: "req", correlationId: "corr" },
});

for (const backend of ["memory", "redis"] as const) {
  test(`${backend}: pending queue preserves FIFO, privacy and retryable heads`, async (t) => {
    queue.resetWebhookStateForTests();
    const env = getEnv();
    env.redisConversationEnabled = backend === "redis";
    env.redisStateEnabled = backend === "redis";
    env.redisUrl = "redis://127.0.0.1:6379";
    const lists = new Map<string, string[]>();
    let unavailable = false;
    if (backend === "redis") {
      t.mock.method(Redis.prototype, "connect", async function (this: Redis) {
        this.status = "ready";
      });
      t.mock.method(Redis.prototype, "disconnect", () => {});
      t.mock.method(Redis.prototype, "lindex", async (key: string) => {
        if (unavailable) throw new Error("offline");
        return lists.get(key)?.[0] ?? null;
      });
      t.mock.method(Redis.prototype, "lpop", async (key: string) => lists.get(key)?.shift() ?? null);
      t.mock.method(Redis.prototype, "eval", async (script: string, numKeys: number, key: string, ...args: string[]) => {
        if (unavailable) throw new Error("offline");
        assert.equal(numKeys, 1);
        assert.doesNotMatch(script, /LTRIM|PEXPIRE/i);
        const list = lists.get(key) ?? [];
        if (script.includes("RPUSH")) {
          assert.match(script, /LLEN/);
          assert.match(script, /LRANGE/);
          assert.ok(script.indexOf("payload.eventKey") < script.indexOf('redis.call("LLEN"'));
          if (args[2] && list.some((raw) => {
            const parsed = JSON.parse(raw);
            return (parsed.payload ?? parsed).eventKey === args[2];
          })) return 2;
          if (list.length >= Number(args[0])) return 0;
          list.push(args[1]);
          lists.set(key, list);
          return 1;
        }
        assert.match(script, /LINDEX/);
        assert.match(script, /LPOP/);
        if (list[0] !== args[0]) return 0;
        list.shift();
        return 1;
      });
    }
    try {
      const incoming = payload("0");
      incoming.eventKey = "event-first";
      await queue.enqueuePendingConversationConsistent("fifo", incoming);
      assert.equal(incoming.token, "secret-token");
      incoming.text = "caller changed";
      incoming.trace!.requestId = "caller changed";
      for (let i = 1; i < queue.MAX_PENDING_PER_CONVERSATION; i++) {
        await queue.enqueuePendingConversationConsistent("fifo", payload(String(i)));
      }
      await assert.rejects(queue.enqueuePendingConversationConsistent("fifo", payload("overflow")), queue.RetryableWebhookError);
      await queue.enqueuePendingConversationConsistent("fifo", { ...payload("retry-first"), eventKey: "event-first" });
      if (backend === "redis") {
        const persisted = lists.get("webhook:conversation_pending:fifo")!;
        assert.equal(persisted.length, queue.MAX_PENDING_PER_CONVERSATION);
        for (const raw of persisted) {
          assert.equal(JSON.parse(raw).payload.token, null);
          assert.ok(!raw.includes("secret-token"));
        }
      } else {
        const persisted = sharedMap<string, import("../src/lib/webhookDedup").PendingEnvelope[]>(
          "webhook_dedup.pending_conversations",
        ).get("fifo")!;
        assert.equal(persisted.length, queue.MAX_PENDING_PER_CONVERSATION);
        for (const envelope of persisted) assert.equal(envelope.payload.token, null);
      }
      const first = await queue.peekPendingConversationConsistent("fifo");
      assert.ok(first);
      assert.equal(first.payload.token, null);
      assert.equal(first.payload.text, "0");
      assert.equal(first.payload.platform, "instagram");
      assert.equal(first.payload.pageId, "page");
      assert.equal(first.payload.igUserId, "ig");
      assert.equal(first.payload.trace?.requestId, "req");
      await assert.rejects(async () => {
        const head = await queue.peekPendingConversationConsistent("fifo");
        assert.ok(head);
        const processMessage = async (message: PendingConversationPayload) => {
          assert.equal(message.text, "0");
          throw new Error("processing failed");
        };
        await processMessage(head.payload);
        await queue.acknowledgePendingConversationConsistent("fifo", head);
      }, /processing failed/);
      assert.deepEqual(await queue.peekPendingConversationConsistent("fifo"), first);
      first.payload.text = "consumer changed";
      first.payload.trace!.requestId = "consumer changed";
      assert.equal((await queue.peekPendingConversationConsistent("fifo"))?.payload.text, "0");
      assert.equal((await queue.peekPendingConversationConsistent("fifo"))?.payload.trace?.requestId, "req");
      assert.equal(await queue.acknowledgePendingConversationConsistent("fifo", { ...first, receipt: "wrong" }), false);
      for (let i = 0; i < queue.MAX_PENDING_PER_CONVERSATION; i++) {
        const head = await queue.peekPendingConversationConsistent("fifo");
        assert.ok(head);
        assert.equal(head.payload.text, String(i));
        assert.equal(await queue.acknowledgePendingConversationConsistent("fifo", head), true);
        assert.equal(await queue.acknowledgePendingConversationConsistent("fifo", head), false);
      }
      assert.equal(await queue.peekPendingConversationConsistent("fifo"), null);
      for (let i = 0; i < 2; i++) await queue.enqueuePendingConversationConsistent("identical", payload("same"));
      const old = await queue.peekPendingConversationConsistent("identical");
      assert.ok(old);
      assert.equal(await queue.acknowledgePendingConversationConsistent("identical", old), true);
      assert.equal(await queue.acknowledgePendingConversationConsistent("identical", old), false);
      assert.equal((await queue.drainPendingConversationConsistent("identical"))?.token, null);
      assert.equal(await queue.drainPendingConversationConsistent("identical"), null);
      const attempts = await Promise.allSettled(Array.from(
        { length: queue.MAX_PENDING_PER_CONVERSATION + 5 },
        (_, i) => queue.enqueuePendingConversationConsistent("concurrent", payload(String(i))),
      ));
      assert.equal(attempts.filter((attempt) => attempt.status === "fulfilled").length, queue.MAX_PENDING_PER_CONVERSATION);
      for (const attempt of attempts) {
        if (attempt.status === "rejected") assert.ok(attempt.reason instanceof queue.RetryableWebhookError);
      }
      const concurrentHead = await queue.peekPendingConversationConsistent("concurrent");
      assert.ok(concurrentHead);
      assert.deepEqual(await Promise.all([
        queue.acknowledgePendingConversationConsistent("concurrent", concurrentHead),
        queue.acknowledgePendingConversationConsistent("concurrent", concurrentHead),
      ]), [true, false]);
      await queue.enqueuePendingConversationConsistent("concurrent", payload("replacement"));
      for (let i = 1; i < queue.MAX_PENDING_PER_CONVERSATION; i++) {
        assert.equal((await queue.drainPendingConversationConsistent("concurrent"))?.text, String(i));
      }
      assert.equal((await queue.drainPendingConversationConsistent("concurrent"))?.text, "replacement");
      const event = { ...payload("retryable-event"), eventKey: "event-behind-head" };
      await queue.enqueuePendingConversationConsistent("retry", payload("older-head"));
      await Promise.all(Array.from({ length: 5 }, () => queue.enqueuePendingConversationConsistent("retry", event)));
      assert.equal((await queue.drainPendingConversationConsistent("retry"))?.text, "older-head");
      assert.equal((await queue.drainPendingConversationConsistent("retry"))?.text, "retryable-event");
      assert.equal(await queue.drainPendingConversationConsistent("retry"), null);
      if (backend === "redis") {
        lists.set("webhook:conversation_pending:legacy", [JSON.stringify(payload("legacy"))]);
        const legacy = await queue.peekPendingConversationConsistent("legacy");
        assert.ok(legacy);
        assert.equal(legacy.payload.token, null);
        assert.equal(await queue.acknowledgePendingConversationConsistent("legacy", legacy), true);
        unavailable = true;
        for (const operation of [
          () => queue.enqueuePendingConversationConsistent("offline", payload("x")),
          () => queue.peekPendingConversationConsistent("offline"),
          () => queue.acknowledgePendingConversationConsistent("offline", old),
        ]) await assert.rejects(operation(), queue.RetryableWebhookError);
        assert.equal(queue.getWebhookRuntimeDiagnostics().pendingMessages, 0);
      }
    } finally {
      resetRedisStateForTests();
      queue.resetWebhookStateForTests();
      env.redisConversationEnabled = false;
      env.redisStateEnabled = false;
    }
  });
}

test("memory: global overflow rejects without evicting another conversation", async () => {
  queue.resetWebhookStateForTests();
  for (let i = 0; i < queue.MAX_PENDING_CONVERSATIONS; i++) {
    await queue.enqueuePendingConversationConsistent(`global-${i}`, { ...payload(String(i)), eventKey: `event-${i}` });
  }
  await queue.enqueuePendingConversationConsistent("global-0", { ...payload("retry"), eventKey: "event-0" });
  await assert.rejects(queue.enqueuePendingConversationConsistent("overflow", payload("rejected")), queue.RetryableWebhookError);
  assert.equal(queue.getWebhookRuntimeDiagnostics().pendingMessages, queue.MAX_PENDING_CONVERSATIONS);
  for (let i = 0; i < queue.MAX_PENDING_CONVERSATIONS; i++) {
    assert.equal((await queue.drainPendingConversationConsistent(`global-${i}`))?.text, String(i));
  }
  assert.equal(queue.getWebhookRuntimeDiagnostics().pendingMessages, 0);
  await queue.enqueuePendingConversationConsistent("overflow", payload("accepted"));
  assert.equal((await queue.drainPendingConversationConsistent("overflow"))?.text, "accepted");
  queue.resetWebhookStateForTests();
});
