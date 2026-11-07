import assert from "node:assert/strict";
import test from "node:test";
import "./helpers/catalogueEnv";
import { applyTestEnv } from "./helpers/env";
import { fakeMeta, fakeSendStore, makeVersion, noDrift, publicUrlOf, SITE, DAY } from "./helpers/catalogueSendFakes";
import {
  CATALOGUE_STAFF_WILL_SEND_TEXT, catalogueCaption, catalogueEditionOfCaption, catalogueLinkFollowupText, catalogueLinkOnlyText, catalogueRepeatText, catalogueStaleText,
  groupQuoteText, tripCodeAckText,
} from "../src/lib/catalogue/messages";
import { checkLiveDrift, evaluateFreshness, resetFreshnessCacheForTests, type DriftDeps } from "../src/lib/catalogue/freshness";
import type { CatalogueSnapshot } from "../src/lib/catalogue/types";
import {
  MESSAGING_WINDOW_MS, REPEAT_ANSWERED_REASON, REPEAT_FOLLOWUP_REASON, deliverCatalogue, planCatalogueDelivery, sendCatalogueTest, testRecipientAllowlist,
  type DeliverCatalogueInput, type GateVerdict, type SendDeps,
} from "../src/lib/catalogue/send";
import { buildFbFileMessageBody, classifyFbFailure } from "../src/lib/fbAttachmentUpload";
import { presentAssistantReply } from "../src/lib/chatbotReplyPolicy";
import { shouldSilenceNoDataReply } from "../src/lib/reply";
import { RetryableWebhookError } from "../src/lib/webhookDedup";
import { StaffTakeoverSendBlocked } from "../src/lib/takeoverGuard";
import { TESTER_WINDOW_MS, type TesterLookup, type TesterSendTarget } from "../src/lib/catalogue/testers";

const NOW = Date.parse("2098-02-01T04:00:00Z");

/** One send, wired to fakes. `timeline` records every customer-visible thing in order. */
function harness(options: { gate?: GateVerdict; pageGate?: GateVerdict; kill?: boolean; drift?: SendDeps["checkDrift"]; url?: boolean; assertMaySend?: SendDeps["assertMaySend"]; now?: number } = {}) {
  const now = options.now ?? NOW;
  let clock = now; // moves with advance(): a customer who asks again minutes later
  const stored = fakeSendStore(() => clock);
  const meta = fakeMeta();
  const timeline: string[] = [];
  const texts: string[] = [];
  const leads: Array<{ status: string; reason: string; context: string }> = [];
  const recorded: { files: string[]; outbound: string[] } = { files: [], outbound: [] };
  const deps: Partial<SendDeps> = {
    now: () => new Date(clock), store: stored.store, gate: async () => options.gate ?? null, pageGate: async () => options.pageGate ?? null, killSwitch: () => Boolean(options.kill),
    checkDrift: options.drift ?? noDrift,
    upload: async (...args) => { timeline.push("upload"); return meta.deps.upload(...args); },
    sendFile: async (...args) => { timeline.push("file"); return meta.deps.sendFile(...args); },
    sendDirectText: async (_recipient, text) => { timeline.push("text"); texts.push(text); return true; },
    assertMaySend: options.assertMaySend ?? (async () => {}),
    recordFile: async (_sender, url) => { recorded.files.push(url); },
    recordOutbound: async (mid) => { recorded.outbound.push(mid); },
    publicFileUrl: (token) => (options.url === false ? "" : publicUrlOf(token)),
    websiteUrl: () => "https://site.example.test",
  };
  const request = (extra: Partial<DeliverCatalogueInput> = {}): DeliverCatalogueInput => ({
    senderId: "psid-1", pageId: "page-1", pageToken: "token-1", edition: "quick", explicitResend: false, lastInboundAt: now - 60_000, deps,
    captureLead: async (lead) => { leads.push(lead); }, customerText: "байгууллагын аялал", dedupeKey: "mid-1", ...extra,
  });
  return { stored, meta, timeline, texts, leads, recorded, deps, request, now, advance: (ms: number) => { clock += ms; } };
}

test("customer copy is short, plain Mongolian, promises nothing and survives the bot's own no-data filter", () => {
  const texts = [catalogueCaption("quick"), catalogueCaption("complete"), catalogueLinkOnlyText("quick", publicUrlOf("t")), catalogueLinkFollowupText(publicUrlOf("t")),
    CATALOGUE_STAFF_WILL_SEND_TEXT, catalogueStaleText("https://site.example.test"), groupQuoteText({ groupSize: null, month: null }), groupQuoteText({ groupSize: 20, month: 3 }),
    tripCodeAckText({ code: "A01", title: "ТЕСТ-ДАЛАЙ АЯЛАЛ", groupSize: 25, month: 1 }), tripCodeAckText({ code: "A02", title: "ЖИШИГ-ХӨДӨӨ", groupSize: null, month: null }),
    catalogueRepeatText({ url: publicUrlOf("t"), linkOnly: false }), catalogueRepeatText({ url: "", linkOnly: false }), catalogueRepeatText({ url: publicUrlOf("t"), linkOnly: true })];
  for (const text of texts) {
    assert.doesNotMatch(text, /\p{Extended_Pictographic}/u, `no emoji: ${text}`);
    assert.doesNotMatch(text, /баталгаатай|баталгаажсан|захиалга баталгаажлаа|суудал (?:бий|байна)|үнэ \d|хямдрал|мөнгө төл/i, `no promise: ${text}`);
    assert.equal(shouldSilenceNoDataReply(text), false, `the no-data filter would silence: ${text}`);
    assert.equal(presentAssistantReply({ reply: text, userText: "каталог явуул", hasPriorReply: false }), text, `the reply policy must not rewrite: ${text}`);
    assert.ok(text.length <= 420, `short: ${text.length}`);
  }
  assert.equal(catalogueEditionOfCaption(catalogueCaption("quick")), "quick");
  assert.equal(catalogueEditionOfCaption(catalogueCaption("complete")), "complete");
  assert.equal(catalogueEditionOfCaption("ямар нэг текст"), null);
  assert.match(catalogueCaption("quick"), /PDF/);
  assert.match(catalogueCaption("quick"), /код/);
});

