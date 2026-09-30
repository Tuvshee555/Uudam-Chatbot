import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_AGE_RULES, ageRulesFromExtra, hasAgeRules, resolveAgeRules } from "../src/lib/ageRules";
import { isInfantColumn, mapPosterTripToFields } from "../src/lib/poster/tripMapper";
import { websiteExtraDetails } from "../src/lib/connectedTripMapping";

test("age rules: defaults only pre-fill, saved bands win, unset stays empty", () => {
  assert.deepEqual(ageRulesFromExtra({}), { infant: "", child: "", adult: "" });
  assert.equal(hasAgeRules({}), false);
  assert.deepEqual(resolveAgeRules(undefined), DEFAULT_AGE_RULES);

  const saved = { age_rules: { infant: "1-23 сар", child: "2-6 нас", adult: "7+ нас" } };
  assert.deepEqual(ageRulesFromExtra(saved), { infant: "1-23 сар", child: "2-6 нас", adult: "7+ нас" });
  assert.equal(hasAgeRules(saved), true);
  // A partially saved trip keeps what was saved and only fills the blanks.
  assert.deepEqual(resolveAgeRules({ age_rules: { child: "2-6 нас" } }), {
    infant: DEFAULT_AGE_RULES.infant, child: "2-6 нас", adult: DEFAULT_AGE_RULES.adult,
  });
});

test("poster price columns: an infant column is recognised by name or by an infant-shaped band", () => {
  assert.equal(isInfantColumn("Нярай"), true);
  assert.equal(isInfantColumn("Infant"), true);
  assert.equal(isInfantColumn("0-2 насны хүүхэд"), true);
  assert.equal(isInfantColumn("1-23 сартай"), true);
  assert.equal(isInfantColumn("Хүүхэд 2-11 нас"), false);
  assert.equal(isInfantColumn("Том хүн"), false);
});

test("poster with a Нярай column maps a top-level infant fare and the stated age bands", () => {
  const fields = mapPosterTripToFields({
    title: "Вэлмор аялал",
    duration_days: 5,
    duration_nights: 4,
    price_table: {
      columns: ["Огноо", "Том хүн 12+ нас", "Хүүхэд 2-11 нас", "Нярай 0-23 сар"],
      rows: [{ dates: "7 сарын 06", cells: ["1,990,000₮", "1,701,000₮", "601,000₮"] }],
    },
  });
  assert.equal(fields.adult_price, 1990000);
  assert.equal(fields.child_price, 1701000);
  assert.equal(fields.infant_price, 601000);
  assert.deepEqual(fields.extra?.age_rules, { infant: "0-23 сар", child: "2-11 нас", adult: "12+ нас" });
  const group = fields.extra?.price_groups?.[0];
  assert.equal(group?.infant_price, 601000);
  assert.equal(group?.child_price, 1701000);
});

test("poster without an infant column leaves infant_price unset instead of guessing", () => {
  const fields = mapPosterTripToFields({
    title: "Торвал",
    price_table: {
      columns: ["Том хүн", "Хүүхэд"],
      rows: [{ dates: "8 сарын 03", cells: ["1,001,000₮", "901,000₮"] }],
    },
  });
  assert.equal(fields.infant_price, undefined);
  assert.equal(fields.extra?.age_rules, undefined);
});

test("website notes lead with the trip's own passenger tiers and age bands", () => {
  const details = websiteExtraDetails(
    { age_rules: { infant: "0-23 сар", child: "2-11 нас", adult: "12+ нас" } },
    { adult: 1990000, child: 1701000, infant: 601000, currency: "MNT" },
  );
  assert.deepEqual(details.childPriceNotes.slice(0, 3), [
    "Том хүн (12+ нас) - 1,990,000₮",
    "Хүүхэд (2-11 нас) - 1,701,000₮",
    "Нярай (0-23 сар) - 601,000₮",
  ]);
  // No bands saved and no fares → nothing invented.
  assert.deepEqual(websiteExtraDetails({}).childPriceNotes, []);
});

