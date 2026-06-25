import assert from "node:assert/strict";
import test from "node:test";
import { buildCompareReply, buildDiscountReply, buildSeatsReply, buildStructuredTripReply, buildTripProgramReply } from "../src/lib/travelFastPaths";
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

test("discount questions still show regular price when no promo price is stored", () => {
  const reply = buildDiscountReply(
    "Хайнан Хайкоу аяллын хямдралтай үнэ байгаа юу?",
    [
      trip({
        id: "haikou",
        route_name: "Хайнан - Хайкоу шууд нислэгтэй аялал",
        duration_text: "8 өдөр / 7 шөнө",
        adult_price: 2990000,
        child_price: 2790000,
        departure_dates: ["7 сарын 5", "7 сарын 12"],
      }),
    ],
  );

  assert.match(reply || "", /Хямдралтай үнийн мэдээлэл/);
  assert.match(reply || "", /2,990,000₮/);
  assert.match(reply || "", /2,790,000₮/);
  assert.match(reply || "", /7 сарын 5/);
});

test("same-price comparison fails safe when date-group prices are not stored", () => {
  const reply = buildStructuredTripReply(
    "Шанхай Жанжиажэ аяллын 6 сарын 27, 7 сарын 18 үнэ адилхан уу?",
    [
      trip({
        id: "shanghai-missing-groups",
        route_name: "Шанхай + Тэнгэрийн хаалга шууд нислэгтэй аялал",
        duration_text: "8 өдөр / 7 шөнө",
        adult_price: 3590000,
        child_price: 3260000,
        departure_dates: ["6 сарын 27", "7 сарын 18"],
        extra: {},
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /үнэ|Том хүн/);
  assert.doesNotMatch(reply || "", /адилхан байна/);
});


test("combined date and price query returns only the exact matching tour", () => {
  const reply = buildStructuredTripReply(
    "7/9 Ð½Ð¸Ð¹ 2150000 Ñ‹Ð½ Ð°ÑÐ»Ð°Ð»Ñ‹Ð³ Ò¯Ð·Ð¼ÑÑ€ Ð±Ð°Ð¹Ð½Ð°",
    [
      trip({
        id: "beidaihe-flight",
        route_name: "Ð‘ÑÐ¹Ð´Ð°Ð¹Ñ…Ñ+Ð‘ÑÑÐ¶Ð¸Ð½ Ð³Ð°Ð·Ð°Ñ€ Ð½Ð¸ÑÐ»ÑÐ³ Ñ…Ð¾ÑÐ¾Ð»ÑÐ¾Ð½ Ð°ÑÐ»Ð°Ð»",
        duration_text: "9 Ó©Ð´Ó©Ñ€ / 8 ÑˆÓ©Ð½Ó©",
        adult_price: 2030000,
        child_price: 1590000,
        source_description: "Ð“Ð°Ð·Ð°Ñ€ Ð½Ð¸ÑÐ»ÑÐ³ Ñ…Ð¾ÑÐ¾Ð»ÑÐ¾Ð½ Ð¼Ð°Ñ€ÑˆÑ€ÑƒÑ‚",
        departure_dates: ["7 ÑÐ°Ñ€Ñ‹Ð½ 9", "7 ÑÐ°Ñ€Ñ‹Ð½ 16"],
        extra: {
          price_groups: [
            {
              dates: ["7 ÑÐ°Ñ€Ñ‹Ð½ 9"],
              adult_price: 2150000,
              child_price: 1710000,
              infant_price: 530000,
            },
            {
              dates: ["7 ÑÐ°Ñ€Ñ‹Ð½ 16"],
              adult_price: 2030000,
              child_price: 1590000,
              infant_price: 530000,
            },
          ],
        },
      }),
      trip({
        id: "wrong-price",
        route_name: "Ð‘ÑÑÐ¶Ð¸Ð½ Ñ…Ð¾Ñ‚Ñ‹Ð½ Ð°ÑÐ»Ð°Ð»",
        duration_text: "5 Ó©Ð´Ó©Ñ€ / 4 ÑˆÓ©Ð½Ó©",
        adult_price: 1990000,
        departure_dates: ["7 ÑÐ°Ñ€Ñ‹Ð½ 9"],
        extra: {
          price_groups: [
            {
              dates: ["7 ÑÐ°Ñ€Ñ‹Ð½ 9"],
              adult_price: 1990000,
              child_price: 1690000,
            },
          ],
        },
      }),
      trip({
        id: "same-date-other-route",
        route_name: "Ð–Ð¸Ð½Ð¸Ð½ Ð¼Ð¸Ð½Ð¸ Ð°Ð²Ð°Ñ‚Ð°Ñ€",
        duration_text: "4 Ó©Ð´Ó©Ñ€ / 3 ÑˆÓ©Ð½Ó©",
        adult_price: 1090000,
        departure_dates: ["7 ÑÐ°Ñ€Ñ‹Ð½ 9"],
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /2150000|2,150,000/);
  assert.match(reply || "", /Ð‘ÑÐ¹Ð´Ð°Ð¹Ñ…Ñ\+Ð‘ÑÑÐ¶Ð¸Ð½/);
  assert.doesNotMatch(reply || "", /Ð–Ð¸Ð½Ð¸Ð½/);
  assert.doesNotMatch(reply || "", /Ð‘ÑÑÐ¶Ð¸Ð½ Ñ…Ð¾Ñ‚Ñ‹Ð½ Ð°ÑÐ»Ð°Ð»/);
});

test("combined date and price query falls back to close matches on the same date only", () => {
  const reply = buildStructuredTripReply(
    "7/9 2250000 Ð°ÑÐ»Ð°Ð»",
    [
      trip({
        id: "close-a",
        route_name: "Ð‘ÑÐ¹Ð´Ð°Ð¹Ñ…Ñ+Ð‘ÑÑÐ¶Ð¸Ð½ Ð³Ð°Ð·Ð°Ñ€ Ð½Ð¸ÑÐ»ÑÐ³ Ñ…Ð¾ÑÐ¾Ð»ÑÐ¾Ð½ Ð°ÑÐ»Ð°Ð»",
        duration_text: "9 Ó©Ð´Ó©Ñ€ / 8 ÑˆÓ©Ð½Ó©",
        departure_dates: ["7 ÑÐ°Ñ€Ñ‹Ð½ 9"],
        extra: {
          price_groups: [
            {
              dates: ["7 ÑÐ°Ñ€Ñ‹Ð½ 9"],
              adult_price: 2150000,
              child_price: 1710000,
            },
          ],
        },
      }),
      trip({
        id: "close-b",
        route_name: "Ð‘ÑÑÐ¶Ð¸Ð½ ÑˆÑƒÑƒÐ´ Ð½Ð¸ÑÐ»ÑÐ³Ñ‚ÑÐ¹",
        duration_text: "5 Ó©Ð´Ó©Ñ€ / 4 ÑˆÓ©Ð½Ó©",
        departure_dates: ["7 ÑÐ°Ñ€Ñ‹Ð½ 9"],
        extra: {
          price_groups: [
            {
              dates: ["7 ÑÐ°Ñ€Ñ‹Ð½ 9"],
              adult_price: 2290000,
              child_price: 1890000,
            },
          ],
        },
      }),
      trip({
        id: "other-date",
        route_name: "Ð¥Ð°Ð¹Ð½Ð°Ð½ ÑˆÑƒÑƒÐ´ Ð½Ð¸ÑÐ»ÑÐ³Ñ‚ÑÐ¹",
        duration_text: "8 Ó©Ð´Ó©Ñ€ / 7 ÑˆÓ©Ð½Ó©",
        departure_dates: ["7 ÑÐ°Ñ€Ñ‹Ð½ 12"],
        extra: {
          price_groups: [
            {
              dates: ["7 ÑÐ°Ñ€Ñ‹Ð½ 12"],
              adult_price: 2250000,
            },
          ],
        },
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /2250000|2,250,000/);
  assert.match(reply || "", /Ð‘ÑÐ¹Ð´Ð°Ð¹Ñ…Ñ\+Ð‘ÑÑÐ¶Ð¸Ð½/);
  assert.match(reply || "", /Ð‘ÑÑÐ¶Ð¸Ð½ ÑˆÑƒÑƒÐ´ Ð½Ð¸ÑÐ»ÑÐ³Ñ‚ÑÐ¹/);
  assert.doesNotMatch(reply || "", /Ð¥Ð°Ð¹Ð½Ð°Ð½/);
});

test("program request prefers brochure pdf over images and itinerary", () => {
  const result = buildTripProgramReply(
    "Ð‘ÑÐ¹Ð´Ð°Ð¹Ñ…Ñ Ð°ÑÐ»Ð»Ñ‹Ð½ Ð´ÑÐ»Ð³ÑÑ€ÑÐ½Ð³Ò¯Ð¹ Ñ…Ó©Ñ‚Ó©Ð»Ð±Ó©Ñ€ pdf",
    [
      trip({
        id: "program-pdf",
        route_name: "Ð‘ÑÐ¹Ð´Ð°Ð¹Ñ…Ñ Ð°ÑÐ»Ð°Ð»",
        extra: {
          brochure_pdf_url: "https://example.com/program.pdf",
          program_images: ["https://example.com/program-1.jpg"],
          itinerary_days: [{ day: 1, title: "Ð¯Ð²Ð°Ñ…" }],
        },
      }),
    ],
  );

  assert.equal(result?.brochure?.type, "url");
  assert.equal(result?.brochure?.value, "https://example.com/program.pdf");
  assert.deepEqual(result?.mediaUrls, []);
  assert.match(result?.reply || "", /pdf/i);
});

test("program request sends program images when brochure is missing", () => {
  const result = buildTripProgramReply(
    "Ð¨Ð°Ð½Ñ…Ð°Ð¹ Ð°ÑÐ»Ð»Ñ‹Ð½ program Ð·ÑƒÑ€Ð°Ð³",
    [
      trip({
        id: "program-images",
        route_name: "Ð¨Ð°Ð½Ñ…Ð°Ð¹ Ð°ÑÐ»Ð°Ð»",
        extra: {
          media_assets: [
            { type: "program_image", url: "https://example.com/program-1.jpg" },
            { type: "poster", url: "https://example.com/poster.jpg" },
          ],
        },
      }),
    ],
  );

  assert.equal(result?.brochure, null);
  assert.deepEqual(result?.mediaUrls, ["https://example.com/program-1.jpg"]);
  assert.match(result?.reply || "", /Ð¸Ð»Ð³ÑÑÐ¶|илгээж/);
});

test("program request summarizes itinerary when no file assets exist", () => {
  const result = buildTripProgramReply(
    "Ð¥Ð°Ð¹Ð½Ð°Ð½ Ð°ÑÐ»Ð»Ñ‹Ð½ day by day program",
    [
      trip({
        id: "program-itinerary",
        route_name: "Ð¥Ð°Ð¹Ð½Ð°Ð½ Ð°ÑÐ»Ð°Ð»",
        extra: {
          itinerary_days: [
            { day: 1, title: "Ð£Ð»Ð°Ð°Ð½Ð±Ð°Ð°Ñ‚Ð°Ñ€-Ð¡Ð°Ð½ÑŒÑÐ°", description: "ÐÐ¸ÑÐ½Ñ" },
            { day: 2, title: "Ð§Ó©Ð»Ó©Ó©Ñ‚ Ó©Ð´Ó©Ñ€", description: "ÐÐ°Ð»Ð°Ð¹Ð½ ÑÑ€ÑÐ³" },
          ],
        },
      }),
    ],
  );

  assert.equal(result?.brochure, null);
  assert.deepEqual(result?.mediaUrls, []);
  assert.match(result?.reply || "", /•/);
  assert.match(result?.reply || "", /1/);
  assert.match(result?.reply || "", /2/);
});

test("program request falls back politely when no program asset exists", () => {
  const result = buildTripProgramReply(
    "Ð¢ÑÐ½Ð³ÑÑ€Ð¸Ð¹Ð½ Ñ…Ð°Ð°Ð»Ð³Ð° program",
    [
      trip({
        id: "program-none",
        route_name: "Ð¢ÑÐ½Ð³ÑÑ€Ð¸Ð¹Ð½ Ñ…Ð°Ð°Ð»Ð³Ð°",
        extra: {},
      }),
    ],
  );

  assert.equal(result?.brochure, null);
  assert.deepEqual(result?.mediaUrls, []);
  assert.match(result?.reply || "", /Ð·Ó©Ð²Ð»Ó©Ñ…|зөвлөх/);
  assert.doesNotMatch(result?.reply || "", /database|Ð¼ÑÐ´ÑÑÐ»Ð»Ð¸Ð¹Ð½ ÑÐ°Ð½/i);
});

test("seat reply omits seat wording when seats are unknown", () => {
  const reply = buildSeatsReply(
    "Тэнгэрийн хаалга аяллын суудал байна уу?",
    [trip({ seats_left: null, seats_total: 20 })],
  );

  assert.match(reply || "", /Тэнгэрийн/);
  assert.doesNotMatch(reply || "", /суудлын мэдээлэл|үлдсэн суудал|суудал дүүрсэн|цөөн үлдсэн/i);
});

test("seat reply omits seat wording when more than seven seats remain", () => {
  const reply = buildSeatsReply(
    "Тэнгэрийн хаалга аяллын суудал байна уу?",
    [trip({ seats_left: 12, seats_total: 20 })],
  );

  assert.match(reply || "", /Тэнгэрийн/);
  assert.doesNotMatch(reply || "", /12|үлдсэн суудал|цөөн үлдсэн|суудал дүүрсэн/i);
});

test("seat reply shows urgency when only a few seats remain", () => {
  const reply = buildSeatsReply(
    "Тэнгэрийн хаалга аяллын суудал байна уу?",
    [trip({ seats_left: 3, seats_total: 20 })],
  );

  assert.match(reply || "", /Суудал цөөн үлдсэн тул захиалга өгөх бол аяллын зөвлөхтэй хурдан холбогдоорой./);
});

test("seat reply marks departure full only when seats_left is zero", () => {
  const reply = buildSeatsReply(
    "Тэнгэрийн хаалга аяллын суудал байна уу?",
    [trip({ seats_left: 0, seats_total: 20, status: "active" })],
  );

  assert.match(reply || "", /энэ гаралтын суудал дүүрсэн байна/);
  assert.match(reply || "", /Дараагийн гарах өдрийг санал болгоё/);
});

test("compare reply shows seat wording only for scarcity", () => {
  const reply = buildCompareReply(
    "Тэнгэрийн хаалга Чүнчин харьцуул",
    [
      trip({
        id: "scarce",
        route_name: "Тэнгэрийн хаалга - шууд нислэгтэй",
        seats_left: 4,
      }),
      trip({
        id: "plenty",
        route_name: "Тэнгэрийн хаалга-Чүнчин",
        seats_left: 12,
      }),
    ],
  );

  assert.match(reply || "", /Суудал цөөн үлдсэн тул захиалга өгөх бол аяллын зөвлөхтэй хурдан холбогдоорой./);
  assert.doesNotMatch(reply || "", /Үлдсэн суудал: 12/);
});