test("freshness: age over 21 days or a drifted live comparison is stale; an unreadable comparison is only unverified", () => {
  const nowIso = new Date(NOW).toISOString();
  const published = (days: number) => ({ generatedAt: new Date(NOW - days * DAY).toISOString() });
  assert.equal(evaluateFreshness({ published: published(2), nowIso, drift: { drifted: false, reasons: [] } }).state, "fresh");
  assert.equal(evaluateFreshness({ published: published(21), nowIso, drift: { drifted: false, reasons: [] } }).state, "fresh", "exactly 21 days is still fine");
  const old = evaluateFreshness({ published: published(22), nowIso, drift: { drifted: false, reasons: [] } });
  assert.deepEqual([old.state, old.code, old.stale], ["stale", "age", true]);
  const drifted = evaluateFreshness({ published: published(1), nowIso, drift: { drifted: true, reasons: ["ТЕСТ-ДАЛАЙ — үнэ өөрчлөгдсөн"] } });
  assert.deepEqual([drifted.state, drifted.code, drifted.reasons], ["stale", "drift", ["ТЕСТ-ДАЛАЙ — үнэ өөрчлөгдсөн"]]);
  const unverified = evaluateFreshness({ published: published(1), nowIso, drift: null });
  assert.deepEqual([unverified.state, unverified.stale, unverified.code], ["unverified", false, "unverified"]);
  assert.equal(evaluateFreshness({ published: { generatedAt: "not a date" }, nowIso, drift: null }).stale, true);
  assert.equal(evaluateFreshness({ published: published(30), nowIso, drift: null, maxAgeDays: 45 }).state, "unverified");
});

test("the live comparison is cached briefly and a failure is 'unknown', never 'stale'", async () => {
  resetFreshnessCacheForTests();
  let reads = 0;
  const snapshot = { trips: [{ tripId: "t1" }] } as unknown as CatalogueSnapshot;
  const deps: DriftDeps = {
    getVersionSnapshot: async () => { reads += 1; return snapshot; },
    loadLiveSnapshot: async (_edition, ids) => { assert.deepEqual(ids, ["t1"], "the same trips the file prints"); return snapshot; },
    liveDrift: () => ({ drifted: true, reasons: ["x"] }),
  };
  let clock = NOW;
  const first = await checkLiveDrift({ id: "v1", edition: "quick" }, new Date(NOW).toISOString(), deps, () => clock);
  clock += 60_000;
  await checkLiveDrift({ id: "v1", edition: "quick" }, new Date(NOW).toISOString(), deps, () => clock);
  assert.equal(first?.drifted, true);
  assert.equal(reads, 1, "second call inside five minutes is cached");
  resetFreshnessCacheForTests();
  const failing = await checkLiveDrift({ id: "v2", edition: "quick" }, new Date(NOW).toISOString(), { ...deps, loadLiveSnapshot: async () => { throw new Error("db down"); } }, () => clock);
  assert.equal(failing, null);
});

test("plan: nothing may happen outside the 24-hour window, with the kill switch on, when a person owns the chat or nothing is published", async () => {
  const ok = harness(); ok.stored.publish(makeVersion());
  assert.equal((await planCatalogueDelivery(ok.request())).ready, true);

  const late = harness(); late.stored.publish(makeVersion());
  const closed = await planCatalogueDelivery(late.request({ lastInboundAt: NOW - 25 * 3_600_000 }));
  assert.deepEqual(closed.ready === false && [closed.status, closed.reason], ["blocked_window", "outside_24h_window"]);
  const unknown = await planCatalogueDelivery(late.request({ lastInboundAt: null }));
  assert.equal(unknown.ready === false && unknown.status, "blocked_window");

  const killed = harness({ kill: true }); killed.stored.publish(makeVersion());
  const blockedByKill = await planCatalogueDelivery(killed.request());
  assert.equal(blockedByKill.ready === false && blockedByKill.status, "blocked_killswitch");
  assert.equal((await planCatalogueDelivery(killed.request({ dryRun: true }))).ready, true, "a dry run shows what WOULD be sent");

  const owned = harness({ gate: { status: "blocked_staff_owned", reason: "operator_reply" } }); owned.stored.publish(makeVersion());
  const staff = await planCatalogueDelivery(owned.request());
  assert.deepEqual(staff.ready === false && [staff.status, staff.reason], ["blocked_staff_owned", "operator_reply"]);
  const paused = harness({ gate: { status: "blocked_paused", reason: "photo_only" } }); paused.stored.publish(makeVersion());
  const pausedPlan = await planCatalogueDelivery(paused.request());
  assert.equal(pausedPlan.ready === false && pausedPlan.status, "blocked_paused");

  const none = harness();
  const missing = await planCatalogueDelivery(none.request());
  assert.deepEqual(missing.ready === false && [missing.status, missing.reason], ["no_published_version", "none_published"]);

  const stale = harness(); stale.stored.publish(makeVersion({ generatedAt: new Date(NOW - 30 * DAY).toISOString() }));
  const old = await planCatalogueDelivery(stale.request());
  assert.deepEqual(old.ready === false && [old.status, old.reason], ["stale_fallback", "stale:age"]);
  const drift = harness({ drift: async () => ({ drifted: true, reasons: ["ЖИШИГ-ХӨДӨӨ — одоо захиалгад нээлттэй биш"] }) }); drift.stored.publish(makeVersion());
  const changed = await planCatalogueDelivery(drift.request());
  assert.deepEqual(changed.ready === false && [changed.status, changed.reason], ["stale_fallback", "stale:drift"]);
  const unverified = harness({ drift: async () => null }); unverified.stored.publish(makeVersion());
  assert.equal((await planCatalogueDelivery(unverified.request())).ready, true, "an unreadable comparison does not silence the bot");
});

