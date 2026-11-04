import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { AIChangeProposal } from "../src/lib/travelTypes";

applyTestEnv();

// The shape of the 2026-11-04 failure (invented trip): a partner's Word program priced only in
// yuan. The proposal said "adult 3300 юань" in its summary, kept "Ландын үнэ (юань)" in notes
// and called itself ready to save with no tugrug price.
const ROUTE = "НОРВЕЛ ХОТЫН АЯЛАЛ";
const proposal = (fields: Record<string, unknown> = {}): AIChangeProposal => ({
  summary: "Норвел хотын аялал 11-р сарын 21-нд эхэлнэ. Том хүний үнэ 3300 юань, хүүхдийн үнэ 2500 юань байна.",
  needs_confirmation: false, important_reason: "",
  conflicts: ["Төгрөгийн үнэ файлд байхгүй — админ үнээ нэмнэ"],
  conflict_items: [{ text: "Төгрөгийн үнэ файлд байхгүй — админ үнээ нэмнэ", severity: "info" }],
  actions: [{ action: "upsert", fields: {
    route_name: ROUTE, duration_text: "3 өдөр 2 шөнө", currency: "MNT",
    notes: "Ландын үнэ (юань): Том хүн 3300¥, Хүүхэд 2500¥. Аялагч бүртгүүлээд цуцалсан тохиолдолд 1400 юань хураамж авна.",
    extra: {
      website_summary: "Норвел бол том хот. Ландын үнэ 1,600,000₮.",
      price_groups: [{ label: "Лант үнэ (юань)", passenger_prices: [{ adult: 3300 }] }, { label: "Үндсэн", passenger_prices: [{ adult: 3_290_000 }] }],
      itinerary_days: [
        { day: 1, title: "Эрээн – Норвел", description: "Эрээн авто вокзал дээр тосно. Норвел хотоос нисээд бууна.", meals: {} },
        { day: 2, title: "Норвел – Эрээн", description: "Өглөө нисээд Эрээнд ирнэ.", meals: {} },
      ],
    },
    ...fields,
  } }],
});

test("yuan and land prices never reach a new trip: not its fare, notes, summary or price table", async () => {
  const { scrubPartnerPrices } = await import("../src/lib/tripProposalFinalize");
  const p = proposal({ adult_price: 3300, child_price: 2500, currency: "CNY", infant_price: 0 });
  scrubPartnerPrices(p);
  const fields = p.actions[0].fields as Record<string, unknown>;
  const extra = fields.extra as Record<string, unknown>;
  assert.deepEqual([fields.adult_price, fields.child_price, fields.currency], [null, null, "MNT"]);
  assert.equal(fields.infant_price, 0, "a free infant stays free whatever the currency");
  assert.doesNotMatch(String(fields.notes), /Ланд|3300|2500/);
  assert.match(String(fields.notes), /1400 юань хураамж/, "a cancellation fee is a booking term and stays");
  assert.equal(p.summary, "Норвел хотын аялал 11-р сарын 21-нд эхэлнэ.");
  assert.equal(extra.website_summary, "Норвел бол том хот.", "a land price in tugrug is still not a price");
  assert.deepEqual((extra.price_groups as Array<{ label: string }>).map((group) => group.label), ["Үндсэн"]);
  assert.deepEqual(p.conflict_items, [], "the model's own 'no tugrug price' notice is replaced by the question");
  assert.deepEqual(p.conflicts, []);
});

test("a 'MNT' fare too small to be a trip is a misread yuan amount and is cleared; a real tugrug fare stays", async () => {
  const { scrubPartnerPrices } = await import("../src/lib/tripProposalFinalize");
  const small = proposal({ adult_price: 3300, child_price: 2_590_000 });
  scrubPartnerPrices(small);
  assert.deepEqual([small.actions[0].fields!.adult_price, small.actions[0].fields!.child_price], [null, 2_590_000]);
  const real = proposal({ adult_price: 3_290_000, child_price: 2_590_000, infant_price: 0 });
  scrubPartnerPrices(real);
  assert.deepEqual([real.actions[0].fields!.adult_price, real.actions[0].fields!.child_price, real.actions[0].fields!.infant_price], [3_290_000, 2_590_000, 0]);
});

test("with no tugrug price the admin is asked for it; the typed amounts become the fares", async () => {
  const { applyPriceAnswer, finalizeNewTripActions } = await import("../src/lib/tripProposalFinalize");
  const { buildProposalClarifications } = await import("../src/lib/adminProposalUtils");
  const { PRICE_MISSING } = await import("../src/lib/tripPriceRules");
  const p = proposal();
  await finalizeNewTripActions(p);
  assert.ok(p.conflict_items!.some((item) => item.type === PRICE_MISSING));
  assert.equal(p.needs_confirmation, true);
  const question = buildProposalClarifications(p as never).find((q) => q.id === `price:${ROUTE}`);
  assert.ok(question, "the price question is asked");
  assert.equal(question!.allowCustom, true);
  assert.ok(question!.options.every((option) => !/юан|¥|ланд/i.test(option.label + option.answer)), "a yuan price is never offered");

  // What admin.tsx sends back: "<prompt> [Зөрчил: <detail>] → <answer>".
  const answer = `${question!.prompt} [Зөрчил: ${question!.detail}] → 3,290,000 / 2,590,000`;
  assert.equal(applyPriceAnswer(answer, p), true);
  assert.deepEqual([p.actions[0].fields!.adult_price, p.actions[0].fields!.child_price, p.actions[0].fields!.currency], [3_290_000, 2_590_000, "MNT"]);
  await finalizeNewTripActions(p);
  assert.ok(!p.conflict_items!.some((item) => item.type === PRICE_MISSING), "the notice goes once the price is there");

  const later = proposal();
  assert.equal(applyPriceAnswer(`${question!.prompt} → Үнийг дараа «Аяллууд» хэсгээс нэмнэ.`, later), false, "'add later' sets no fare");
});

test("tugrug amounts are read the way staff type them", async () => {
  const { parseMntPrices } = await import("../src/lib/tripPriceRules");
  assert.deepEqual(parseMntPrices("3,290,000 / 2,590,000"), [3_290_000, 2_590_000]);
  assert.deepEqual(parseMntPrices("том хүн 3290000, хүүхэд 2.59 сая"), [3_290_000, 2_590_000]);
  assert.deepEqual(parseMntPrices("3 290 000₮"), [3_290_000]);
  assert.deepEqual(parseMntPrices("3300 юань"), [], "a yuan-sized number is never a trip price");
});
