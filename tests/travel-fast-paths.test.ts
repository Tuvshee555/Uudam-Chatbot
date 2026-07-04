import assert from "node:assert/strict";
import test from "node:test";
import { appendLeadCaptureCta, buildCompareReply, buildDiscountReply, buildSeatsReply, buildStructuredTripReply, buildTripProgramReply, LEAD_CAPTURE_CTA, resolveTripFromUserMessage } from "../src/lib/travelFastPaths";
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

test("shared city-only trip resolver returns ambiguous instead of guessing", () => {
  const resolution = resolveTripFromUserMessage("Tokyo une hed ve?", [
    trip({ id: "tokyo-fuji", route_name: "Tokyo Fuji аялал" }),
    trip({ id: "tokyo-universal", route_name: "Tokyo Universal аялал" }),
  ]);

  assert.equal(resolution.status, "ambiguous");
  assert.deepEqual(
    resolution.candidates.map((candidate) => candidate.id),
    ["tokyo-fuji", "tokyo-universal"],
  );
});

test("appendLeadCaptureCta adds the phone ask to a normal fast-path answer", () => {
  const out = appendLeadCaptureCta("✈️ Бээжин аялал\n💰 Том хүн: 1,890,000₮", false);
  assert.match(out, /1,890,000₮/);
  assert.ok(out.endsWith(LEAD_CAPTURE_CTA));
});

test("appendLeadCaptureCta skips when phone already collected", () => {
  const reply = "✈️ Бээжин аялал\n💰 Том хүн: 1,890,000₮";
  assert.equal(appendLeadCaptureCta(reply, true), reply);
});

test("appendLeadCaptureCta skips clarifying (ambiguous) replies", () => {
  const ambiguous = buildStructuredTripReply("Tokyo une hed ve?", [
    trip({ id: "tokyo-fuji", route_name: "Tokyo Fuji аялал", adult_price: 3490000 }),
    trip({ id: "tokyo-universal", route_name: "Tokyo Universal аялал", adult_price: 1790000 }),
  ]);
  assert.ok(ambiguous);
  const out = appendLeadCaptureCta(ambiguous as string, false);
  assert.equal(out, ambiguous);
  assert.doesNotMatch(out, new RegExp(LEAD_CAPTURE_CTA));
});

test("appendLeadCaptureCta does not double-ask when reply already requests a phone", () => {
  const reply = "Захиалахын тулд утасны дугаараа үлдээгээрэй.";
  assert.equal(appendLeadCaptureCta(reply, false), reply);
});

test("structured reply asks for clarification on shared city-only query", () => {
  const reply = buildStructuredTripReply("Tokyo une hed ve?", [
    trip({ id: "tokyo-fuji", route_name: "Tokyo Fuji аялал", adult_price: 3490000 }),
    trip({ id: "tokyo-universal", route_name: "Tokyo Universal аялал", adult_price: 1790000 }),
  ]);

  assert.match(reply || "", /Аль аяллыг хэлж/i);
  assert.match(reply || "", /Tokyo Fuji/);
  assert.match(reply || "", /Tokyo Universal/);
  assert.doesNotMatch(reply || "", /3,490,000|1,790,000/);
});

test("program reply asks for clarification on shared city-only PDF request", () => {
  const result = buildTripProgramReply("Tokyo program pdf", [
    trip({
      id: "tokyo-fuji",
      route_name: "Tokyo Fuji аялал",
      extra: { program_images: ["https://example.com/fuji-program.jpg"] },
    }),
    trip({
      id: "tokyo-universal",
      route_name: "Tokyo Universal аялал",
      extra: { program_images: ["https://example.com/universal-program.jpg"] },
    }),
  ]);

  assert.match(result?.reply || "", /Аль аяллыг хэлж/i);
  assert.equal(result?.trip, null);
  assert.deepEqual(result?.mediaUrls, []);
});

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
          aliases: ["Жанжиажэ", "Zhangjiajie", "Шанхай Жанжиажэ"],
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
        extra: { aliases: ["Бэйдэхэ", "Бэйдэйхэ", "Beidaihe"] },
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
        extra: { aliases: ["Жанжиажэ", "Шанхай Жанжиажэ"] },
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

