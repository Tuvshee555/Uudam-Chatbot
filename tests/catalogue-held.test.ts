import assert from "node:assert/strict";
import test from "node:test";
import "./helpers/catalogueEnv";
import { fakeMeta, fakeSendStore, makeVersion, noDrift, publicUrlOf, DAY } from "./helpers/catalogueSendFakes";
import { catalogueStaleText } from "../src/lib/catalogue/messages";
import { deliverCatalogue, sendHeldCatalogue, setSendDepsForTests, type DeliverCatalogueInput, type SendDeps } from "../src/lib/catalogue/send";
import { deliverHeldCatalogues, type HeldRequest } from "../src/lib/catalogue/held";

/**
 * Live 2026-11-22: a company asked «байгууллагын аялал» while the published catalogue was out of date (trips had
 * been edited; the 30-minute refresh actually runs every few hours on GitHub). It got «Каталогийг одоо шинэчилж
 * байна» and a website link; the rebuild the bot asked for published 90 seconds later, and the file never followed.
 * Now the request is held and the fresh file is sent the moment it is published.
 */
const NOW = Date.parse("2098-02-01T04:00:00Z");

function wire(options: { hold?: boolean; now?: number } = {}) {
  let clock = options.now ?? NOW;
  const stored = fakeSendStore(() => clock);
  const meta = fakeMeta();
  const texts: string[] = [];
  const held: Array<Record<string, unknown>> = [];
  const deps: Partial<SendDeps> = {
    now: () => new Date(clock), store: stored.store, gate: async () => null, pageGate: async () => null, killSwitch: () => false, checkDrift: noDrift,
    upload: meta.deps.upload, sendFile: meta.deps.sendFile,
    sendDirectText: async (_recipient, text) => { texts.push(text); return true; },
    assertMaySend: async () => {}, recordFile: async () => {}, recordOutbound: async () => {},
    publicFileUrl: (token) => publicUrlOf(token), websiteUrl: () => "https://site.example.test",
    requestRefresh: async () => {},
    holdRequest: async (input) => { held.push(input); return options.hold ?? true; },
  };
  const request = (extra: Partial<DeliverCatalogueInput> = {}): DeliverCatalogueInput => ({
    senderId: "psid-1", pageId: "page-1", pageToken: "token-1", edition: "complete", explicitResend: false, lastInboundAt: clock - 60_000, deps,
    captureLead: async () => {}, customerText: "байгууллагын аялал", dedupeKey: "mid-1", ...extra,
  });
  return { stored, meta, texts, held, deps, request, advance: (ms: number) => { clock += ms; } };
}

test("a request that meets a stale file is held, and the reply says the file comes in minutes", async () => {
  const run = wire();
  run.stored.publish(makeVersion({ edition: "complete", generatedAt: new Date(NOW - 40 * DAY).toISOString() }));
  const outcome = await deliverCatalogue(run.request());
  assert.equal(outcome.status, "stale_fallback");
  assert.deepEqual(run.texts, [catalogueStaleText("https://site.example.test", { willSend: true })]);
  assert.equal(run.texts[0], "Каталогийг шинэчилж байна, хэдэн минутын дараа энд илгээнэ.");
  assert.equal(run.meta.files.length, 0, "never the stale file");
  assert.deepEqual(run.held.map((input) => [input.senderId, input.pageId, input.edition, input.platform]), [["psid-1", "page-1", "complete", "facebook"]]);
});

test("no hold (the database did not confirm it, or Instagram): the old safe text, no promise", async () => {
  const unconfirmed = wire({ hold: false });
  unconfirmed.stored.publish(makeVersion({ edition: "complete", generatedAt: new Date(NOW - 40 * DAY).toISOString() }));
  await deliverCatalogue(unconfirmed.request());
  assert.deepEqual(unconfirmed.texts, [catalogueStaleText("https://site.example.test")]);

  const instagram = wire();
  instagram.stored.publish(makeVersion({ edition: "complete", generatedAt: new Date(NOW - 40 * DAY).toISOString() }));
  await deliverCatalogue(instagram.request({ platform: "instagram" }));
  assert.equal(instagram.held.length, 0, "Instagram gets no file, so nothing is held for it");
  assert.deepEqual(instagram.texts, [catalogueStaleText("https://site.example.test")]);
});

test("after the refresh publishes, the held customer gets the fresh file once; a still-stale file keeps the hold", async () => {
  const run = wire();
  run.stored.publish(makeVersion({ edition: "complete", generatedAt: new Date(NOW - 40 * DAY).toISOString() }), Buffer.from("%PDF-old"));
  // The test environment's configured page: the held send looks its token up like the live one.
  await deliverCatalogue(run.request({ pageId: "1234567890" }));
  const request: HeldRequest = { senderId: "psid-1", pageId: "1234567890", edition: "complete", platform: "facebook",
    lastInboundAt: new Date(NOW - 60_000).toISOString(), heldAt: new Date(NOW).toISOString() };
  setSendDepsForTests(run.deps);
  try {
    assert.equal(await sendHeldCatalogue(request), "keep", "the file is still stale: wait for the next refresh");
    assert.equal(run.meta.files.length, 0);

    run.advance(90_000);
    run.stored.publish(makeVersion({ id: "00000000-0000-4000-8000-000000000038", edition: "complete", versionNo: 38,
      generatedAt: new Date(NOW + 80_000).toISOString(), publicToken: "tok_fresh_0123456789" }), Buffer.from("%PDF-fresh"));
    assert.equal(await sendHeldCatalogue(request), "sent");
    assert.equal(run.meta.files.length, 1, "the fresh file went out");
    assert.equal(run.stored.last()!.status, "sent");
  } finally {
    setSendDepsForTests(null);
  }
});

test("held requests: sent and dropped ones are released, kept ones wait", async () => {
  const rows: HeldRequest[] = ["a", "b", "c"].map((id) => ({ senderId: id, pageId: "p", edition: "complete", platform: "facebook",
    lastInboundAt: new Date(NOW).toISOString(), heldAt: new Date(NOW).toISOString() }));
  const released: string[] = [];
  const verdicts: Record<string, "sent" | "keep" | "drop"> = { a: "sent", b: "keep", c: "drop" };
  const counts = await deliverHeldCatalogues("complete", async (row) => verdicts[row.senderId],
    { load: async () => rows, release: async (row) => { released.push(row.senderId); } });
  assert.deepEqual(counts, { sent: 1, kept: 1, dropped: 1 });
  assert.deepEqual(released, ["a", "c"]);
  const failing = await deliverHeldCatalogues("complete", async () => { throw new Error("Meta down"); },
    { load: async () => rows.slice(0, 1), release: async () => { assert.fail("a failed send is kept, not released"); } });
  assert.deepEqual(failing, { sent: 0, kept: 1, dropped: 0 });
});
