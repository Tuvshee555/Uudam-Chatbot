import assert from "node:assert/strict";
import test from "node:test";
import Redis from "ioredis";
import { applyTestEnv } from "./helpers/env";

applyTestEnv();
let webhook: typeof import("../src/lib/webhookDedup");
let getEnv: typeof import("../src/lib/env").getEnv;
let resetRedisStateForTests: typeof import("../src/lib/redisState").resetRedisStateForTests;
let getMetricsSnapshot: typeof import("../src/lib/observability").getMetricsSnapshot;
test.before(async () => {
  ({ getEnv } = await import("../src/lib/env"));
  webhook = await import("../src/lib/webhookDedup");
  ({ resetRedisStateForTests } = await import("../src/lib/redisState"));
  ({ getMetricsSnapshot } = await import("../src/lib/observability"));
});

function completionCount(platform: string) {
  return getMetricsSnapshot().counters.find((counter) =>
    counter.name === "webhook.event_completed_total" && counter.tags.platform === platform,
  )?.value ?? 0;
}

for (const backend of ["memory", "redis"] as const) {
  test(`${backend}: event checkpoints and recovery`, async (t) => {
    const env = getEnv();
    env.redisStateEnabled = backend === "redis";
    env.redisReplayEnabled = backend === "redis";
    env.redisConversationEnabled = false;
    env.redisUrl = "redis://127.0.0.1:6379";
    webhook.resetWebhookStateForTests();
    const values = new Map<string, string>();
    let completeCalls = 0;
    let releaseCalls = 0;
    let pipelineFailure = false;
    if (backend === "redis") {
      t.mock.method(Redis.prototype, "connect", async function (this: Redis) {
        this.status = "ready";
      });
      t.mock.method(Redis.prototype, "disconnect", () => {});
      t.mock.method(Redis.prototype, "exists", async (key: string) => values.has(key) ? 1 : 0);
      t.mock.method(Redis.prototype, "set", async (key: string, value: string) => {
        if (values.has(key)) return null;
        values.set(key, value);
        return "OK";
      });
      t.mock.method(Redis.prototype, "eval", async (_script: string, _numKeys: number, key: string, token: string) => {
        releaseCalls++;
        if (values.get(key) !== token) return 0;
        values.delete(key);
        return 1;
      });
      t.mock.method(Redis.prototype, "pipeline", () => {
        let completedKey = "";
        let completedValue = "";
        let processingKey = "";
        let claimToken = "";
        const pipeline = {
          set(key: string, value: string) {
            completedKey = key;
            completedValue = value;
            return pipeline;
          },
          eval(_script: string, _numKeys: number, key: string, token: string) {
            processingKey = key;
            claimToken = token;
            return pipeline;
          },
          async exec() {
            completeCalls++;
            if (pipelineFailure) return [[new Error("SET failed"), null], [null, 0]];
            values.set(completedKey, completedValue);
            if (values.get(processingKey) === claimToken) values.delete(processingKey);
            return [[null, "OK"], [null, 1]];
          },
        };
        return pipeline as unknown as ReturnType<Redis["pipeline"]>;
      });
    }
    try {
      await t.test("checkpoint retains completion after queued failure; retry only recovers pending", async () => {
        const tags = { platform: `${backend}-checkpoint`, eventType: "dm" as const };
        const before = completionCount(tags.platform);
        let initialDeliveries = 0;
        let recoveries = 0;
        await webhook.enqueuePendingConversationConsistent("conversation", {
          platform: "facebook", senderId: "sender", pageId: "page", text: "retained",
        });
        await assert.rejects(webhook.runEventWithClaim("initial", tags, async (complete) => {
          initialDeliveries++;
          await Promise.all([complete(), complete()]);
          await complete();
          throw new Error("queued handling failed");
        }), webhook.RetryableWebhookError);
        assert.equal(completionCount(tags.platform), before + 1);
        if (backend === "redis") {
          assert.equal(completeCalls, 1);
          assert.equal(releaseCalls, 0);
        }
        await webhook.runEventWithClaim("initial", tags, async () => {
          initialDeliveries++;
        }, async () => {
          recoveries++;
          const head = await webhook.peekPendingConversationConsistent("conversation");
          assert.ok(head);
          assert.equal(head.payload.text, "retained");
          assert.equal(await webhook.acknowledgePendingConversationConsistent("conversation", head), true);
        });
        assert.equal(initialDeliveries, 1);
        assert.equal(recoveries, 1);
        assert.equal(await webhook.peekPendingConversationConsistent("conversation"), null);
        assert.equal(completionCount(tags.platform), before + 1);
      });

      await t.test("no-argument tasks auto-complete; completed events without recovery stay skipped", async () => {
        const tags = { platform: `${backend}-legacy`, eventType: "feed" as const };
        const before = completionCount(tags.platform);
        let calls = 0;
        let recoveryCalls = 0;
        await webhook.runEventWithClaim("legacy", tags, async () => { calls++; }, async () => { recoveryCalls++; });
        await webhook.runEventWithClaim("legacy", tags, async () => { calls++; });
        assert.equal(calls, 1);
        assert.equal(recoveryCalls, 0);
        assert.equal(completionCount(tags.platform), before + 1);
      });

      await t.test("checkpoint and automatic completion share one completion", async () => {
        const tags = { platform: `${backend}-automatic`, eventType: "dm" as const };
        const before = completionCount(tags.platform);
        const beforeCalls = completeCalls;
        await webhook.runEventWithClaim("automatic", tags, async (complete) => {
          await Promise.all([complete(), complete()]);
        });
        assert.equal(completionCount(tags.platform), before + 1);
        if (backend === "redis") assert.equal(completeCalls, beforeCalls + 1);
      });

      await t.test("failure before checkpoint releases the claim for retry", async () => {
        const tags = { platform: `${backend}-uncompleted`, eventType: "dm" as const };
        const before = completionCount(tags.platform);
        const beforeReleases = releaseCalls;
        await assert.rejects(webhook.runEventWithClaim("uncompleted", tags, async () => {
          throw new Error("initial failed");
        }), webhook.RetryableWebhookError);
        assert.equal(completionCount(tags.platform), before);
        if (backend === "redis") assert.equal(releaseCalls, beforeReleases + 1);
        let calls = 0;
        await webhook.runEventWithClaim("uncompleted", tags, async () => { calls++; });
        assert.equal(calls, 1);
        assert.equal(completionCount(tags.platform), before + 1);
      });

      await t.test("in-progress claims invoke neither task nor recovery", async () => {
        const claim = await webhook.claimEventForProcessingConsistent("busy");
        assert.equal(claim.state, "acquired");
        let calls = 0;
        await webhook.runEventWithClaim("busy", { platform: backend, eventType: "dm" },
          async () => { calls++; }, async () => { calls++; });
        assert.equal(calls, 0);
        await claim.release();
      });

      await t.test("recovery failure remains retryable without replaying initial handling", async () => {
        const tags = { platform: `${backend}-recovery`, eventType: "dm" as const };
        await webhook.runEventWithClaim("recovery", tags, async () => {});
        let calls = 0;
        await assert.rejects(webhook.runEventWithClaim("recovery", tags, async () => { calls++; }, async () => {
          throw new Error("recovery failed");
        }), webhook.RetryableWebhookError);
        await webhook.runEventWithClaim("recovery", tags, async () => { calls++; }, async () => { calls++; });
        assert.equal(calls, 1);
      });

      if (backend === "redis") {
        await t.test("Redis pipeline command errors do not record a successful checkpoint", async () => {
          pipelineFailure = true;
          const tags = { platform: "redis-completion-failure", eventType: "dm" as const };
          const before = completionCount(tags.platform);
          await assert.rejects(webhook.runEventWithClaim("completion-failure", tags, async (complete) => {
            await complete();
          }), webhook.RetryableWebhookError);
          assert.equal(completionCount(tags.platform), before);
          assert.equal(values.has("webhook:processed_event:completion-failure"), false);
        });
      }
    } finally {
      resetRedisStateForTests();
      webhook.resetWebhookStateForTests();
      env.redisReplayEnabled = false;
      env.redisStateEnabled = false;
    }
  });
}
