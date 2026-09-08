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
    title: "Бээжин аялал",
    duration_days: 5,
    duration_nights: 4,
    price_table: {
      columns: ["Огноо", "Том хүн 12+ нас", "Хүүхэд 2-11 нас", "Нярай 0-23 сар"],
      rows: [{ dates: "7 сарын 06", cells: ["1,990,000₮", "1,690,000₮", "590,000₮"] }],
    },
  });
  assert.equal(fields.adult_price, 1990000);
  assert.equal(fields.child_price, 1690000);
  assert.equal(fields.infant_price, 590000);
  assert.deepEqual(fields.extra?.age_rules, { infant: "0-23 сар", child: "2-11 нас", adult: "12+ нас" });
  const group = fields.extra?.price_groups?.[0];
  assert.equal(group?.infant_price, 590000);
  assert.equal(group?.child_price, 1690000);
});

test("poster without an infant column leaves infant_price unset instead of guessing", () => {
  const fields = mapPosterTripToFields({
    title: "Хайлаар",
    price_table: {
      columns: ["Том хүн", "Хүүхэд"],
      rows: [{ dates: "8 сарын 03", cells: ["990,000₮", "890,000₮"] }],
    },
  });
  assert.equal(fields.infant_price, undefined);
  assert.equal(fields.extra?.age_rules, undefined);
});

test("website notes lead with the trip's own passenger tiers and age bands", () => {
  const details = websiteExtraDetails(
    { age_rules: { infant: "0-23 сар", child: "2-11 нас", adult: "12+ нас" } },
    { adult: 1990000, child: 1690000, infant: 590000, currency: "MNT" },
  );
  assert.deepEqual(details.childPriceNotes.slice(0, 3), [
    "Том хүн (12+ нас) - 1,990,000₮",
    "Хүүхэд (2-11 нас) - 1,690,000₮",
    "Нярай (0-23 сар) - 590,000₮",
  ]);
  // No bands saved and no fares → nothing invented.
  assert.deepEqual(websiteExtraDetails({}).childPriceNotes, []);
});
