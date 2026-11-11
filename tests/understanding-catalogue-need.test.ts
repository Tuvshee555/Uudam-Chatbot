import assert from "node:assert/strict";
import test from "node:test";
import { conversationGateHarness, type FixtureTrip } from "./helpers/conversationGateHarness";
import { fakeMeta, fakeSendStore, makeVersion, noDrift, publicUrlOf } from "./helpers/catalogueSendFakes";
import { THANKS_REPLY } from "../src/lib/greetingPhrases";

/**
 * Integration of the corporate catalogue (webhookCatalogue.ts) with the need gate (messageNeed.ts), 2026-11-11.
 * The catalogue answers "компани / хамт олон + аялал" requests with a PDF. A thank-you, a payment-terms
 * question or a complaint that happens to say "компани / хамт олон" is not a catalogue request: it must
 * never get the PDF. A real company request still does. Invented trips only; the model is never called.
 */
const trip = (id: string, name: string, dates: string[], adult: number) => ({
  id, route_name: name, operator_name: "Fixture agency", category: "Аялал", adult_price: adult, child_price: adult - 300_000, infant_price: 300_000,
  currency: "MNT", status: "active", duration_text: "5 өдөр 4 шөнө", departure_dates: dates, seats_total: 20, seats_left: 10,
  has_food: null, hotel: "", photo_urls: [], notes: "", source_description: "",
  extra: { customer_visible: true, age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-23 сар" } },
} as unknown as FixtureTrip);

test("a thank-you or a payment question that names the company never gets the catalogue PDF", async (context) => {
  const harness = await conversationGateHarness(context);
  const { setSendDepsForTests } = await import("../src/lib/catalogue/send");
  harness.catalog([trip("t-a", "ТЕСТ-ДАЛАЙ ЭРГИЙН АЯЛАЛ", ["2098-03-06"], 1_890_000)]);
  const stored = fakeSendStore(() => Date.now());
  const meta = fakeMeta();
  setSendDepsForTests({ store: { ...stored.store, hasDeliveredCatalogueSince: async () => false }, upload: meta.deps.upload, sendFile: meta.deps.sendFile,
    checkDrift: noDrift, publicFileUrl: publicUrlOf, websiteUrl: () => "https://site.example.test" });
  stored.publish(makeVersion({ edition: "quick", id: "00000000-0000-4000-8000-0000000000c1", fileName: "q.pdf", versionNo: 1, publicToken: "tok_quick_c1" }));
  stored.publish(makeVersion({ edition: "complete", id: "00000000-0000-4000-8000-0000000000c2", fileName: "c.pdf", versionNo: 1, publicToken: "tok_complete_c2", tripCount: 3 }));
  const say = (sender: string, text: string) => harness.turn(sender, text, {}, undefined, { platform: "facebook" as const });
  try {
    for (const [sender, text] of [["thx-1", "Танай компанийн аялал маш сайхан байлаа, баярлалаа"], ["thx-2", "Танай хамт олонд баярлалаа, аялал сайхан болсон"]]) {
      const turn = await say(sender, text);
      assert.equal(meta.files.length, 0, `no PDF for a thank-you: ${text}`);
      assert.deepEqual(turn.sends.map((send) => send.text), [THANKS_REPLY], text);
    }
    const policy = await say("pay-1", "Компанийн аялалд бартераар төлж болох уу");
    assert.equal(meta.files.length, 0, "no PDF for a payment-terms question");
    // An organisation asking about barter is a group inquiry for the need gate: the verified group wording
    // (never a barter promise) and a typed staff lead that carries the question.
    assert.doesNotMatch(policy.sends.map((send) => send.text).join(" "), /бартер|barter/iu, "never says anything about barter");
    assert.ok(policy.leads.some((lead) => /need:/.test(lead.context) && /бартер/u.test(lead.context)), "a typed staff lead with the question");
    // Positive control: a real company request still gets the catalogue.
    await say("corp-ok", "байгууллагын аяллуудаа харуулаач");
    assert.equal(meta.files.length, 1, "a company request still gets one PDF");
  } finally {
    setSendDepsForTests(null);
    await harness.close();
  }
});