test("route-only query uses spaced premium formatting", () => {
  const reply = buildStructuredTripReply(
    "Бээжин Бэйдэхэ газар нислэг хосолсон аялал",
    [
      trip({
        id: "beidaihe-premium",
        route_name: "Бэйдайхэ + Бээжин газар нислэг хосолсон аялал",
        duration_text: "9 өдөр / 8 шөнө",
        departure_dates: ["6 сарын 20", "6 сарын 27", "7 сарын 9", "7 сарын 18", "7 сарын 27", "8 сарын 1", "8 сарын 8", "8 сарын 15", "8 сарын 22"],
        extra: {
          aliases: ["Бэйдэхэ", "Бэйдэйхэ", "Beidaihe"],
          price_groups: [
            {
              dates: ["6 сарын 20", "6 сарын 27"],
              adult_price: 2030000,
              child_price: 1590000,
              infant_price: 530000,
              child_age: "2–10 нас",
              infant_age: "0–23 сар",
            },
            {
              dates: ["7 сарын 9", "7 сарын 18", "7 сарын 27", "8 сарын 1", "8 сарын 8", "8 сарын 15", "8 сарын 22"],
              adult_price: 2150000,
              child_price: 1710000,
              infant_price: 530000,
              child_age: "2–10 нас",
              infant_age: "0–23 сар",
            },
          ],
        },
        source_description: "Газар нислэг хосолсон маршрут",
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /\n\n🗓 Хугацаа:/);
  assert.match(reply || "", /\n\n💰 Үнэ:/);
  assert.match(reply || "", /• Том хүн:/);
  assert.match(reply || "", /• Хүүхэд/);
  assert.match(reply || "", /\n\n📅 Гарах өдрүүд:\n/);
  // 6/20 is before NOW (2026-06-24) so it is filtered out as a past departure;
  // the schedule line starts at the first future date, 6/27.
  assert.match(reply || "", /6\/27, 7\/9/);
  assert.doesNotMatch(reply || "", /6\/20/);
  assert.match(reply || "", /Та аль гарах өдрийг сонирхож байна вэ/);
  assert.doesNotMatch(reply || "", /\|/);
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

  // Photo-only flow prefers program images over brochure links.
  assert.equal(result?.brochure, null);
  assert.deepEqual(result?.mediaUrls, ["https://example.com/program-1.jpg"]);
  assert.doesNotMatch(result?.reply || "", /https:\/\/example\.com\/program\.pdf/);
});

test("program request prefers the ground Beidaihe + Beijing tour for газрын аяллын phrasing", () => {
  const result = buildTripProgramReply(
    "Бээжин + Бэйдэхэ газрын аяллын хөтөлбөр үзэх",
    [
      trip({
        id: "ground-tour",
        route_name: "Шар тэнгис буюу Бэйдайхэ-Бээжингийн газрын аялал",
        category: "газрын аялал",
        extra: {
          aliases: [
            "Бэйдайхэ Бээжин газрын аялал",
            "Бэйдэхэ Бээжин газрын",
            "Шар тэнгис Бэйдайхэ Бээжин",
          ],
          brochure_pdf_url: "https://example.com/ground-tour.pdf",
        },
      }),
      trip({
        id: "combo-tour",
        route_name: "Бэйдайхэ шар тэнгисийн эрэг + Бээжин газар нислэг хосолсон аялал",
        category: "газар + нислэг хосолсон",
        extra: {
          aliases: [
            "Бээжин Бэйдэхэ газар нислэг хосолсон",
            "Бэйдэхэ Бээжин газар нислэг",
          ],
        },
      }),
    ],
  );

  assert.equal(result?.trip?.id, "ground-tour");
  // Photo-only flow no longer exposes brochure links in the reply text.
  assert.equal(result?.brochure, null);
  assert.match(result?.reply || "", /Шар тэнгис буюу Бэйдайхэ-Бээжингийн газрын аялал/);
  assert.doesNotMatch(result?.reply || "", /https:\/\/example\.com\/ground-tour\.pdf/);
});

test("program request prefers the combo tour when user explicitly says газар нислэг хосолсон", () => {
  const result = buildTripProgramReply(
    "Ð‘ÑÑÐ¶Ð¸Ð½ + Ð‘ÑÐ¹Ð´ÑÑ…Ñ Ð³Ð°Ð·Ð°Ñ€ Ð½Ð¸ÑÐ»ÑÐ³ Ñ…Ð¾ÑÐ¾Ð»ÑÐ¾Ð½ program",
    [
      trip({
        id: "ground-tour",
        route_name: "Ð¨Ð°Ñ€ Ñ‚ÑÐ½Ð³Ð¸Ñ Ð±ÑƒÑŽÑƒ Ð‘ÑÐ¹Ð´Ð°Ð¹Ñ…Ñ-Ð‘ÑÑÐ¶Ð¸Ð½Ð³Ð¸Ð¹Ð½ Ð³Ð°Ð·Ñ€Ñ‹Ð½ Ð°ÑÐ»Ð°Ð»",
        category: "Ð³Ð°Ð·Ñ€Ñ‹Ð½ Ð°ÑÐ»Ð°Ð»",
        extra: {
          aliases: [
            "Ð‘ÑÐ¹Ð´Ð°Ð¹Ñ…Ñ Ð‘ÑÑÐ¶Ð¸Ð½ Ð³Ð°Ð·Ñ€Ñ‹Ð½ Ð°ÑÐ»Ð°Ð»",
            "Ð‘ÑÐ¹Ð´ÑÑ…Ñ Ð‘ÑÑÐ¶Ð¸Ð½ Ð³Ð°Ð·Ñ€Ñ‹Ð½",
          ],
          brochure_pdf_url: "https://example.com/ground-tour.pdf",
        },
      }),
      trip({
        id: "combo-tour",
        route_name: "Ð‘ÑÐ¹Ð´Ð°Ð¹Ñ…Ñ ÑˆÐ°Ñ€ Ñ‚ÑÐ½Ð³Ð¸ÑÐ¸Ð¹Ð½ ÑÑ€ÑÐ³ + Ð‘ÑÑÐ¶Ð¸Ð½ Ð³Ð°Ð·Ð°Ñ€ Ð½Ð¸ÑÐ»ÑÐ³ Ñ…Ð¾ÑÐ¾Ð»ÑÐ¾Ð½ Ð°ÑÐ»Ð°Ð»",
        category: "Ð³Ð°Ð·Ð°Ñ€ + Ð½Ð¸ÑÐ»ÑÐ³ Ñ…Ð¾ÑÐ¾Ð»ÑÐ¾Ð½",
        extra: {
          aliases: [
            "Ð‘ÑÑÐ¶Ð¸Ð½ Ð‘ÑÐ¹Ð´ÑÑ…Ñ Ð³Ð°Ð·Ð°Ñ€ Ð½Ð¸ÑÐ»ÑÐ³ Ñ…Ð¾ÑÐ¾Ð»ÑÐ¾Ð½",
            "Ð‘ÑÐ¹Ð´ÑÑ…Ñ Ð‘ÑÑÐ¶Ð¸Ð½ Ð³Ð°Ð·Ð°Ñ€ Ð½Ð¸ÑÐ»ÑÐ³",
          ],
          brochure_pdf_url: "https://example.com/combo-tour.pdf",
        },
      }),
    ],
  );

  assert.equal(result?.trip?.id, "combo-tour");
  assert.match(result?.reply || "", /Ð‘ÑÐ¹Ð´Ð°Ð¹Ñ…Ñ ÑˆÐ°Ñ€ Ñ‚ÑÐ½Ð³Ð¸ÑÐ¸Ð¹Ð½ ÑÑ€ÑÐ³ \+ Ð‘ÑÑÐ¶Ð¸Ð½ Ð³Ð°Ð·Ð°Ñ€ Ð½Ð¸ÑÐ»ÑÐ³ Ñ…Ð¾ÑÐ¾Ð»ÑÐ¾Ð½ Ð°ÑÐ»Ð°Ð»/);
  assert.doesNotMatch(result?.reply || "", /https:\/\/example\.com\/combo-tour\.pdf/);
});

test("land-only existence query prefers the ground Beidaihe + Beijing tour", () => {
  const reply = buildStructuredTripReply(
    "Нислэггүй Бэйдайхэ Бээжин аялал байгаа юу?",
    [
      trip({
        id: "ground-tour-exists",
        route_name: "Шар тэнгис буюу Бэйдайхэ-Бээжингийн газрын аялал",
        category: "газрын аялал",
        extra: {
          aliases: ["Бэйдайхэ Бээжин газрын аялал", "Бэйдэхэ Бээжин газрын"],
        },
      }),
      trip({
        id: "combo-tour-exists",
        route_name: "Бэйдайхэ шар тэнгисийн эрэг + Бээжин газар нислэг хосолсон аялал",
        category: "газар + нислэг хосолсон",
        notes: "Энэ аялалд Эрээн Улаанхад чиглэлийн нислэг багтсан.",
        extra: {
          aliases: ["Бэйдайхэ Бээжин газар нислэг", "Бээжин Бэйдайхэ газар нислэг хосолсон"],
          important_notes: ["Энэ нь газар + нислэг хосолсон аялал."],
        },
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /Шар тэнгис буюу Бэйдайхэ-Бээжингийн газрын аялал/);
  assert.doesNotMatch(reply || "", /газар нислэг хосолсон/);
});

test("latin land-only query still prefers the ground Beidaihe + Beijing tour", () => {
  const reply = buildStructuredTripReply(
    "nisleggvi beidaihe beejin aylal bgaa yu?",
    [
      trip({
        id: "ground-tour-latin",
        route_name: "Шар тэнгис буюу Бэйдайхэ-Бээжингийн газрын аялал",
        category: "газрын аялал",
        extra: {
          aliases: ["Beidaihe Beijing land tour", "beidaihe beejin"],
        },
      }),
      trip({
        id: "combo-tour-latin",
        route_name: "Бэйдайхэ шар тэнгисийн эрэг + Бээжин газар нислэг хосолсон аялал",
        category: "газар + нислэг хосолсон",
        extra: {
          aliases: ["beidaihe beejin flight combo", "beidaihe beijing flight"],
        },
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /Шар тэнгис буюу Бэйдайхэ-Бээжингийн газрын аялал/);
  assert.doesNotMatch(reply || "", /газар нислэг хосолсон/);
});

test("route plus date price query uses AND logic and stays on the Datun trip", () => {
  const reply = buildStructuredTripReply(
    "Датун аялал 7 сарын 18-нд хэд вэ?",
    [
      trip({
        id: "datun",
        route_name: "УБ-Датун шууд нислэгтэй аялал-наадмын амралтаар явна",
        adult_price: null,
        child_price: null,
        departure_dates: ["2026 он 7 сар 18", "2026 он 7 сар 21"],
        extra: {
          aliases: ["Датун наадмын аялал", "УБ Датун нислэгтэй наадам"],
          price_groups: [
            {
              dates: ["2026 он 7 сар 18", "2026 он 7 сар 21"],
              adult_price: 2660000,
              child_price: 2260000,
              infant_price: 32200,
            },
          ],
        },
      }),
      trip({
        id: "other-718",
        route_name: "Шанхай аялал",
        adult_price: 3990000,
        child_price: 3590000,
        departure_dates: ["2026 он 7 сар 18"],
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /УБ-Датун/);
  assert.match(reply || "", /2,660,000₮/);
  assert.match(reply || "", /2,260,000₮/);
  assert.match(reply || "", /32,200₮/);
  assert.doesNotMatch(reply || "", /Шанхай аялал/);
});

test("discount question falls back to notes and matching date group text", () => {
  const reply = buildDiscountReply(
    "Далянь аялал 7 сарын 3-нд хямдралтай юу?",
    [
      trip({
        id: "dalian",
        route_name: "Далянь хотын шууд нислэгтэй аялал",
        adult_price: 2890000,
        child_price: 2390000,
        notes: "7 сарын 3-нд супер бонустай. 2 том хүн + 1 хүүхэд үнэгүй эсвэл 5 том хүн + 1 том хүн үнэгүй.",
        departure_dates: ["7 сарын 3", "7 сарын 10"],
        extra: {
          aliases: ["Далянь аялал", "Далянь"],
          price_groups: [
            {
              dates: ["7 сарын 3"],
              adult_price: 2890000,
              child_price: 2390000,
              note: "7 сарын 3-нд супер бонустай. 2 том хүн + 1 хүүхэд үнэгүй эсвэл 5 том хүн + 1 том хүн үнэгүй.",
            },
          ],
          discounts: [],
        },
      }),
      trip({
        id: "other-july-3",
        route_name: "Хайлаар Манжуурын аялал",
        adult_price: 1090000,
        child_price: 890000,
        departure_dates: ["7 сарын 3"],
      }),
    ],
  );

  assert.match(reply || "", /Далянь хотын шууд нислэгтэй аялал/);
  assert.match(reply || "", /7 сарын 3/);
  assert.match(reply || "", /супер бонус|бонустай/i);
  assert.match(reply || "", /2,890,000₮/);
  assert.match(reply || "", /2,390,000₮/);
  assert.doesNotMatch(reply || "", /Хайлаар Манжуур/);
});

test("ticketed Tokyo price query only shows the ticket-included group", () => {
  const reply = buildStructuredTripReply(
    "Токио Фүжи тийзтэй үнэ хэд вэ?",
    [
      trip({
        id: "tokyo-fuji",
        route_name: "Токио, Фүжи аялал",
        adult_price: 3490000,
        child_price: 3250000,
        extra: {
          aliases: ["Токио Фүжи"],
          price_groups: [
            {
              label: "Онгоцны тийзгүй үнэ",
              note: "Онгоцны тийзгүй үнэ.",
              dates: ["Баасан гариг болгон"],
              adult_price: 3490000,
              child_price: 3250000,
              infant_price: 0,
              child_age: "2-12 нас",
              infant_age: "0-2 нас",
            },
            {
              label: "Онгоцны тийзтэй үнэ",
              note: "Онгоцны тийзтэй үнэ.",
              dates: ["6 сарын 19", "7 сарын 10"],
              adult_price: 5600000,
              child_price: 5050000,
              infant_price: 0,
              child_age: "2-12 нас",
              infant_age: "0-2 нас",
            },
          ],
          important_notes: ["Онгоцны тийзтэй болон тийзгүй үнэ тусдаа тул хэрэглэгчийн асуултаас хамаарч ялгаж хариулна."],
        },
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /Онгоцны тийзтэй үнэ/);
  assert.match(reply || "", /5,600,000₮/);
  assert.doesNotMatch(reply || "", /3,490,000₮/);
  assert.doesNotMatch(reply || "", /Онгоцны тийзгүй үнэ/);
});

test("ticketless Tokyo price query only shows the ticketless group", () => {
  const reply = buildStructuredTripReply(
    "Токио Фүжи тийзгүй үнэ хэд вэ?",
    [
      trip({
        id: "tokyo-fuji-ticketless",
        route_name: "Токио, Фүжи аялал",
        adult_price: 3490000,
        child_price: 3250000,
        extra: {
          aliases: ["Токио Фүжи"],
          price_groups: [
            {
              label: "Онгоцны тийзгүй үнэ",
              note: "Онгоцны тийзгүй үнэ.",
              dates: ["Баасан гариг болгон"],
              adult_price: 3490000,
              child_price: 3250000,
              infant_price: 0,
              child_age: "2-12 нас",
              infant_age: "0-2 нас",
            },
            {
              label: "Онгоцны тийзтэй үнэ",
              note: "Онгоцны тийзтэй үнэ.",
              dates: ["6 сарын 19", "7 сарын 10"],
              adult_price: 5600000,
              child_price: 5050000,
              infant_price: 0,
              child_age: "2-12 нас",
              infant_age: "0-2 нас",
            },
          ],
        },
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /Онгоцны тийзгүй үнэ/);
  assert.match(reply || "", /3,490,000₮/);
  assert.doesNotMatch(reply || "", /5,600,000₮/);
  assert.doesNotMatch(reply || "", /Онгоцны тийзтэй үнэ/);
});

test("child age range query is not misread as a date and returns the matching child tier", () => {
  const reply = buildStructuredTripReply(
    "Хайнан Саньяа хүүхэд 2-6 нас хэд вэ?",
    [
      trip({
        id: "sanya",
        route_name: "Хайнан - Саньяа шууд нислэгтэй аялал",
        adult_price: 2990000,
        child_price: 2790000,
        extra: {
          aliases: ["Хайнан Саньяа", "Саньяа"],
          price_groups: [
            {
              label: "Үндсэн үнэ",
              note: "Пүрэв гариг болгон. Хүүхэд 6–12 нас 2,790,000₮; хүүхэд 2–6 нас 2,190,000₮; нярай 0–2 нас 490,000₮.",
              dates: ["7 сарын 2", "7 сарын 9"],
              adult_price: 2990000,
              child_price: 2790000,
              infant_price: 490000,
              child_age: "6-12 нас",
              infant_age: "0-2 нас",
            },
          ],
          child_rules: [
            { label: "Хүүхэд", age_range: "6-12 нас", price: 2790000, currency: "MNT" },
            { label: "Хүүхэд", age_range: "2-6 нас", price: 2190000, currency: "MNT" },
            { label: "Нярай", age_range: "0-2 нас", price: 490000, currency: "MNT" },
          ],
          important_notes: [
            "Үнэ асуухад хүүхдийн бүх ангиллыг заавал хэлнэ: 6–12 нас 2,790,000₮; 2–6 нас 2,190,000₮; 0–2 нас 490,000₮.",
          ],
        },
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /2,190,000₮/);
  assert.match(reply || "", /2-6 нас|2–6 нас/);
  assert.doesNotMatch(reply || "", /2027|2 сарын 6|02-06/);
});

test("included-in-price question answers with ticket clarification instead of only the price", () => {
  const reply = buildStructuredTripReply(
    "Бээжин Юниверсал наадмын аяллын үнэд нислэгийн тийз багтсан уу?",
    [
      trip({
        id: "universal",
        route_name: "Бээжин - Юниверсал шууд нислэгтэй наадмын амралтаар гарах аялал",
        adult_price: 1790000,
        child_price: 1590000,
        extra: {
          aliases: ["Бээжин Юниверсал"],
          price_groups: [
            {
              label: "Наадмын тусгай",
              note: "Үнэ дээр нислэгийн тийз нэмэгдэнэ.",
              dates: ["7 сарын 9-14"],
              adult_price: 1790000,
              child_price: 1590000,
            },
          ],
          included_items: ["MIAT УБ-Бээжин-УБ нислэгийн тийз (асууж баталгаажуулах)"],
          important_notes: ["Зарим материалд үнэ '+ тийз' гэж бичигдсэн байж болох тул нислэгийн тийзийн нөхцлийг аяллын зөвлөхөөр баталгаажуулна."],
        },
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /нислэгийн тийз/i);
  assert.match(reply || "", /баталгаажуул|нэмэгдэнэ/i);
});

test("program request can still use exported JSON top-level aliases and brochure fields", () => {
  const groundTrip = {
    ...trip({
      id: "ground-export",
      route_name: "Шар тэнгис буюу Бэйдайхэ-Бээжингийн газрын аялал",
      category: "газрын аялал",
      extra: {},
    }),
    aliases: ["Бэйдэхэ Бээжин газрын"],
    brochure_pdf_url: "https://example.com/export-ground.pdf",
  } as TravelTrip & { aliases: string[]; brochure_pdf_url: string };

  const comboTrip = {
    ...trip({
      id: "combo-export",
      route_name: "Бэйдайхэ шар тэнгисийн эрэг + Бээжин газар нислэг хосолсон аялал",
      category: "газар + нислэг хосолсон",
      extra: {},
    }),
    aliases: ["Бээжин Бэйдэхэ газар нислэг хосолсон"],
  } as TravelTrip & { aliases: string[] };

  const result = buildTripProgramReply(
    "Бээжин + Бэйдэхэ газрын аяллын хөтөлбөр үзэх",
    [groundTrip, comboTrip],
  );

  assert.equal(result?.trip?.id, "ground-export");
  // Top-level aliases still work, but brochure links are no longer surfaced.
  assert.equal(result?.brochure, null);
  assert.doesNotMatch(result?.reply || "", /https:\/\/example\.com\/export-ground\.pdf/);
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
    "????????????????????????????????????? ????????????????????????? program",
    [
      trip({
        id: "program-none",
        route_name: "????????????????????????????????????? ?????????????????????????",
        extra: {},
      }),
    ],
  );

  assert.equal(result?.brochure, null);
  assert.deepEqual(result?.mediaUrls, []);
  assert.match(result?.reply || "", /зураг/);
  assert.doesNotMatch(result?.reply || "", /database/i);
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