test("a clean send is ONE text then ONE file, by the cached attachment id, with Meta's message id logged", async () => {
  const run = harness();
  const version = run.stored.publish(makeVersion());
  run.stored.cacheAttachment(version.id, "page-1", "att-cached");
  const outcome = await deliverCatalogue(run.request());
  assert.deepEqual([outcome.status, outcome.fileAccepted, outcome.versionId, outcome.reason], ["sent", true, version.id, null]);
  assert.match(outcome.metaMessageId || "", /^m_file_/);
  assert.deepEqual(run.timeline, ["text", "file"], "caption first, then the one file");
  assert.equal(run.texts.length, 1);
  assert.equal(run.texts[0], catalogueCaption("quick"));
  assert.equal(run.meta.files.length, 1);
  assert.deepEqual(run.meta.files[0], { recipientId: "psid-1", attachmentId: "att-cached", token: "token-1" });
  assert.equal(run.meta.uploads.length, 0, "a cached id needs no upload");
  assert.deepEqual(run.recorded.outbound, [outcome.metaMessageId], "the file is recognised as the bot's own message");
  assert.deepEqual(run.recorded.files, [publicUrlOf(version.publicToken)]);
  const row = run.stored.last()!;
  assert.deepEqual([row.status, row.metaMessageId, row.retries], ["sent", outcome.metaMessageId, 0]);
  assert.equal(run.leads.length, 0, "a clean send needs no staff lead");
});

test("without a cached id the bytes are uploaded BEFORE the caption and the id is cached for the next customer", async () => {
  const run = harness();
  const version = run.stored.publish(makeVersion());
  const outcome = await deliverCatalogue(run.request());
  assert.equal(outcome.status, "sent");
  assert.deepEqual(run.timeline, ["upload", "text", "file"]);
  assert.equal(run.meta.uploads[0].fileName, version.fileName);
  assert.equal(run.stored.cached(version.id, "page-1"), "att-1");
  const second = await deliverCatalogue(run.request({ senderId: "psid-2", dedupeKey: "mid-2" }));
  assert.equal(second.status, "sent");
  assert.equal(run.meta.uploads.length, 1, "uploaded once for everyone");
  assert.equal(run.meta.files[1].attachmentId, "att-1");
});

test("a cached id Meta rejects is uploaded again once, then the send succeeds", async () => {
  const run = harness();
  const version = run.stored.publish(makeVersion());
  run.stored.cacheAttachment(version.id, "page-1", "att-stale");
  run.meta.rejectAttachmentOnce();
  const outcome = await deliverCatalogue(run.request());
  assert.equal(outcome.status, "sent");
  assert.equal(outcome.fileAccepted, true);
  assert.deepEqual(run.timeline, ["text", "file", "upload", "file"]);
  assert.equal(run.meta.files.length, 2);
  assert.equal(run.meta.files[1].attachmentId, "att-1");
  assert.equal(run.stored.cached(version.id, "page-1"), "att-1", "the fresh id replaces the rejected one");
  assert.equal(run.stored.last()!.retries, 1);
  assert.equal(run.texts.length, 1, "still one text");
});

test("Meta still refuses the file: ONE link text follows, the machine-readable reason is logged and staff are told", async () => {
  const run = harness();
  const version = run.stored.publish(makeVersion());
  run.stored.cacheAttachment(version.id, "page-1", "att-stale");
  run.meta.rejectAttachmentOnce();
  run.meta.failFileOnce({ status: 400, errorCode: 100, errorMessage: "Invalid attachment id" });
  const outcome = await deliverCatalogue(run.request());
  assert.deepEqual([outcome.status, outcome.fileAccepted], ["sent_link_fallback", false]);
  assert.equal(outcome.reason, "file_send_failed:attachment_rejected:100:http400");
  assert.equal(run.texts.length, 2, "the caption, then the link");
  assert.equal(run.texts[1], catalogueLinkFollowupText(publicUrlOf(version.publicToken)));
  assert.equal(run.recorded.files.length, 0, "no file is recorded as sent");
  assert.equal(run.stored.last()!.status, "sent_link_fallback");
  assert.equal(run.leads.length, 1);
  assert.equal(run.leads[0].status, "sent_link_fallback");
  assert.match(run.leads[0].context, /холбоос явуулсан/);
});

