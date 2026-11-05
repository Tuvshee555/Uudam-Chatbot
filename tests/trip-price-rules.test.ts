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

test("a missing tugrug price is a note beside the price field, never a question; a typed price still sets the fares", async () => {
  const { applyPriceAnswer, finalizeNewTripActions } = await import("../src/lib/tripProposalFinalize");
  const { buildProposalClarifications } = await import("../src/lib/adminProposalUtils");
  const { PRICE_MISSING, PRICE_QUESTION_MARK } = await import("../src/lib/tripPriceRules");
  const { reviewIssues } = await import("../src/lib/tripReview");
  const p = proposal();
  await finalizeNewTripActions(p);
  const notice = p.conflict_items!.find((item) => item.type === PRICE_MISSING);
  assert.equal(notice?.severity, "info", "said once, as information");
  assert.doesNotMatch(notice!.text, /\d{3,}/, "the notice quotes no yuan figure");
  assert.equal(p.needs_confirmation, true, "an automatic import still waits for a person");
  assert.deepEqual(buildProposalClarifications(p as never), [], "no question, so no second model call");
  const price = reviewIssues(p.actions[0].fields as Record<string, unknown>).find((issue) => issue.key === "price");
  assert.equal(price?.blocks, null, "a trip without a price can be saved and published");

  // The typed-answer path stays for a price sent as a chat message.
  const answer = `«${ROUTE}» аяллын ${PRICE_QUESTION_MARK} → 3,290,000 / 2,590,000`;
  assert.equal(applyPriceAnswer(answer, p), true);
  assert.deepEqual([p.actions[0].fields!.adult_price, p.actions[0].fields!.child_price, p.actions[0].fields!.currency], [3_290_000, 2_590_000, "MNT"]);
  await finalizeNewTripActions(p);
  assert.ok(!p.conflict_items!.some((item) => item.type === PRICE_MISSING), "the notice goes once the price is there");
  assert.equal(applyPriceAnswer(`«${ROUTE}» аяллын ${PRICE_QUESTION_MARK} → Үнийг дараа нэмнэ.`, proposal()), false, "'add later' sets no fare");
});

test("a place name ending in -ланд is not a land price; a settlement price is a partner's cost", async () => {
  const { mentionsPartnerPrice, withoutPartnerPrices } = await import("../src/lib/tripPriceRules");
  assert.equal(withoutPartnerPrices("Норланд улсын далайн эрэг дээр амарна. Ланд үнэ 900 юань."), "Норланд улсын далайн эрэг дээр амарна.");
  assert.equal(mentionsPartnerPrice("Норландын аялал"), false);
  assert.equal(mentionsPartnerPrice("Ландын үнэ 1,600,000₮"), true);
  assert.equal(mentionsPartnerPrice("Тооцоо нийлэх үнэ: 4,000,000"), true);
  assert.equal(withoutPartnerPrices("Аяллын зарлах үнэ 4,290,000₮.\nТооцоо нийлэх үнэ: 4,000,000"), "Аяллын зарлах үнэ 4,290,000₮.");
});

test("a selling price printed beside a land price keeps its row; only the partner's row and remark go", async () => {
  const { scrubPartnerPrices } = await import("../src/lib/tripProposalFinalize");
  const p = proposal({ adult_price: 3_490_000, infant_price: 60_000 });
  (p.actions[0].fields!.extra as Record<string, unknown>).departure_date_groups = [
    { label: "A", dates: ["1 сарын 14"], adult_price: 3_590_000, child_price: 3_260_000, note: "Ланд үнэ 5980 юань." },
    { label: "Ланд үнэ", dates: ["1 сарын 14"], adult_price: 5980, currency: "CNY" },
  ];
  scrubPartnerPrices(p);
  const groups = (p.actions[0].fields!.extra as Record<string, unknown>).departure_date_groups as Array<Record<string, unknown>>;
  assert.equal(groups.length, 1);
  assert.deepEqual([groups[0].adult_price, groups[0].child_price, groups[0].note], [3_590_000, 3_260_000, ""]);
  assert.equal(p.actions[0].fields!.infant_price, 60_000, "a small tugrug infant fare is a real fare");
});

test("tugrug amounts are read the way staff type them", async () => {
  const { parseMntPrices } = await import("../src/lib/tripPriceRules");
  assert.deepEqual(parseMntPrices("3,290,000 / 2,590,000"), [3_290_000, 2_590_000]);
  assert.deepEqual(parseMntPrices("том хүн 3290000, хүүхэд 2.59 сая"), [3_290_000, 2_590_000]);
  assert.deepEqual(parseMntPrices("3 290 000₮"), [3_290_000]);
  assert.deepEqual(parseMntPrices("3300 юань"), [], "a yuan-sized number is never a trip price");
});