test("hotel-priced trips keep the static website note compact", () => {
  const details = websiteExtraDetails(
    {
      child_rules: [{ label: "Stale child fare", price: 99_999_999, currency: "MNT" }],
      price_groups: [{
        hotel: "Alpha Bay",
        date_keys: ["2026-10-01"],
        adult_price: 3_290_000,
        passenger_prices: [{ label: "Хүүхэд 6-11 нас", age_range: "6-11 нас", price: 3_090_000, currency: "MNT" }],
      }],
    },
    { adult: 2_690_000, child: 2_590_000, infant: 450_000, currency: "MNT" },
  );
  assert.deepEqual(details.childPriceNotes, [
    "Үнэ нь гарах өдөр, буудлын сонголтоос хамаарна. Доорх хэсгээс сонгоно уу.",
  ]);
});

test("website notes state each fare once, not once per base tier + child_rules + date group", () => {
  // The real bug (2026-09-30): a trip with a base child_price, a stale
  // child_rules array, AND non-hotel price groups restating the SAME fares
  // per date produced 7+ near-duplicate lines, including a malformed
  // imported child_rules row a customer would have read as the real price.
  const details = websiteExtraDetails(
    {
      age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-23 сар" },
      child_rules: [{ label: "Хүүхэд", age_range: "2-11 нас", price: 2_490_000, currency: "MNT" }],
      price_groups: [
        {
          dates: ["9 сарын 15"],
          display_dates: ["9 сарын 15"],
          adult_price: 2_790_000,
          passenger_prices: [{ label: "Хүүхэд", age_range: "2-11 нас", price: 2_490_000, currency: "MNT" }],
        },
        {
          dates: ["9 сарын 22"],
          display_dates: ["9 сарын 22"],
          adult_price: 2_690_000,
          passenger_prices: [],
        },
      ],
    },
    { adult: 2_790_000, child: 2_490_000, infant: 490_000, currency: "MNT" },
  );
  assert.deepEqual(details.childPriceNotes, [
    "Том хүн (12+ нас) - 2,790,000₮",
    "Хүүхэд (2-11 нас) - 2,490,000₮",
    "Нярай (0-23 сар) - 490,000₮",
    // 9/15's group matches the base fares exactly on every field — no line.
    // 9/22 genuinely differs (2,690,000 vs base 2,790,000) — kept, once.
    "9 сарын 22 - Том хүн 2,690,000₮",
  ]);
});

test("a placeholder sub-1,000₮ fare never reaches the website as a real price", () => {
  // Real live data: one trip's infant price was entered as "1₮" to get past
  // a required field, not a documented free fare or real price. The label
  // still shows (there IS an infant tier) but never with that number.
  const details = websiteExtraDetails(
    {},
    { adult: 1_090_000, child: 890_000, infant: 1, currency: "MNT" },
  );
  assert.deepEqual(details.childPriceNotes, [
    "Том хүн - 1,090,000₮",
    "Хүүхэд - 890,000₮",
    "Нярай",
  ]);
  assert.ok(!details.childPriceNotes.some((line) => /(?:^|\s)1₮(?:\s|$)/.test(line)));
});

test("a malformed imported child_rules row never reaches the website on its own", () => {
  // Real live data had a "Нярай - 1₮" / "24-20 нас" child_rules row that no
  // longer has anywhere to render from — child_rules is never read directly.
  const details = websiteExtraDetails(
    {
      child_rules: [{ label: "Нярай", age_range: "24-20 нас", price: 1, currency: "MNT" }],
    },
    { adult: 1_090_000, child: 890_000, infant: null, currency: "MNT" },
  );
  assert.deepEqual(details.childPriceNotes, [
    "Том хүн - 1,090,000₮",
    "Хүүхэд - 890,000₮",
  ]);
});
