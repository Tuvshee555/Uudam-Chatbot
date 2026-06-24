import assert from "node:assert/strict";
import test from "node:test";
import { buildStructuredTripReply } from "../src/lib/travelFastPaths";
import type { TravelTrip } from "../src/lib/travelOps";

const NOW = new Date("2026-06-24T04:00:00.000Z");

function trip(fields: Partial<TravelTrip>): TravelTrip {
  return {
    id: "trip-1",
    category: "Outbound",
    operator_name: "Uudam Travel",
    route_name: "Тэнгэрийн хаалга - шууд нислэгтэй",
    duration_text: "5 өдөр / 4 шөнө",
    adult_price: 3290000,
    child_price: 2990000,
    currency: "MNT",
    departure_dates: ["6 сарын 27", "7 сарын 18"],
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

test("matches Zhangjiajie alias to the Shanghai + Tengeriin Khaalga route", () => {
  const reply = buildStructuredTripReply(
    "Шанхай Жанжиажэ аяллын 6 сарын 27, 7 сарын 18 үнэ адилхан уу?",
    [
      trip({
        id: "shanghai",
        route_name: "Шанхай + Тэнгэрийн хаалга шууд нислэгтэй аялал",
        duration_text: "6 өдөр / 5 шөнө",
        adult_price: 3590000,
        child_price: 3260000,
        extra: {
          departure_date_groups: [
            {
              dates: ["6 сарын 27"],
              adult_price: 3590000,
              child_price: 3260000,
            },
            {
              dates: ["7 сарын 18"],
              adult_price: 3660000,
              child_price: 3260000,
            },
          ],
        },
      }),
      trip({
        id: "beidaihe",
        route_name: "Бэйдайхэ, Далянь хотын аялал",
        duration_text: "8 өдөр / 7 шөнө",
        adult_price: 2690000,
        child_price: 2390000,
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /Шанхай \+ Тэнгэрийн хаалга/);
  assert.match(reply || "", /адил биш/);
  assert.doesNotMatch(reply || "", /Бэйдайхэ/);
});

test("prefers the direct-flight Tengeriin Khaalga trip over longer variants", () => {
  const reply = buildStructuredTripReply(
    "Тэнгэрийн хаалга шууд нислэгтэй аялал хэд вэ?",
    [
      trip({
        id: "base",
        route_name: "Тэнгэрийн хаалга - шууд нислэгтэй",
        adult_price: 3290000,
        child_price: 2990000,
      }),
      trip({
        id: "with-chongqing",
        route_name: "Тэнгэрийн хаалга-Чунчин",
        adult_price: 3590000,
        child_price: 3260000,
      }),
      trip({
        id: "with-shanghai",
        route_name: "Шанхай + Тэнгэрийн хаалга шууд нислэгтэй аялал",
        adult_price: 3590000,
        child_price: 3260000,
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /^✈️ Тэнгэрийн хаалга - шууд нислэгтэй/m);
  assert.match(reply || "", /3,290,000₮/);
  assert.doesNotMatch(reply || "", /Шанхай \+/);
  assert.doesNotMatch(reply || "", /Чунчин/);
});

test("answers that hybrid land+flight route is not a direct flight", () => {
  const reply = buildStructuredTripReply(
    "Бээжин Бэйдэхэ газар нислэг хосолсон аялал шууд нислэгтэй юу?",
    [
      trip({
        id: "hybrid",
        route_name: "Бэйдайхэ+Бээжин газар нислэг хосолсон аялал",
        duration_text: "9 өдөр / 8 шөнө",
        adult_price: 2030000,
        child_price: 1590000,
        source_description: "Газар нислэг хосолсон маршрут",
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /шууд нислэгтэй биш/);
  assert.match(reply || "", /9 өдөр \/ 8 шөнө/);
});