test("the upload fails: no caption about a file, ONE text with the public link", async () => {
  const run = harness();
  const version = run.stored.publish(makeVersion());
  run.meta.failUploadOnce({ status: 400, errorCode: 190 });
  const outcome = await deliverCatalogue(run.request());
  assert.deepEqual([outcome.status, outcome.fileAccepted, outcome.reason], ["sent_link_fallback", false, "upload_failed:permission:190"]);
  assert.deepEqual(run.timeline, ["upload", "text"]);
  assert.equal(run.texts.length, 1);
  assert.equal(run.texts[0], catalogueLinkOnlyText("quick", publicUrlOf(version.publicToken)));
  assert.doesNotMatch(run.texts[0], /Доорх файл/, "never says a file is below when none is");
  assert.equal(run.meta.files.length, 0);
});

test("neither a file nor a link can be given: nothing is claimed as sent, staff get the lead", async () => {
  const run = harness({ url: false });
  run.stored.publish(makeVersion());
  run.meta.failUploadOnce();
  const outcome = await deliverCatalogue(run.request());
  assert.equal(outcome.status, "failed");
  assert.match(outcome.reason || "", /no_public_url/);
  assert.equal(run.texts.length, 0);
  assert.equal(run.meta.files.length, 0);
  assert.equal(run.leads[0].status, "failed");
});

test("Instagram cannot take the file: one link text, no upload", async () => {
  const run = harness();
  const version = run.stored.publish(makeVersion());
  const outcome = await deliverCatalogue(run.request({ platform: "instagram" }));
  assert.deepEqual([outcome.status, outcome.reason, run.meta.uploads.length, run.meta.files.length], ["sent_link_fallback", "instagram_no_file", 0, 0]);
  assert.equal(run.texts[0], catalogueLinkOnlyText("quick", publicUrlOf(version.publicToken)));
});

test("a file Meta would not accept by size is never attempted", async () => {
  const run = harness();
  run.stored.publish(makeVersion({ sizeBytes: 26 * 1024 * 1024 }));
  const outcome = await deliverCatalogue(run.request());
  assert.deepEqual([outcome.status, outcome.reason, run.meta.uploads.length], ["sent_link_fallback", "file_too_large_for_meta", 0]);
});

test("a webhook redelivery and a double tap own ONE send; an explicit resend is allowed but rate-limited", async () => {
  let now = NOW;
  const run = harness({ now });
  run.stored.publish(makeVersion());
  const first = await deliverCatalogue(run.request());
  assert.equal(first.status, "sent");
  const redelivered = await deliverCatalogue(run.request());
  assert.deepEqual([redelivered.status, redelivered.reason], ["duplicate_suppressed", "duplicate_message"]);
  const doubleTap = await deliverCatalogue(run.request({ dedupeKey: "mid-2" }));
  assert.deepEqual([doubleTap.status, doubleTap.reason], ["duplicate_suppressed", "recent_send"]);
  assert.equal(run.meta.files.length, 1, "one file in total");
  assert.equal(run.texts.length, 1);
  const burst = await deliverCatalogue(run.request({ dedupeKey: "mid-3", explicitResend: true }));
  assert.equal(burst.reason, "burst_guard", "a resend right after is a double click, not a request");
  now += 120_000;
  const later = harness({ now });
  later.stored.claims.push(...run.stored.claims.map((row) => ({ ...row })));
  later.stored.publish(makeVersion());
  const resend = await deliverCatalogue(later.request({ dedupeKey: "mid-4", explicitResend: true }));
  assert.equal(resend.status, "sent", "an explicit resend two minutes later goes through");
});

test("a person who takes the chat over between caption and file wins: no file, the claim is released, the error reaches the webhook", async () => {
  const run = harness({ assertMaySend: async () => { throw new StaffTakeoverSendBlocked("operator_reply"); } });
  run.stored.publish(makeVersion());
  await assert.rejects(() => deliverCatalogue(run.request()), StaffTakeoverSendBlocked);
  assert.equal(run.meta.files.length, 0);
  assert.equal(run.stored.last()!.status, "blocked_staff_owned");
});

test("a caption that fails to deliver releases the claim so Meta's redelivery retries instead of being suppressed", async () => {
  const run = harness();
  run.stored.publish(makeVersion());
  const failing = run.request({ sendText: async () => { throw new RetryableWebhookError("delivery_failed:catalogue_pdf"); } });
  await assert.rejects(() => deliverCatalogue(failing), RetryableWebhookError);
  assert.equal(run.stored.last()!.status, "failed");
  const retried = await deliverCatalogue(run.request());
  assert.equal(retried.status, "sent", "the same inbound message may retry after a failure");
  assert.equal(run.stored.claims.length, 1, "on the same row");
});

test("a caption the reply filter withholds sends no file and tells staff", async () => {
  const run = harness();
  run.stored.publish(makeVersion());
  const outcome = await deliverCatalogue(run.request({ sendText: async () => false }));
  assert.deepEqual([outcome.status, outcome.reason, run.meta.files.length], ["failed", "caption_withheld", 0]);
  assert.equal(run.leads[0].status, "failed");
});

