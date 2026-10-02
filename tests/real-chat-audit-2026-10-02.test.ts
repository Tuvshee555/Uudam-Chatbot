/**
 * Regressions from the Sep 26-Oct 2 live-chat audit. Names and prices in this
 * file are synthetic; only the customer wording and failure shapes are real.
 */
import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelOps";
import {
  buildCompareReply,
  buildTripProgramReply,
  hasCompareIntent,
  hasDiscountIntent,
  hasPriceObjectionIntent,
  sanitizeTripForCustomers,
  queryWantsLandFlightCombo,
  resolveDateQuestionScope,
} from "../src/lib/travelFastPaths";
import { sanitizeAssistantReply } from "../src/lib/reply";
import { keywordTokens } from "../src/lib/travelTextNorm";

let buildCatalogListingReply: typeof import("../src/lib/catalogListing").buildCatalogListingReply;

before(async () => {
  applyTestEnv();
  ({ buildCatalogListingReply } = await import("../src/lib/catalogListing"));
});

function trip(fields: Partial<TravelTrip>): TravelTrip {
  return {
    id: "trip-1",
    category: "Аялал",
    operator_name: "Test",
    route_name: "Вэлмор аялал",
    duration_text: "8 өдөр 7 шөнө",
    adult_price: 1_111_111,
    child_price: 999_999,
    infant_price: null,
    currency: "MNT",
    departure_dates: ["2027-10-08"],
    seats_total: null,
    seats_left: null,
    has_food: true,
    status: "active",
    notes: "",
    hotel: "",
    source_description: "",
    photo_urls: [],
    extra: {},
    created_at: "",
    updated_at: "",
    ...fields,
  };
}

test("a requested destination duration is answered honestly when no trip is that short", () => {
  const result = buildTripProgramReply("Кардан 5-6 хоногт аялаад ирэх боломж байдаг уу?", [
    trip({ id: "long", route_name: "Кардан - Сэлмор аялал", duration_text: "10 өдөр 9 шөнө" }),
    trip({ id: "shortest", route_name: "Лумиа + Кардан аялал", duration_text: "8 өдөр 7 шөнө" }),
  ]);
  assert.ok(result);
  assert.match(result.reply, /5-6 өдрийн аялал одоогоор алга/);
  assert.match(result.reply, /Хамгийн богино.*8 өдөр 7 шөнө/);
  assert.doesNotMatch(result.reply, /хэд хэдэн сонголт/);
});

test("Latin-typed Mongolian comparison wording compares both named destinations", () => {
  const text = "Helvin, Saniya 2 ni yugaaraa ylgaatai um bol?";
  const trips = [
    trip({ id: "helvin", route_name: "Хэлвин нислэгтэй аялал", duration_text: "8 өдөр 7 шөнө" }),
    trip({ id: "saniya", route_name: "САНЬЯА шууд нислэгтэй аялал", duration_text: "9 өдөр 8 шөнө" }),
    trip({ id: "unrelated", route_name: "ЖИНИН-МИНИ хотын аялал", duration_text: "7 өдөр 6 шөнө" }),
  ];
  assert.equal(hasCompareIntent(text), true);
  const reply = buildCompareReply(text, trips) || "";
  assert.match(reply, /Хэлвин/);
  assert.match(reply, /САНЬЯА/);
  assert.doesNotMatch(reply, /ЖИНИН/);
});

test("paid-vs-free service wording is not mistaken for a price complaint", () => {
  assert.equal(
    hasPriceObjectionIntent("Unetei unegui gesen shinjilgeenuudiin yalgaa yu ve"),
    false,
  );
  assert.equal(hasPriceObjectionIntent("Үнэтэй юм байна"), true);
});

test("customers asking how a group can get cheaper are recognized as discount asks", () => {
  assert.equal(hasDiscountIntent("5-6 хүн яаж хямдрах вэ"), true);
  assert.equal(hasDiscountIntent("5-6 hun yaj hyamdrah ve"), true);
});

test("customer reply sanitization never exposes the prompt's internal Context label", () => {
  const reply = sanitizeAssistantReply("Истанбул хотыг багтаасан аялал Context-д байхгүй байна.");
  assert.doesNotMatch(reply, /Context/i);
  assert.match(reply, /аяллын мэдээлэлд/);
});

test("screenshot-path trip cleanup restores birth-year tiers before formatting", () => {
  const cleaned = sanitizeTripForCustomers(trip({
    extra: {
      child_rules: [
        { label: "Хүүхэд 2015-2023 он", age_range: "15-20 нас", price: 750_000 },
      ],
      age_rules: { adult: "12+ нас", child: "15-20 нас", infant: "0-23 сар" },
    },
  }));
  const childRules = cleaned.extra.child_rules as Array<{ age_range: string }>;
  assert.equal(childRules[0].age_range, "2015-2023 он");
  assert.equal((cleaned.extra.age_rules as { child: string }).child, "2015-2023 он");
});

test("one ground leg plus one flight leg is a combo request, not ground-only", () => {
  assert.equal(queryWantsLandFlightCombo("явахдаа газраар ирэхдээ нисэхээр байгаа юу"), true);
});

test("a direct-flight destination ask never falls back to that destination's ground tour", () => {
  const result = buildCatalogListingReply("Манжуур шууд нислэг 5 хүн хэд вэ", [
    trip({ id: "ground", route_name: "Хайлаар Манжуурын газрын аялал", category: "Газрын аялал" }),
    trip({ id: "other-direct", route_name: "Сэлмор шууд нислэгтэй аялал", category: "Шууд нислэгтэй" }),
  ]);
  assert.ok(result);
  assert.match(result.reply, /Манжуур чиглэлд шууд нислэгтэй аяллууд одоогоор алга/);
  assert.doesNotMatch(result.reply.split("\n")[0], /Хайлаар/);
});

test("Sar Shiniin asks only return trips explicitly tagged for Lunar New Year", () => {
  const noSpecial = buildCatalogListingReply("Hi sar shiniin aylal garsan uu", [
    trip({ id: "ordinary", route_name: "Жинин хотын аялал" }),
  ]);
  assert.ok(noSpecial);
  assert.match(noSpecial.reply, /Сар шинийн тусгай аялал.*бүртгэгдээгүй/);
  assert.doesNotMatch(noSpecial.reply, /Жинин/);
});

test("a Hohhot date question scopes to Hohhot trips and excludes unrelated same-date tours", () => {
  const hohhot = trip({ id: "hohhot", route_name: "Жинин - Хөх хотын аялал", departure_dates: ["Пүрэв гараг бүр"] });
  const beidaihe = trip({ id: "beidaihe", route_name: "Бэйдайхэ - Бээжингийн аялал", departure_dates: ["10 сарын 10"] });
  const scope = resolveDateQuestionScope("танай хөх хотын аялал 10/10-нд байх уу", [hohhot, beidaihe]);
  assert.equal(scope.focusTrip?.id, "hohhot");
});

test("water-park wording does not identify an unrelated cruise by the generic word water", () => {
  const tokens = keywordTokens("халуун рашаан усан парк ажиллах уу");
  assert.equal(tokens.includes("усан"), false);
  assert.equal(tokens.includes("парк"), true);
});
