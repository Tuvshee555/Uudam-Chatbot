import assert from "node:assert/strict";
import test from "node:test";
import { findWrongTripReference, type TripLike } from "../src/lib/tripConsistency";

const CATALOG: TripLike[] = [
  { route_name: "Вэлмор шууд нислэгтэй аялал", adult_price: 1210000, child_price: 1170000 },
  { route_name: "Вэлмор галт тэрэгний аялал", adult_price: 1490000, child_price: 1130000 },
  { route_name: "Мирвэн Нарвэл аялал", adult_price: 3200000, child_price: 2800000 },
  { route_name: "Тэлмор амралт", adult_price: 1250000, child_price: 1800000 },
];

// ---- The bug this guard exists to catch --------------------------------------

test("fires when the reply prices a different destination than the one asked about", () => {
  const leak = findWrongTripReference({
    replyText: "Вэлмор шууд нислэгтэй аялал: том хүн 1,210,000₮, хүүхэд 1,170,000₮.",
    relevantTripNames: ["Тэлмор амралт"],
    catalog: CATALOG,
  });
  assert.ok(leak, "asked Тэлмор, answered Вэлмор price → must be flagged");
  assert.equal(leak?.offendingTripName, "Вэлмор шууд нислэгтэй аялал");
});

// ---- The footgun cases: these must NEVER fire --------------------------------

test("stays out when no specific trip was resolved (broad / list / recommend question)", () => {
  // relevantTripNames empty is exactly the state for "which trips do you have",
  // "cheapest one", family recommendations — priced multi-trip answers are correct.
  const leak = findWrongTripReference({
    replyText: "Одоогоор 3 аялал байна: Вэлмор 1,210,000₮, Мирвэн 3,200,000₮, Тэлмор 1,250,000₮.",
    relevantTripNames: [],
    catalog: CATALOG,
  });
  assert.equal(leak, null);
});

test("does not fire on a same-destination variant (asked Вэлмор flight, answered Вэлмор rail)", () => {
  const leak = findWrongTripReference({
    replyText: "Вэлмор галт тэрэгний аялал: том хүн 1,490,000₮.",
    relevantTripNames: ["Вэлмор шууд нислэгтэй аялал"],
    catalog: CATALOG,
  });
  assert.equal(leak, null, "same city = on-topic, must not be suppressed");
});

test("does not fire on a compare answer that names both relevant trips", () => {
  const leak = findWrongTripReference({
    replyText:
      "Вэлмор шууд нислэгтэй аялал 1,210,000₮, Мирвэн Нарвэл аялал 3,200,000₮ — Вэлмор хямд.",
    relevantTripNames: ["Вэлмор шууд нислэгтэй аялал", "Мирвэн Нарвэл аялал"],
    catalog: CATALOG,
  });
  assert.equal(leak, null);
});

test("does not fire when the reply is on-topic (mentions the asked-for trip)", () => {
  const leak = findWrongTripReference({
    replyText: "Тэлмор амралт: том хүн 1,250,000₮, хүүхэд 1,800,000₮.",
    relevantTripNames: ["Тэлмор амралт"],
    catalog: CATALOG,
  });
  assert.equal(leak, null);
});

test("does not fire on a priceless clarifier even when a trip was resolved", () => {
  const leak = findWrongTripReference({
    replyText: "Тэлмор аялалын талаар үнэ, огноо, эсвэл хөтөлбөрөөс аль нь хэрэгтэй вэ?",
    relevantTripNames: ["Тэлмор амралт"],
    catalog: CATALOG,
  });
  assert.equal(leak, null, "no price quoted = nothing confidently wrong to suppress");
});

test("does not fire when the reply prices the asked trip AND mentions another in passing", () => {
  // On-topic answer that also references a second destination must stay: the
  // relevant destination IS present, so condition 2 keeps the guard out.
  const leak = findWrongTripReference({
    replyText: "Тэлмор амралт 1,250,000₮. Мирвэн ч бас байгаа, сонирхвол хэлээрэй.",
    relevantTripNames: ["Тэлмор амралт"],
    catalog: CATALOG,
  });
  assert.equal(leak, null);
});