test("blocked and unpublished requests send nothing, are logged in the send log and reach staff as a lead", async () => {
  for (const [name, options, status] of [
    ["staff owns the chat", { gate: { status: "blocked_staff_owned", reason: "operator_reply" } as GateVerdict }, "blocked_staff_owned"],
    ["bot paused", { gate: { status: "blocked_paused", reason: "manual" } as GateVerdict }, "blocked_paused"],
    ["kill switch", { kill: true }, "blocked_killswitch"],
  ] as const) {
    const run = harness(options);
    run.stored.publish(makeVersion());
    const outcome = await deliverCatalogue(run.request());
    assert.equal(outcome.status, status, name);
    assert.deepEqual([run.texts.length, run.meta.files.length, run.meta.uploads.length], [0, 0, 0], name);
    assert.deepEqual(run.stored.statuses(), [status], `${name}: logged`);
    assert.equal(run.leads.length, 1, `${name}: a lead`);
    assert.match(run.leads[0].context, /Байгууллагын каталог хүссэн/);
  }
  const window = harness(); window.stored.publish(makeVersion());
  assert.equal((await deliverCatalogue(window.request({ lastInboundAt: NOW - 30 * 3_600_000 }))).status, "blocked_window");
  const none = harness();
  const missing = await deliverCatalogue(none.request());
  assert.equal(missing.status, "no_published_version");
  assert.equal(none.texts.length, 0, "no published version: the customer gets nothing");
  assert.match(none.leads[0].context, /нийтлэгдсэн каталог байхгүй/);
});

test("a stale published file is never sent: ONE text with the website link, a staff lead, flagged in the log", async () => {
  const run = harness();
  run.stored.publish(makeVersion({ generatedAt: new Date(NOW - 40 * DAY).toISOString() }));
  const outcome = await deliverCatalogue(run.request());
  assert.deepEqual([outcome.status, outcome.fileAccepted, outcome.reason], ["stale_fallback", false, "stale:age"]);
  assert.deepEqual(run.timeline, ["text"]);
  assert.equal(run.texts[0], catalogueStaleText("https://site.example.test"));
  assert.match(run.texts[0], /https:\/\/site\.example\.test/);
  assert.equal(run.meta.files.length + run.meta.uploads.length, 0);
  assert.equal(run.leads.length, 1);
  assert.equal(run.stored.last()!.status, "stale_fallback");
  const again = await deliverCatalogue(run.request({ dedupeKey: "mid-9" }));
  assert.equal(again.status, "duplicate_suppressed", "a double tap does not repeat the notice");
  assert.equal(run.texts.length, 1);
});

test("a link-only follow-up never implies a file arrived: it says the file did not come through", () => {
  const text = catalogueLinkFollowupText(publicUrlOf("t"));
  assert.doesNotMatch(text, /нээгдэхгүй бол/, "'if the file does not open' tells the customer a file is in the chat");
  assert.match(text, /^Файл дамжихгүй байна\./);
  assert.ok(text.includes(publicUrlOf("t")));
});

test("a customer who asks again minutes after a clean send gets ONE pointer to the file they have, never a second file", async () => {
  const run = harness();
  const version = run.stored.publish(makeVersion());
  assert.equal((await deliverCatalogue(run.request())).status, "sent");
  run.advance(10 * 60_000);
  const again = await deliverCatalogue(run.request({ dedupeKey: "mid-2" }));
  assert.deepEqual([again.status, again.reason, again.fileAccepted], ["duplicate_suppressed", REPEAT_ANSWERED_REASON, false]);
  assert.equal(run.texts.length, 2, "the caption, then one pointer");
  assert.equal(run.texts[1], catalogueRepeatText({ url: publicUrlOf(version.publicToken), linkOnly: false }));
  assert.equal(run.meta.files.length, 1, "still the one file");
  assert.equal(run.meta.uploads.length, 1, "nothing uploaded again");
  assert.equal(run.leads.length, 0, "answered in the chat: no lead needed");
  assert.equal(run.stored.claims.length, 1, "the repeat took no send slot");
  // Asking a third time is a third question: it gets its own pointer, still without a file. (A redelivery
  // of the same inbound message is the webhook's own message-id dedupe; the journey covers it.)
  const third = await deliverCatalogue(run.request({ dedupeKey: "mid-3" }));
  assert.equal(third.reason, REPEAT_ANSWERED_REASON);
  assert.equal(run.texts.length, 3);
  assert.equal(run.meta.files.length, 1);
});

test("a double tap seconds after the send stays silent: the pointer is for a customer who asks again, not for a redelivery", async () => {
  const run = harness();
  run.stored.publish(makeVersion());
  await deliverCatalogue(run.request());
  run.advance(20_000);
  const tap = await deliverCatalogue(run.request({ dedupeKey: "mid-2" }));
  assert.deepEqual([tap.status, tap.reason, run.texts.length, run.leads.length], ["duplicate_suppressed", "recent_send", 1, 0]);
});

