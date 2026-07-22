import assert from "node:assert/strict";
import test from "node:test";
import { findWrongTripReference, type TripLike } from "../src/lib/tripConsistency";

const CATALOG: TripLike[] = [
  { route_name: "Бээжин шууд нислэгтэй аялал", adult_price: 1890000, child_price: 1590000 },
  { route_name: "Бээжин галт тэрэгний аялал", adult_price: 1490000, child_price: 1290000 },
  { route_name: "Хайнан Саньяа аялал", adult_price: 3200000, child_price: 2800000 },
  { route_name: "Далянь амралт", adult_price: 2100000, child_price: 1800000 },
];

// ---- The bug this guard exists to catch --------------------------------------

test("fires when the reply prices a different destination than the one asked about", () => {
  const leak = findWrongTripReference({
    replyText: "Бээжин шууд нислэгтэй аялал: том хүн 1,890,000₮, хүүхэд 1,590,000₮.",
    relevantTripNames: ["Далянь амралт"],
    catalog: CATALOG,
  });
  assert.ok(leak, "asked Далянь, answered Бээжин price → must be flagged");
  assert.equal(leak?.offendingTripName, "Бээжин шууд нислэгтэй аялал");
});

// ---- The footgun cases: these must NEVER fire --------------------------------

test("stays out when no specific trip was resolved (broad / list / recommend question)", () => {
  // relevantTripNames empty is exactly the state for "which trips do you have",
  // "cheapest one", family recommendations — priced multi-trip answers are correct.
  const leak = findWrongTripReference({
    replyText: "Одоогоор 3 аялал байна: Бээжин 1,890,000₮, Хайнан 3,200,000₮, Далянь 2,100,000₮.",
    relevantTripNames: [],
    catalog: CATALOG,
  });
  assert.equal(leak, null);
});

test("does not fire on a same-destination variant (asked Бээжин flight, answered Бээжин rail)", () => {
  const leak = findWrongTripReference({
    replyText: "Бээжин галт тэрэгний аялал: том хүн 1,490,000₮.",
    relevantTripNames: ["Бээжин шууд нислэгтэй аялал"],
    catalog: CATALOG,
  });
  assert.equal(leak, null, "same city = on-topic, must not be suppressed");
});

test("does not fire on a compare answer that names both relevant trips", () => {
  const leak = findWrongTripReference({
    replyText:
      "Бээжин шууд нислэгтэй аялал 1,890,000₮, Хайнан Саньяа аялал 3,200,000₮ — Бээжин хямд.",
    relevantTripNames: ["Бээжин шууд нислэгтэй аялал", "Хайнан Саньяа аялал"],
    catalog: CATALOG,
  });
  assert.equal(leak, null);
});

test("does not fire when the reply is on-topic (mentions the asked-for trip)", () => {
  const leak = findWrongTripReference({
    replyText: "Далянь амралт: том хүн 2,100,000₮, хүүхэд 1,800,000₮.",
    relevantTripNames: ["Далянь амралт"],
    catalog: CATALOG,
  });
  assert.equal(leak, null);
});

test("does not fire on a priceless clarifier even when a trip was resolved", () => {
  const leak = findWrongTripReference({
    replyText: "Далянь аялалын талаар үнэ, огноо, эсвэл хөтөлбөрөөс аль нь хэрэгтэй вэ?",
    relevantTripNames: ["Далянь амралт"],
    catalog: CATALOG,
  });
  assert.equal(leak, null, "no price quoted = nothing confidently wrong to suppress");
});

test("does not fire when the reply prices the asked trip AND mentions another in passing", () => {
  // On-topic answer that also references a second destination must stay: the
  // relevant destination IS present, so condition 2 keeps the guard out.
  const leak = findWrongTripReference({
    replyText: "Далянь амралт 2,100,000₮. Хайнан ч бас байгаа, сонирхвол хэлээрэй.",
    relevantTripNames: ["Далянь амралт"],
    catalog: CATALOG,
  });
  assert.equal(leak, null);
});
