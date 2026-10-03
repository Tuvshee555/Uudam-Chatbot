import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

applyTestEnv();
const modules = Promise.all([
  import("../src/lib/webhookMedia"),
  import("../src/lib/observability"),
]);
const fallbackText = "Уучлаарай, мессеж илгээхэд алдаа гарлаа.";

for (const scenario of [
  { name: "Facebook primary success", platform: "facebook", statuses: [200], result: true, outcome: "primary_sent" },
  { name: "Instagram primary success", platform: "instagram", statuses: [200], result: true, outcome: "primary_sent" },
  { name: "fallback success preserves false result", platform: "facebook", statuses: [400, 200], result: false, outcome: "fallback_sent" },
  { name: "Instagram fallback failure", platform: "instagram", statuses: [400, 400], result: false, outcome: "fallback_failed" },
  { name: "fallback disabled", platform: "facebook", statuses: [400], result: false, outcome: "primary_failed", allowFallback: false },
  { name: "fallback text never recurses", platform: "facebook", statuses: [400], result: false, outcome: "primary_failed", text: fallbackText },
] as const) {
  test(`sendPlatformMessage metrics: ${scenario.name}`, async (context) => {
    const [{ sendPlatformMessage }, { getMetricsSnapshot }] = await modules;
    const platform = scenario.platform;
    const counter = (name: string, outcome?: string) => getMetricsSnapshot().counters.find((entry) =>
      entry.name === `webhook.send.${name}` && entry.tags.platform === platform &&
      (outcome === undefined || entry.tags.outcome === outcome),
    )?.value ?? 0;
    const histogram = () => getMetricsSnapshot().histograms.find((entry) =>
      entry.name === "webhook.send.latency_ms" && entry.tags.platform === platform && entry.tags.outcome === scenario.outcome,
    );
    const names = ["attempted_total", "success_total", "failed_total", "fallback_attempted_total", "fallback_success_total", "fallback_failed_total"];
    const before = Object.fromEntries(names.map((name) => [name, counter(name)]));
    const beforeOutcome = counter("delivery_total", scenario.outcome);
    const beforeLatency = { count: histogram()?.count ?? 0, sum: histogram()?.sum ?? 0 };
    let now = 1000;
    const messages: Array<{ message: { text: string } }> = [];
    context.mock.method(Date, "now", () => now);
    context.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
      const status = scenario.statuses[messages.length];
      assert.ok(status, "unexpected extra send");
      messages.push(JSON.parse(String(init.body)));
      now += 25;
      return new Response(JSON.stringify(status === 200 ? { message_id: "accepted" } : { error: { message: "rejected" } }), { status });
    });
    const text = ("text" in scenario ? scenario.text : undefined) ?? "Travel reply";
    const result = await sendPlatformMessage(platform, "test-sender", text, "test-token", "test-page", "test-ig", undefined,
      "allowFallback" in scenario ? { allowFallback: scenario.allowFallback } : undefined);
    assert.equal(result, scenario.result);
    assert.equal(messages.length, scenario.statuses.length);
    assert.equal(messages[0].message.text, text);
    if (messages.length === 2) assert.equal(messages[1].message.text, fallbackText);
    assert.equal(counter("attempted_total") - before.attempted_total, 1);
    assert.equal(counter("success_total") - before.success_total, scenario.result ? 1 : 0);
    assert.equal(counter("failed_total") - before.failed_total, scenario.result ? 0 : 1);
    assert.equal(counter("fallback_attempted_total") - before.fallback_attempted_total, messages.length === 2 ? 1 : 0);
    assert.equal(counter("fallback_success_total") - before.fallback_success_total, scenario.outcome === "fallback_sent" ? 1 : 0);
    assert.equal(counter("fallback_failed_total") - before.fallback_failed_total, scenario.outcome === "fallback_failed" ? 1 : 0);
    assert.equal(counter("delivery_total", scenario.outcome) - beforeOutcome, 1);
    assert.equal(histogram()!.count - beforeLatency.count, 1);
    assert.equal(histogram()!.sum - beforeLatency.sum, 25 * messages.length);
  });
}

test("missing tokens record outcomes and latency without attempting transport", async (context) => {
  const [{ sendPlatformMessage }, { getMetricsSnapshot }] = await modules;
  const count = (name: string) => getMetricsSnapshot().counters.find((entry) => entry.name === `webhook.send.${name}` && entry.tags.platform === "facebook")?.value ?? 0;
  const beforeMissing = count("missing_token_total");
  const beforeAttempts = count("attempted_total");
  context.mock.method(globalThis, "fetch", async () => { assert.fail("missing token must not send"); });
  for (const token of [undefined, null, ""]) {
    assert.equal(await sendPlatformMessage("facebook", "test-sender", "Travel reply", token, "test-page"), false);
  }
  assert.equal(count("missing_token_total") - beforeMissing, 3);
  assert.equal(count("attempted_total"), beforeAttempts);
  const latency = getMetricsSnapshot().histograms.find((entry) => entry.name === "webhook.send.latency_ms" && entry.tags.platform === "facebook" && entry.tags.outcome === "missing_token");
  assert.equal(latency?.count, 3);
});

test("album, trip media and typing helpers accept nullable tokens without transport", async (context) => {
  const [{ sendPhotoAlbum, sendTripMediaForReply, sendFacebookTypingIndicator }] = await modules;
  context.mock.method(globalThis, "fetch", async () => { assert.fail("missing token must not send"); });
  await sendPhotoAlbum("test-sender", ["https://example.com/photo.jpg"]);
  await sendPhotoAlbum("test-sender", ["https://example.com/photo.jpg"], null);
  await sendTripMediaForReply("facebook", "test-sender", "Surmak Felmor", "Surmak Felmor photos", null, "test-page");
  await sendFacebookTypingIndicator("test-sender", null, "test-page");
});