test("after a link-only send a repeat is pointed at the link; with no link to give, staff are told instead", async () => {
  const run = harness();
  const version = run.stored.publish(makeVersion());
  const first = await deliverCatalogue(run.request({ platform: "instagram" }));
  assert.equal(first.status, "sent_link_fallback");
  run.advance(10 * 60_000);
  const again = await deliverCatalogue(run.request({ platform: "instagram", dedupeKey: "mid-2" }));
  assert.equal(again.reason, REPEAT_ANSWERED_REASON);
  assert.equal(run.texts[1], catalogueRepeatText({ url: publicUrlOf(version.publicToken), linkOnly: true }));
  assert.match(run.texts[1], new RegExp(publicUrlOf(version.publicToken).replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")));
  // The deployment lost its public host in the meantime: a link-only pointer is impossible, so a person is told.
  const noUrl = harness({ url: false });
  noUrl.stored.publish(makeVersion());
  noUrl.stored.claims.push({ id: "send-x", senderId: "psid-1", edition: "quick", versionId: makeVersion().id, explicit: false, dedupeKey: "mid-0",
    status: "sent_link_fallback", at: NOW - 600_000, reason: null, metaMessageId: null, retries: 0 });
  const silent = await deliverCatalogue(noUrl.request({ platform: "instagram", dedupeKey: "mid-9" }));
  assert.deepEqual([silent.reason, noUrl.texts.length, noUrl.leads.length], [REPEAT_FOLLOWUP_REASON, 0, 1]);
  assert.match(noUrl.leads[0].context, /дахин хүссэн/);
});

test("a repeat request after the website notice is not invisible: no second notice, a staff line instead", async () => {
  const run = harness();
  run.stored.publish(makeVersion({ generatedAt: new Date(NOW - 40 * DAY).toISOString() }));
  assert.equal((await deliverCatalogue(run.request())).status, "stale_fallback");
  assert.equal(run.leads.length, 1);
  run.advance(10 * 60_000);
  const again = await deliverCatalogue(run.request({ dedupeKey: "mid-2" }));
  assert.deepEqual([again.status, again.reason], ["duplicate_suppressed", REPEAT_FOLLOWUP_REASON]);
  assert.equal(run.texts.length, 1, "the website notice is not repeated and no file is promised");
  assert.equal(run.leads.length, 2, "a person sees the customer asked again");
  assert.match(run.leads[1].context, /дахин хүссэн/);
  assert.equal(run.meta.files.length + run.meta.uploads.length, 0);
});

test("a stale-file notice does not hold back a freshly published version: the next request gets the PDF", async () => {
  const run = harness();
  const old = run.stored.publish(makeVersion({ generatedAt: new Date(NOW - 40 * DAY).toISOString() }));
  assert.equal((await deliverCatalogue(run.request())).status, "stale_fallback");
  run.advance(10 * 60_000);
  const fresh = run.stored.publish(makeVersion({ id: "00000000-0000-4000-8000-000000000002", versionNo: 4, publicToken: "tok_fresh_0123456789", generatedAt: new Date(NOW).toISOString() }));
  const sent = await deliverCatalogue(run.request({ dedupeKey: "mid-2" }));
  assert.equal(sent.status, "sent", "staff fixed the file; the customer who was told to wait gets it");
  assert.equal(sent.versionId, fresh.id);
  assert.equal(run.meta.files.length, 1);
  assert.deepEqual(run.stored.claims.map((row) => [row.versionId, row.status]), [[old.id, "stale_fallback"], [fresh.id, "sent"]]);
  // The same stale version still holds: the notice is not repeated for it.
  const other = harness();
  other.stored.publish(makeVersion({ generatedAt: new Date(NOW - 40 * DAY).toISOString() }));
  await deliverCatalogue(other.request());
  other.advance(10 * 60_000);
  assert.equal((await deliverCatalogue(other.request({ dedupeKey: "mid-3" }))).reason, REPEAT_FOLLOWUP_REASON);
  assert.equal(other.texts.length, 1);
});

test("dry run sends nothing, writes nothing and claims nothing", async () => {
  const run = harness();
  run.stored.publish(makeVersion());
  const outcome = await deliverCatalogue(run.request({ dryRun: true }));
  assert.equal(outcome.status, "dry_run");
  assert.deepEqual([run.texts.length, run.meta.files.length, run.meta.uploads.length, run.stored.claims.length, run.leads.length], [0, 0, 0, 0, 0]);
});

test("the file message is the bot's own tagged attachment; Meta failures are classified for the log", () => {
  const body = buildFbFileMessageBody("psid-1", { attachmentId: "att-1" }) as { recipient: { id: string }; message: { attachment: { type: string; payload: Record<string, unknown> }; metadata: string } };
  assert.equal(body.recipient.id, "psid-1");
  assert.equal(body.message.attachment.type, "file");
  assert.deepEqual(body.message.attachment.payload, { attachment_id: "att-1" });
  assert.equal(body.message.metadata, "uudam-bot-message", "tagged, or the echo would be read as a person and pause the bot");
  const base = { ok: false, status: 400, errorCode: null, errorSubcode: null, errorMessage: null };
  assert.equal(classifyFbFailure({ ...base, errorCode: 100, errorMessage: "Invalid attachment" }), "attachment_rejected");
  assert.equal(classifyFbFailure({ ...base, errorCode: 10, errorSubcode: 2018278 }), "window_closed");
  assert.equal(classifyFbFailure({ ...base, status: 403, errorCode: 200 }), "permission");
  assert.equal(classifyFbFailure({ ...base, status: 429, errorCode: 4 }), "rate_limited");
  assert.equal(classifyFbFailure({ ...base, status: 503 }), "transient");
  assert.equal(classifyFbFailure({ ...base, status: null }), "transient");
  assert.equal(classifyFbFailure({ ...base, suppressed: true }), "suppressed");
});

test("admin test send: dry-run by default returns the exact payload, one text and ONE file attachment, and sends nothing", async () => {
  applyTestEnv({});
  const run = harness();
  const version = run.stored.publish(makeVersion());
  const result = await sendCatalogueTest({ recipientPsid: "psid-tester-1", edition: "quick", env: { CATALOGUE_TEST_RECIPIENT_PSIDS: "psid-tester-1, psid-tester-2" }, deps: run.deps });
  assert.deepEqual([result.ok, result.dryRun, result.allowlisted, result.status], [true, true, true, "dry_run"]);
  assert.equal(result.payload?.fileAttachments, 1);
  assert.equal(result.payload?.textMessages, 1);
  assert.equal(result.payload?.messages.length, 2);
  assert.deepEqual(result.payload?.messages.map((message) => message.kind), ["text", "file"]);
  const file = result.payload!.messages[1].body as { message: { attachment: { type: string } } };
  assert.equal(file.message.attachment.type, "file");
  assert.equal(result.payload?.attachmentSource, "upload_on_send");
  assert.equal(result.payload?.fileName, version.fileName);
  assert.equal(result.recipientMasked.endsWith("er-1"), true);
  assert.doesNotMatch(JSON.stringify(result.recipientMasked), /psid-tester-1/);
  assert.deepEqual([run.texts.length, run.meta.files.length, run.meta.uploads.length, run.stored.claims.length], [0, 0, 0, 0]);
  run.stored.cacheAttachment(version.id, "1234567890", "att-live");
  const cached = await sendCatalogueTest({ recipientPsid: "psid-tester-1", edition: "quick", dryRun: true, pageId: "1234567890", env: { CATALOGUE_TEST_RECIPIENT_PSIDS: "psid-tester-1" }, deps: run.deps });
  assert.equal(cached.payload?.attachmentSource, "cached_attachment_id");
});

test("admin test send: a real send goes ONLY to an allowlisted PSID, never claims a customer slot, and honours the kill switch", async () => {
  applyTestEnv({});
  const env = { CATALOGUE_TEST_RECIPIENT_PSIDS: "psid-tester-1" };
  const refused = harness();
  refused.stored.publish(makeVersion());
  const stranger = await sendCatalogueTest({ recipientPsid: "psid-customer-9", edition: "quick", dryRun: false, env, deps: refused.deps });
  assert.deepEqual([stranger.ok, stranger.status, stranger.error, stranger.allowlisted], [false, "failed", "recipient_not_allowlisted", false]);
  assert.deepEqual([refused.texts.length, refused.meta.files.length, refused.meta.uploads.length], [0, 0, 0]);
  const noList = await sendCatalogueTest({ recipientPsid: "psid-tester-1", edition: "quick", dryRun: false, env: {}, deps: refused.deps });
  assert.equal(noList.error, "recipient_not_allowlisted", "no allowlist configured means no real send");

  const run = harness();
  run.stored.publish(makeVersion());
  const sent = await sendCatalogueTest({ recipientPsid: "psid-tester-1", edition: "quick", dryRun: false, env, deps: run.deps });
  assert.deepEqual([sent.ok, sent.status], [true, "sent"]);
  assert.deepEqual([run.texts.length, run.meta.files.length], [1, 1]);
  assert.equal(run.stored.claims.length, 0, "a test uses no customer send slot");

  const killed = harness({ kill: true });
  killed.stored.publish(makeVersion());
  const blocked = await sendCatalogueTest({ recipientPsid: "psid-tester-1", edition: "quick", dryRun: false, env, deps: killed.deps });
  assert.deepEqual([blocked.ok, blocked.status, killed.meta.files.length], [false, "blocked_killswitch", 0]);
});

test("admin test send can try a draft before it is published", async () => {
  applyTestEnv({});
  const run = harness();
  const draft = run.stored.addDraft(makeVersion({ id: "00000000-0000-4000-8000-0000000000d1", status: "draft", versionNo: 4, publishedAt: null }));
  const result = await sendCatalogueTest({ recipientPsid: "psid-tester-1", edition: "quick", versionId: draft.id, env: { CATALOGUE_TEST_RECIPIENT_PSIDS: "psid-tester-1" }, deps: run.deps });
  assert.equal(result.ok, true);
  assert.equal(result.payload?.versionNo, 4);
});

test("the test recipient allowlist reads a comma/space separated list", () => {
  assert.deepEqual(testRecipientAllowlist({ CATALOGUE_TEST_RECIPIENT_PSIDS: " a1 ,b2;c3  d4 " }), ["a1", "b2", "c3", "d4"]);
  assert.deepEqual(testRecipientAllowlist({}), []);
  assert.ok(SITE.startsWith("https://"));
});

// ── Verified testers (catalogue/testers.ts) ──────────────────────────────────────────────────────

const TESTER_PSID = "psid-verified-tester-1";
const testerOf = (overrides: Partial<TesterSendTarget> = {}): TesterLookup => ({
  status: "ok",
  target: {
    id: "11111111-1111-4111-8111-111111111111", psid: TESTER_PSID, pageId: "1234567890", label: "Миний утас", masked: "…er-1",
    verifiedAt: new Date(NOW - 5 * DAY).toISOString(), lastInboundAt: new Date(NOW - 3_600_000).toISOString(), revokedAt: null, ...overrides,
  },
});
const TESTER_ID = "11111111-1111-4111-8111-111111111111";

test("tester window constant is the same 24h-minus-5-minutes margin the customer path uses", () => {
  assert.equal(TESTER_WINDOW_MS, MESSAGING_WINDOW_MS);
});

test("tester test send: a verified tester with an open window gets ONE text and ONE file, addressed by the server-side PSID, no customer claim", async () => {
  applyTestEnv({});
  const run = harness();
  run.stored.publish(makeVersion());
  const sent = await sendCatalogueTest({ recipientPsid: "", testerId: TESTER_ID, testerLookup: async () => testerOf(), edition: "quick", dryRun: false, env: {}, deps: run.deps });
  assert.deepEqual([sent.ok, sent.status, sent.allowlisted], [true, "sent", true]);
  assert.deepEqual([run.texts.length, run.meta.files.length], [1, 1]);
  assert.equal(run.meta.files[0].recipientId, TESTER_PSID);
  assert.equal(run.stored.claims.length, 0, "a test uses no customer send slot");
  assert.equal(sent.recipientMasked, "…er-1", "only the masked tail is reported");
  assert.equal(JSON.stringify({ ...sent, payload: null }).includes(TESTER_PSID), false);
});

test("tester test send: the tester's own conversation being staff-owned or paused does not block it, but a paused PAGE does", async () => {
  applyTestEnv({});
  const takeover = async () => { throw new StaffTakeoverSendBlocked("operator_reply"); };
  const owned = harness({ gate: { status: "blocked_staff_owned", reason: "operator_reply" }, assertMaySend: takeover });
  owned.stored.publish(makeVersion());
  const sent = await sendCatalogueTest({ recipientPsid: "", testerId: TESTER_ID, testerLookup: async () => testerOf(), edition: "quick", dryRun: false, env: {}, deps: owned.deps });
  assert.equal(sent.status, "sent", "the staff member's own account is theirs to test with");
  assert.equal(owned.meta.files.length, 1);

  const paused = harness({ pageGate: { status: "blocked_paused", reason: "page_paused" } });
  paused.stored.publish(makeVersion());
  const held = await sendCatalogueTest({ recipientPsid: "", testerId: TESTER_ID, testerLookup: async () => testerOf(), edition: "quick", dryRun: false, env: {}, deps: paused.deps });
  assert.deepEqual([held.ok, held.status, held.reason], [false, "blocked_paused", "page_paused"]);
  assert.deepEqual([paused.texts.length, paused.meta.files.length, paused.meta.uploads.length], [0, 0, 0]);
});

test("tester test send is refused outside the 24h window, when revoked, unknown, or with the kill switch on", async () => {
  applyTestEnv({});
  const closed = harness();
  closed.stored.publish(makeVersion());
  const old = await sendCatalogueTest({ recipientPsid: "", testerId: TESTER_ID, testerLookup: async () => testerOf({ lastInboundAt: new Date(NOW - 25 * 3_600_000).toISOString() }), edition: "quick", dryRun: false, env: {}, deps: closed.deps });
  assert.deepEqual([old.ok, old.status, old.reason], [false, "blocked_window", "outside_24h_window"]);
  const never = await sendCatalogueTest({ recipientPsid: "", testerId: TESTER_ID, testerLookup: async () => testerOf({ lastInboundAt: null }), edition: "quick", dryRun: false, env: {}, deps: closed.deps });
  assert.deepEqual([never.status, never.reason], ["blocked_window", "no_inbound_timestamp"]);
  const revoked = await sendCatalogueTest({ recipientPsid: "", testerId: TESTER_ID, testerLookup: async () => ({ status: "revoked" }), edition: "quick", dryRun: false, env: {}, deps: closed.deps });
  assert.deepEqual([revoked.ok, revoked.error], [false, "tester_revoked"]);
  const unknown = await sendCatalogueTest({ recipientPsid: "", testerId: TESTER_ID, testerLookup: async () => ({ status: "not_found" }), edition: "quick", dryRun: false, env: {}, deps: closed.deps });
  assert.deepEqual([unknown.ok, unknown.error], [false, "tester_not_found"]);
  assert.deepEqual([closed.texts.length, closed.meta.files.length, closed.meta.uploads.length], [0, 0, 0]);

  const killed = harness({ kill: true });
  killed.stored.publish(makeVersion());
  const off = await sendCatalogueTest({ recipientPsid: "", testerId: TESTER_ID, testerLookup: async () => testerOf(), edition: "quick", dryRun: false, env: {}, deps: killed.deps });
  assert.deepEqual([off.status, killed.meta.files.length], ["blocked_killswitch", 0]);
});

test("tester dry run: exactly one text and one file attachment, nobody is addressed, nothing is sent", async () => {
  applyTestEnv({});
  const run = harness();
  run.stored.publish(makeVersion());
  const dry = await sendCatalogueTest({ recipientPsid: "", testerId: TESTER_ID, testerLookup: async () => testerOf({ lastInboundAt: null }), edition: "quick", env: {}, deps: run.deps });
  assert.deepEqual([dry.ok, dry.dryRun, dry.status], [true, true, "dry_run"]);
  assert.deepEqual(dry.payload?.messages.map((message) => message.kind), ["text", "file"]);
  assert.equal(JSON.stringify(dry).includes(TESTER_PSID), false, "a dry run never carries the PSID");
  assert.deepEqual([run.texts.length, run.meta.files.length, run.meta.uploads.length, run.stored.claims.length], [0, 0, 0, 0]);
});
