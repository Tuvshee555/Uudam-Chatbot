import assert from "node:assert/strict";
import test from "node:test";
import { appendLeadCaptureCta, buildClarificationButtons, buildCompareReply, buildDiscountReply, buildPriceObjectionReply, buildProgramOrStructuredReply, buildSeatsReply, buildSmartButtons, buildStructuredTripReply, buildTripProgramReply, LEAD_CAPTURE_CTA, resolveTripFromUserMessage } from "../src/lib/travelFastPaths";
import { findTripMatches } from "../src/lib/travelFastPathsSearch";
import type { TravelTrip } from "../src/lib/travelOps";

const NOW = new Date("2026-06-24T04:00:00.000Z");

function trip(fields: Partial<TravelTrip>): TravelTrip {
  return {
    id: "trip-1",
    category: "Outbound",
    operator_name: "Uudam Travel",
    route_name: "Зэт хаалга - шууд нислэгтэй",
    duration_text: "5 өдөр / 4 шөнө",
    adult_price: 1234567,
    child_price: 1200000,
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
  const out = appendLeadCaptureCta("✈️ Бээжин аялал\n💰 Том хүн: 1,210,000₮", false);
  assert.match(out, /1,210,000₮/);
  assert.ok(out.endsWith(LEAD_CAPTURE_CTA));
});

test("appendLeadCaptureCta skips when phone already collected", () => {
  const reply = "✈️ Бээжин аялал\n💰 Том хүн: 1,210,000₮";
  assert.equal(appendLeadCaptureCta(reply, true), reply);
});

test("smart buttons offer useful next taps for a matched trip with photos", () => {
  const buttons = buildSmartButtons(
    "✈️ Бэйдайхэ шар тэнгисийн эрэг + Бээжин газар нислэг хосолсон аялал\n💰 Том хүн: 1,270,000₮",
    [
      trip({
        id: "beidaihe-combo",
        route_name: "Бэйдайхэ шар тэнгисийн эрэг + Бээжин газар нислэг хосолсон аялал",
        photo_urls: ["https://example.com/beidaihe-1.jpg"],
      }),
    ],
  );

  assert.deepEqual(buttons, ["Хөтөлбөр үзэх", "Зураг үзэх", "Захиалах"]);
});

test("clarification buttons are numbered and messenger-sized", () => {
  const buttons = buildClarificationButtons([
    trip({
      id: "beijing-ground",
      route_name: "БЭЭЖИН - ЖИНИН – ЖАНЖАКОУ - ЭРЭЭН – 4 ХОТЫН АЯЛАЛ",
    }),
    trip({
      id: "beidaihe-combo",
      route_name: "Бэйдайхэ шар тэнгисийн эрэг + Бээжин газар нислэг хосолсон аялал",
    }),
  ]);

  assert.equal(buttons.length, 2);
  assert.ok(buttons[0].startsWith("1. "));
  assert.ok(buttons[1].startsWith("2. "));
  assert.ok(buttons.every((button) => button.length <= 25));
});

test("appendLeadCaptureCta skips clarifying (ambiguous) replies", () => {
  const ambiguous = buildStructuredTripReply("Tokyo une hed ve?", [
    trip({ id: "tokyo-fuji", route_name: "Tokyo Fuji аялал", adult_price: 1490000 }),
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
    trip({ id: "tokyo-fuji", route_name: "Tokyo Fuji аялал", adult_price: 1490000 }),
    trip({ id: "tokyo-universal", route_name: "Tokyo Universal аялал", adult_price: 1790000 }),
  ]);

  assert.match(reply || "", /Аль аяллыг нь сонирхож/i);
  assert.match(reply || "", /Tokyo Fuji/);
  assert.match(reply || "", /Tokyo Universal/);
  assert.match(reply || "", /1,490,000/);
  assert.match(reply || "", /1,790,000/);
});

test("trip info reply never leaks an internal duration QA sentinel", () => {
  const reply = buildSeatsReply("Тэнгэрийн хаалга суудал бий юу?", [
    trip({
      id: "tengeriin-khaalga-unverified-duration",
      duration_text: "Нийт хугацаа тодорхойгүй, баталгаажуулах шаардлагатай",
    }),
  ]);

  assert.ok(reply);
  assert.doesNotMatch(reply as string, /баталгаажуулах шаардлагатай/);
  assert.doesNotMatch(reply as string, /тодорхойгүй/);
});

test("broad Beijing price question clarifies instead of picking one variant", () => {
  const resolution = resolveTripFromUserMessage("Бээжин аялал хэд вэ?", [
    trip({
      id: "beijing-four-city",
      route_name: "БЭЭЖИН - ЖИНИН – ЖАНЖАКОУ - ЭРЭЭН – 4 ХОТЫН АЯЛАЛ",
      category: "Газрын аялал",
    }),
    trip({
      id: "beidaihe-beijing-combo",
      route_name: "Бэйдайхэ шар тэнгисийн эрэг+Бээжин газар нислэг хосолсон аялал",
      category: "Газар нислэг хосолсон",
    }),
    trip({
      id: "beijing-naadam-ground",
      route_name: "БЭЭЖИН - ЖИНИН – ЖАНЖАКОУ - ЭРЭЭН-наадмын амралтаар явах газрын аялал",
      category: "Газрын аялал",
    }),
  ]);

  assert.equal(resolution.status, "ambiguous");
});

test("human correction not Beijing, the sea one picks the sea/beach variant", () => {
  const resolution = resolveTripFromUserMessage("Бээжин биш, далайтай нь", [
    trip({
      id: "beijing-four-city",
      route_name: "БЭЭЖИН - ЖИНИН – ЖАНЖАКОУ - ЭРЭЭН – 4 ХОТЫН АЯЛАЛ",
      category: "Газрын аялал",
    }),
    trip({
      id: "beidaihe-beijing-combo",
      route_name: "Бэйдайхэ шар тэнгисийн эрэг+Бээжин газар нислэг хосолсон аялал",
      category: "Газар нислэг хосолсон",
    }),
    trip({
      id: "beijing-naadam-ground",
      route_name: "БЭЭЖИН - ЖИНИН – ЖАНЖАКОУ - ЭРЭЭН-наадмын амралтаар явах газрын аялал",
      category: "Газрын аялал",
    }),
  ]);

  assert.equal(resolution.status, "verified");
  assert.equal(
    resolution.status === "verified" ? resolution.trip.id : null,
    "beidaihe-beijing-combo",
  );
});

test("direct-flight Beijing price does not answer with combo tour price", () => {
  const reply = buildStructuredTripReply("Бээжин шууд нислэгтэй нь хэд вэ?", [
    trip({
      id: "beijing-four-city",
      route_name: "БЭЭЖИН - ЖИНИН – ЖАНЖАКОУ - ЭРЭЭН – 4 ХОТЫН АЯЛАЛ",
      category: "Газрын аялал",
      adult_price: 1790000,
      child_price: 1490000,
    }),
    trip({
      id: "beidaihe-beijing-combo",
      route_name: "Бэйдайхэ шар тэнгисийн эрэг+Бээжин газар нислэг хосолсон аялал",
      category: "Газар нислэг хосолсон",
      adult_price: 1270000,
      child_price: 1200000,
    }),
  ]);

  assert.match(reply || "", /яг шууд нислэгтэй аялал одоогоор тодорхой олдсонгүй/);
  assert.match(reply || "", /газар \+ нислэг хосолсон/);
  assert.doesNotMatch(reply || "", /1,270,000|1,200,000/);
});

test("sold-out direct-flight match is reported as sold out instead of unavailable", () => {
  const reply = buildStructuredTripReply("Жинин Универсал шууд нислэгтэй хэд вэ, суудал байгаа юу?", [
    trip({
      id: "universal-sold-out",
      route_name: "Бээжин - Юниверсал шууд нислэгтэй наадмын амралтаар гарах аялал",
      category: "Шууд нислэгтэй аялал",
      status: "sold_out",
      extra: {
        aliases: ["Бээжин Юниверсал", "Универсал"],
      },
    }),
    trip({
      id: "jinin-ground",
      route_name: "Жинин - Утай - Гүмбэн",
      category: "Газрын аялал",
    }),
  ]);

  assert.match(reply || "", /Юниверсал/);
  assert.match(reply || "", /суудал дууссан/);
  assert.doesNotMatch(reply || "", /яг шууд нислэгтэй аялал одоогоор тодорхой олдсонгүй/);
  assert.doesNotMatch(reply || "", /Жинин - Утай - Гүмбэн/);
});

test("sold-out reply pitches active same-destination trips instead of dead-ending", () => {
  const reply = buildStructuredTripReply("Универсал аялал суудал байгаа юу?", [
    trip({
      id: "universal-sold-out",
      route_name: "Бээжин - Юниверсал шууд нислэгтэй наадмын амралтаар гарах аялал",
      category: "Шууд нислэгтэй аялал",
      status: "sold_out",
      extra: { aliases: ["Бээжин Юниверсал", "Универсал"] },
    }),
    trip({
      id: "beijing-four-city",
      route_name: "БЭЭЖИН - ЖИНИН – ЖАНЖАКОУ - ЭРЭЭН – 4 ХОТЫН АЯЛАЛ",
      category: "Газрын аялал",
      adult_price: 1170000,
      duration_text: "8 өдөр 7 шөнө",
    }),
    trip({
      id: "hainan-unrelated",
      route_name: "Хайнан - Саньяа шууд нислэгтэй аялал",
      category: "Шууд нислэгтэй аялал",
      adult_price: 1430000,
    }),
  ]);

  assert.match(reply || "", /суудал дууссан/);
  // The sellable same-destination trip is pitched in the same message…
  assert.match(reply || "", /нээлттэй/);
  assert.match(reply || "", /4 ХОТЫН АЯЛАЛ/);
  assert.match(reply || "", /1,170,000/);
  // …but unrelated destinations are not dragged in.
  assert.doesNotMatch(reply || "", /Хайнан/);
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

  assert.match(result?.reply || "", /Аль аяллыг нь сонирхож/i);
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
        child_price: 1470000,
        extra: {
          aliases: ["Жанжиажэ", "Zhangjiajie", "Шанхай Жанжиажэ"],
          departure_date_groups: [
            {
              dates: ["6 сарын 27"],
              adult_price: 3590000,
              child_price: 1470000,
            },
            {
              dates: ["7 сарын 18"],
              adult_price: 1500000,
              child_price: 1470000,
            },
          ],
        },
      }),
      trip({
        id: "beidaihe",
        route_name: "Бэйдайхэ, Далянь хотын аялал",
        duration_text: "8 өдөр / 7 шөнө",
        adult_price: 2690000,
        child_price: 1320000,
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /Шанхай \+ Тэнгэрийн хаалга/);
  assert.match(reply || "", /адил биш/);
  assert.doesNotMatch(reply || "", /Бэйдайхэ/);
});

test("matches latin shanghai query to the Shanghai route", () => {
  const resolution = resolveTripFromUserMessage(
    "shanghai aylal medeelel",
    [
      trip({
        id: "shanghai-zhangjiajie",
        route_name: "Шанхай + Тэнгэрийн хаалга шууд нислэгтэй аялал",
        extra: {
          aliases: ["Шанхай Жанжиажэ", "Шанхай Тэнгэрийн хаалга", "Shanghai"],
        },
      }),
      trip({
        id: "beijing-ground",
        route_name: "ШАР ТЭНГИС БУЮУ БЭЙДАЙХЭ-БЭЭЖИНГИЙН ГАЗРЫН АЯЛАЛ",
      }),
    ],
  );

  assert.equal(resolution.status, "verified");
  assert.equal(
    resolution.status === "verified" ? resolution.trip.id : null,
    "shanghai-zhangjiajie",
  );
});

test("prefers the direct-flight Tengeriin Khaalga trip over longer variants", () => {
  const reply = buildStructuredTripReply(
    "Тэнгэрийн хаалга шууд нислэгтэй аялал хэд вэ?",
    [
      trip({
        id: "base",
        route_name: "Тэнгэрийн хаалга - шууд нислэгтэй",
        adult_price: 1480000,
        child_price: 1430000,
      }),
      trip({
        id: "with-chongqing",
        route_name: "Тэнгэрийн хаалга-Чунчин",
        adult_price: 3590000,
        child_price: 1470000,
      }),
      trip({
        id: "with-shanghai",
        route_name: "Шанхай + Тэнгэрийн хаалга шууд нислэгтэй аялал",
        adult_price: 3590000,
        child_price: 1470000,
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /^✈️ Тэнгэрийн хаалга - шууд нислэгтэй/m);
  assert.match(reply || "", /1,480,000₮/);
  assert.doesNotMatch(reply || "", /Шанхай \+/);
  assert.doesNotMatch(reply || "", /Чунчин/);
});

test("prefers inferred combo Tengeriin Khaalga trip when user asks газар нислэгтэй", () => {
  const reply = buildStructuredTripReply(
    "Тэнгэрийн хаалга газар нислэгтэй хэд вэ?",
    [
      trip({
        id: "direct",
        route_name: "Тэнгэрийн хаалга - шууд нислэгтэй",
        category: "шууд нислэгтэй аялал",
        adult_price: 1430000,
        child_price: 1410000,
        source_description: "8 өдөр 7 шөнө. УБ - Жанжиажэ - УБ шууд нислэгтэй.",
      }),
      trip({
        id: "combo",
        route_name: "Тэнгэрийн хаалга-Чунчин",
        category: "",
        adult_price: 1480000,
        child_price: 1430000,
        source_description: "8 өдөр 7 шөнө. Тэнгэрийн хаалга, Чунчин хосолсон аялал.",
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /^✈️ Тэнгэрийн хаалга-Чунчин/m);
  assert.match(reply || "", /1,480,000₮/);
  assert.doesNotMatch(reply || "", /^✈️ Тэнгэрийн хаалга - шууд нислэгтэй/m);
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
        child_price: 1170000,
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
        adult_price: 1430000,
        child_price: 1410000,
        departure_dates: ["7 сарын 5", "7 сарын 12"],
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /Хямдралтай үнийн мэдээлэл/);
  assert.match(reply || "", /1,430,000₮/);
  assert.match(reply || "", /1,410,000₮/);
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
        child_price: 1470000,
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
    "7/9 Ð½Ð¸Ð¹ 1270000 Ñ‹Ð½ Ð°ÑÐ»Ð°Ð»Ñ‹Ð³ Ò¯Ð·Ð¼ÑÑ€ Ð±Ð°Ð¹Ð½Ð°",
    [
      trip({
        id: "beidaihe-flight",
        route_name: "Ð‘ÑÐ¹Ð´Ð°Ð¹Ñ…Ñ+Ð‘ÑÑÐ¶Ð¸Ð½ Ð³Ð°Ð·Ð°Ñ€ Ð½Ð¸ÑÐ»ÑÐ³ Ñ…Ð¾ÑÐ¾Ð»ÑÐ¾Ð½ Ð°ÑÐ»Ð°Ð»",
        duration_text: "9 Ó©Ð´Ó©Ñ€ / 8 ÑˆÓ©Ð½Ó©",
        adult_price: 2030000,
        child_price: 1170000,
        source_description: "Ð“Ð°Ð·Ð°Ñ€ Ð½Ð¸ÑÐ»ÑÐ³ Ñ…Ð¾ÑÐ¾Ð»ÑÐ¾Ð½ Ð¼Ð°Ñ€ÑˆÑ€ÑƒÑ‚",
        departure_dates: ["7 ÑÐ°Ñ€Ñ‹Ð½ 9", "7 ÑÐ°Ñ€Ñ‹Ð½ 16"],
        extra: {
          price_groups: [
            {
              dates: ["7 ÑÐ°Ñ€Ñ‹Ð½ 9"],
              adult_price: 1270000,
              child_price: 1200000,
              infant_price: 1050000,
            },
            {
              dates: ["7 ÑÐ°Ñ€Ñ‹Ð½ 16"],
              adult_price: 2030000,
              child_price: 1170000,
              infant_price: 1050000,
            },
          ],
        },
      }),
      trip({
        id: "wrong-price",
        route_name: "Ð‘ÑÑÐ¶Ð¸Ð½ Ñ…Ð¾Ñ‚Ñ‹Ð½ Ð°ÑÐ»Ð°Ð»",
        duration_text: "5 Ó©Ð´Ó©Ñ€ / 4 ÑˆÓ©Ð½Ó©",
        adult_price: 1230000,
        departure_dates: ["7 ÑÐ°Ñ€Ñ‹Ð½ 9"],
        extra: {
          price_groups: [
            {
              dates: ["7 ÑÐ°Ñ€Ñ‹Ð½ 9"],
              adult_price: 1230000,
              child_price: 1180000,
            },
          ],
        },
      }),
      trip({
        id: "same-date-other-route",
        route_name: "Ð–Ð¸Ð½Ð¸Ð½ Ð¼Ð¸Ð½Ð¸ Ð°Ð²Ð°Ñ‚Ð°Ñ€",
        duration_text: "4 Ó©Ð´Ó©Ñ€ / 3 ÑˆÓ©Ð½Ó©",
        adult_price: 1110000,
        departure_dates: ["7 ÑÐ°Ñ€Ñ‹Ð½ 9"],
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /1270000|1,270,000/);
  assert.match(reply || "", /Ð‘ÑÐ¹Ð´Ð°Ð¹Ñ…Ñ\+Ð‘ÑÑÐ¶Ð¸Ð½/);
  assert.doesNotMatch(reply || "", /Ð–Ð¸Ð½Ð¸Ð½/);
  assert.doesNotMatch(reply || "", /Ð‘ÑÑÐ¶Ð¸Ð½ Ñ…Ð¾Ñ‚Ñ‹Ð½ Ð°ÑÐ»Ð°Ð»/);
});

test("combined date and price query falls back to close matches on the same date only", () => {
  const reply = buildStructuredTripReply(
    "7/9 1310000 Ð°ÑÐ»Ð°Ð»",
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
              adult_price: 1270000,
              child_price: 1200000,
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
              child_price: 1210000,
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
              adult_price: 1310000,
            },
          ],
        },
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /1310000|1,310,000/);
  assert.match(reply || "", /Ð‘ÑÐ¹Ð´Ð°Ð¹Ñ…Ñ\+Ð‘ÑÑÐ¶Ð¸Ð½/);
  assert.match(reply || "", /Ð‘ÑÑÐ¶Ð¸Ð½ ÑˆÑƒÑƒÐ´ Ð½Ð¸ÑÐ»ÑÐ³Ñ‚ÑÐ¹/);
  assert.doesNotMatch(reply || "", /Ð¥Ð°Ð¹Ð½Ð°Ð½/);
});

test("month-specific child price only returns that month and passenger type", () => {
  const reply = buildStructuredTripReply(
    "Бэйдайхэ 8 сарын хүүхдийн үнэ өөр үү?",
    [
      trip({
        id: "beidaihe-month-child",
        route_name: "Бэйдайхэ + Бээжин газар нислэг хосолсон аялал",
        departure_dates: ["7 сарын 9", "7 сарын 18", "8 сарын 1", "8 сарын 8"],
        extra: {
          aliases: ["Бэйдайхэ", "Бэйдэхэ"],
          price_groups: [
            {
              dates: ["7 сарын 9", "7 сарын 18"],
              adult_price: 1270000,
              child_price: 1650000,
              infant_price: 1050000,
              child_age: "2–10 нас",
            },
            {
              dates: ["8 сарын 1", "8 сарын 8"],
              adult_price: 1310000,
              child_price: 1200000,
              infant_price: 1050000,
              child_age: "2–10 нас",
            },
          ],
        },
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /8 сарын хүүхдийн үнэ/);
  assert.match(reply || "", /1,200,000₮/);
  assert.match(reply || "", /8 сарын 1, 8-ны гаралт/);
  assert.doesNotMatch(reply || "", /7\/9|7\/18|1,650,000₮/);
  assert.doesNotMatch(reply || "", /Том хүн|Нярай/);
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
              child_price: 1170000,
              infant_price: 1050000,
              child_age: "2–10 нас",
              infant_age: "0–23 сар",
            },
            {
              dates: ["7 сарын 9", "7 сарын 18", "7 сарын 27", "8 сарын 1", "8 сарын 8", "8 сарын 15", "8 сарын 22"],
              adult_price: 1270000,
              child_price: 1200000,
              infant_price: 1050000,
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

  assert.deepEqual(result?.brochure, {
    type: "url",
    value: "https://example.com/program.pdf",
  });
  assert.deepEqual(result?.mediaUrls, []);
  assert.doesNotMatch(result?.reply || "", /https:\/\/example\.com\/program\.pdf/);
});

test("poster-linked photo request sends the PDF brochure instead of photos", () => {
  const result = buildTripProgramReply(
    "Жэжү poster зураг явуул",
    [
      trip({
        id: "jeju",
        route_name: "Жэжү арлын аялал",
        photo_urls: ["https://example.com/legacy-photo.jpg"],
        extra: {
          poster_trip_id: "poster-jeju",
          brochure_pdf_url: "https://example.com/jeju.pdf",
        },
      }),
    ],
  );

  assert.deepEqual(result?.brochure, { type: "url", value: "https://example.com/jeju.pdf" });
  assert.deepEqual(result?.mediaUrls, []);
  assert.match(result?.reply || "", /PDF/);
});

test("poster-linked trip without PDF refuses legacy image fallback", () => {
  const result = buildTripProgramReply(
    "Жэжү poster зураг явуул",
    [
      trip({
        id: "jeju-missing-pdf",
        route_name: "Жэжү арлын аялал",
        photo_urls: ["https://example.com/legacy-photo.jpg"],
        extra: { poster_trip_id: "poster-jeju" },
      }),
    ],
  );

  assert.equal(result?.reply, "NOTRIPMEDIA");
  assert.equal(result?.brochure, null);
  assert.deepEqual(result?.mediaUrls, []);
});

test("program photo request prefers the longer combined route over a shorter shared route", () => {
  const result = buildTripProgramReply(
    "Shanghai Tenger zurag",
    [
      trip({
        id: "tenger-direct",
        route_name: "Tenger direct flight",
        photo_urls: ["https://example.com/tenger-direct-1.jpg"],
      }),
      trip({
        id: "shanghai-tenger",
        route_name: "Shanghai Tenger direct flight",
        photo_urls: ["https://example.com/shanghai-tenger-1.jpg", "https://example.com/shanghai-tenger-2.jpg"],
      }),
    ],
  );

  assert.equal(result?.trip?.id, "shanghai-tenger");
  assert.deepEqual(result?.mediaUrls, [
    "https://example.com/shanghai-tenger-1.jpg",
    "https://example.com/shanghai-tenger-2.jpg",
  ]);
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
  assert.deepEqual(result?.brochure, { type: "url", value: "https://example.com/ground-tour.pdf" });
  assert.deepEqual(result?.mediaUrls, []);
  assert.match(result?.reply || "", /Шар тэнгис буюу Бэйдайхэ-Бээжингийн газрын аялал/);
  assert.match(result?.reply || "", /PDF хөтөлбөр/);
});

test("program request handles common Бэйдэхэ spelling without stored aliases", () => {
  const result = buildTripProgramReply(
    "Бээжин + Бэйдэхэ газрын аяллын хөтөлбөр үзэх",
    [
      trip({
        id: "four-city",
        route_name: "БЭЭЖИН - ЖИНИН – ЖАНЖАКОУ - ЭРЭЭН – 4 ХОТЫН АЯЛАЛ",
        category: "газрын аялал",
      }),
      trip({
        id: "ground-tour",
        route_name: "Шар тэнгис буюу Бэйдайхэ-Бээжингийн газрын аялал",
        category: "газрын аялал",
        extra: {
          brochure_pdf_url: "https://example.com/ground-tour.pdf",
        },
      }),
      trip({
        id: "combo-tour",
        route_name: "Бэйдайхэ шар тэнгисийн эрэг + Бээжин газар нислэг хосолсон аялал",
        category: "газар + нислэг хосолсон",
      }),
    ],
  );

  assert.equal(result?.trip?.id, "ground-tour");
  assert.deepEqual(result?.brochure, { type: "url", value: "https://example.com/ground-tour.pdf" });
  assert.doesNotMatch(result?.reply || "", /4 ХОТЫН АЯЛАЛ/);
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

test("program request asks for clarification on generic Beijing flight-tour wording", () => {
  const result = buildTripProgramReply(
    "Бээжин нислэгтэй аяллын хөтөлбөр үзэх",
    [
      trip({
        id: "beijing-direct",
        route_name: "Бээжин - Юниверсал шууд нислэгтэй аялал",
        extra: {
          aliases: ["Бээжин Юниверсал"],
          program_images: ["https://example.com/beijing-direct-program.jpg"],
        },
      }),
      trip({
        id: "beidaihe-combo",
        route_name: "Бэйдайхэ шар тэнгисийн эрэг + Бээжин газар нислэг хосолсон аялал",
        extra: {
          aliases: ["Бээжин Бэйдайхэ газар нислэг хосолсон", "Бэйдайхэ Бээжин"],
          program_images: ["https://example.com/beidaihe-combo-program.jpg"],
        },
      }),
    ],
  );

  assert.match(result?.reply || "", /Аль аяллыг нь сонирхож/i);
  assert.equal(result?.trip, null);
  assert.deepEqual(result?.mediaUrls, []);
  assert.doesNotMatch(result?.reply || "", /4 ХОТЫН АЯЛАЛ/);
  assert.doesNotMatch(result?.reply || "", /наадмын амралтаар явах газрын аялал/);
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
              adult_price: 1400000,
              child_price: 1310000,
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
  assert.match(reply || "", /1,400,000₮/);
  assert.match(reply || "", /1,310,000₮/);
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
        adult_price: 1420000,
        child_price: 1320000,
        notes: "7 сарын 3-нд супер бонустай. 2 том хүн + 1 хүүхэд үнэгүй эсвэл 5 том хүн + 1 том хүн үнэгүй.",
        departure_dates: ["7 сарын 3", "7 сарын 10"],
        extra: {
          aliases: ["Далянь аялал", "Далянь"],
          price_groups: [
            {
              dates: ["7 сарын 3"],
              adult_price: 1420000,
              child_price: 1320000,
              note: "7 сарын 3-нд супер бонустай. 2 том хүн + 1 хүүхэд үнэгүй эсвэл 5 том хүн + 1 том хүн үнэгүй.",
            },
          ],
          discounts: [],
        },
      }),
      trip({
        id: "other-july-3",
        route_name: "Хайлаар Манжуурын аялал",
        adult_price: 1110000,
        child_price: 1100000,
        departure_dates: ["7 сарын 3"],
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /Далянь хотын шууд нислэгтэй аялал/);
  assert.match(reply || "", /7 сарын 3/);
  assert.match(reply || "", /супер бонус|бонустай/i);
  assert.match(reply || "", /1,420,000₮/);
  assert.match(reply || "", /1,320,000₮/);
  assert.doesNotMatch(reply || "", /Хайлаар Манжуур/);
});

test("ticketed Tokyo price query only shows the ticket-included group", () => {
  const reply = buildStructuredTripReply(
    "Токио Фүжи тийзтэй үнэ хэд вэ?",
    [
      trip({
        id: "tokyo-fuji",
        route_name: "Токио, Фүжи аялал",
        adult_price: 1490000,
        child_price: 1460000,
        extra: {
          aliases: ["Токио Фүжи"],
          price_groups: [
            {
              label: "Онгоцны тийзгүй үнэ",
              note: "Онгоцны тийзгүй үнэ.",
              dates: ["Баасан гариг болгон"],
              adult_price: 1490000,
              child_price: 1460000,
              infant_price: 0,
              child_age: "2-12 нас",
              infant_age: "0-2 нас",
            },
            {
              label: "Онгоцны тийзтэй үнэ",
              note: "Онгоцны тийзтэй үнэ.",
              dates: ["6 сарын 19", "7 сарын 10"],
              adult_price: 5600000,
              child_price: 1550000,
              infant_price: 0,
              child_age: "2-12 нас",
              infant_age: "0-2 нас",
            },
          ],
          important_notes: ["Онгоцны тийзтэй болон тийзгүй үнэ тусдаа тул хэрэглэгчийн асуултаас хамаарч ялгаж хариулна."],
          extra_fees: [
            { label: "Визний хураамж", amount: 211000, currency: "MNT", applies_to: "аялагч" },
          ],
        },
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /Онгоцны тийзтэй үнэ/);
  assert.match(reply || "", /5,600,000₮/);
  assert.match(reply || "", /211,000₮/);
  assert.doesNotMatch(reply || "", /1,490,000₮/);
  assert.doesNotMatch(reply || "", /Онгоцны тийзгүй үнэ/);
});

test("ticketless Tokyo price query only shows the ticketless group", () => {
  const reply = buildStructuredTripReply(
    "Токио Фүжи тийзгүй үнэ хэд вэ?",
    [
      trip({
        id: "tokyo-fuji-ticketless",
        route_name: "Токио, Фүжи аялал",
        adult_price: 1490000,
        child_price: 1460000,
        extra: {
          aliases: ["Токио Фүжи"],
          price_groups: [
            {
              label: "Онгоцны тийзгүй үнэ",
              note: "Онгоцны тийзгүй үнэ.",
              dates: ["Баасан гариг болгон"],
              adult_price: 1490000,
              child_price: 1460000,
              infant_price: 0,
              child_age: "2-12 нас",
              infant_age: "0-2 нас",
            },
            {
              label: "Онгоцны тийзтэй үнэ",
              note: "Онгоцны тийзтэй үнэ.",
              dates: ["6 сарын 19", "7 сарын 10"],
              adult_price: 5600000,
              child_price: 1550000,
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
  assert.match(reply || "", /1,490,000₮/);
  assert.doesNotMatch(reply || "", /5,600,000₮/);
  assert.doesNotMatch(reply || "", /Онгоцны тийзтэй үнэ/);
});

test("ticketed price query does not fall back to ticketless price when ticketed group is missing", () => {
  const reply = buildStructuredTripReply(
    "Токио тийзтэй үнэ?",
    [
      trip({
        id: "tokyo-ticketed-missing",
        route_name: "Токио, Фүжи аялал",
        adult_price: 1490000,
        child_price: 1460000,
        extra: {
          aliases: ["Токио Фүжи", "Токио аялал"],
          price_groups: [
            {
              label: "Онгоцны тийзгүй үнэ",
              note: "Онгоцны тийзгүй үнэ.",
              dates: ["Баасан гариг болгон"],
              adult_price: 1490000,
              child_price: 1460000,
            },
          ],
        },
      }),
    ],
  );

  assert.equal(reply, "REFER");
});

test("ticket price comparison keeps the included and excluded labels", () => {
  const reply = buildStructuredTripReply(
    "Токио, Фүжи аялал\nтийзтэйгээ ялгаа?",
    [
      trip({
        id: "tokyo-ticket-comparison",
        route_name: "Токио, Фүжи аялал",
        departure_dates: ["Баасан гариг болгон", "7 сарын 10"],
        extra: {
          price_groups: [
            {
              label: "Онгоцны тийзгүй үнэ",
              dates: ["Баасан гариг болгон"],
              adult_price: 1490000,
              child_price: 1460000,
            },
            {
              label: "Онгоцны тийзтэй үнэ",
              dates: ["7 сарын 10"],
              adult_price: 5600000,
              child_price: 1550000,
            },
          ],
        },
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /Онгоцны тийзгүй үнэ/);
  assert.match(reply || "", /Онгоцны тийзтэй үнэ/);
  assert.match(reply || "", /1,490,000₮/);
  assert.match(reply || "", /5,600,000₮/);
  assert.doesNotMatch(reply || "", /📅 Гарах өдрүүд:\s*$/);
});

test("cruise price reply uses room price table when top-level prices are null", () => {
  const reply = buildStructuredTripReply(
    "Усан онгоцны аялал Чежү Пусан хэд вэ?",
    [
      trip({
        id: "cruise",
        route_name: "Усан онгоцны аялал - Эрээн - Бээжин -Тяньжин - Чежү Пусан",
        adult_price: null,
        child_price: null,
        extra: {
          aliases: ["Усан онгоцны аялал", "Чежү Пусан круз"],
          room_prices: [
            { room_type: "4 ортой цонхтой өрөө", price: 1210000, currency: "MNT" },
            { room_type: "2 ортой цонхтой өрөө", price: 1320000, currency: "MNT" },
          ],
          extra_fees: [
            { label: "Онгоцонд гарын мөнгө", amount: 710, currency: "CNY", applies_to: "1 хүн" },
          ],
        },
      }),
    ],
  );

  assert.match(reply || "", /Усан онгоцны аялал/);
  assert.match(reply || "", /4 ортой цонхтой өрөө: 1,210,000₮/);
  assert.match(reply || "", /710\s*CNY/);
});

test("child age range query is not misread as a date and returns the matching child tier", () => {
  const reply = buildStructuredTripReply(
    "Хайнан Саньяа хүүхэд 2-6 нас хэд вэ?",
    [
      trip({
        id: "sanya",
        route_name: "Хайнан - Саньяа шууд нислэгтэй аялал",
        adult_price: 1430000,
        child_price: 1410000,
        extra: {
          aliases: ["Хайнан Саньяа", "Саньяа"],
          price_groups: [
            {
              label: "Үндсэн үнэ",
              note: "Пүрэв гариг болгон. Хүүхэд 6–12 нас 1,410,000₮; хүүхэд 2–6 нас 1,280,000₮; нярай 0–2 нас 1,030,000₮.",
              dates: ["7 сарын 2", "7 сарын 9"],
              adult_price: 1430000,
              child_price: 1410000,
              infant_price: 1030000,
              child_age: "6-12 нас",
              infant_age: "0-2 нас",
            },
          ],
          child_rules: [
            { label: "Хүүхэд", age_range: "6-12 нас", price: 1410000, currency: "MNT" },
            { label: "Хүүхэд", age_range: "2-6 нас", price: 1280000, currency: "MNT" },
            { label: "Нярай", age_range: "0-2 нас", price: 1030000, currency: "MNT" },
          ],
          important_notes: [
            "Үнэ асуухад хүүхдийн бүх ангиллыг заавал хэлнэ: 6–12 нас 1,410,000₮; 2–6 нас 1,280,000₮; 0–2 нас 1,030,000₮.",
          ],
        },
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /1,280,000₮/);
  assert.match(reply || "", /2-6 нас|2–6 нас/);
  assert.doesNotMatch(reply || "", /2027|2 сарын 6|02-06/);
});

test("duration and date disambiguate Hailaar Manchurian variants", () => {
  const reply = buildStructuredTripReply(
    "Хайлаар Манжуур 5 өдөр 8 сарын 24-нд хэд вэ?",
    [
      trip({
        id: "hailaar-4",
        route_name: "Хайлаар Манжуурын аялал - 4 өдөр 3 шөнө",
        adult_price: 1100000,
        child_price: 1080000,
        departure_dates: ["8 сарын 21"],
        duration_text: "4 өдөр 3 шөнө",
        source_description: "Хайлаар Манжуур 4 өдөр 8 сарын 21",
        extra: {
          aliases: ["Хайлаар Манжуур 4 өдөр"],
          price_groups: [
            { dates: ["8 сарын 21"], adult_price: 1100000, child_price: 1080000 },
          ],
          extra_fees: [{ label: "Өрөөнд ганцаараа орох нэмэгдэл", amount: 200000, currency: "MNT" }],
        },
      }),
      trip({
        id: "hailaar-5",
        route_name: "Хайлаар Манжуурын аялал - 5 өдөр 4 шөнө",
        adult_price: 1100000,
        child_price: 1100000,
        departure_dates: ["8 сарын 24"],
        duration_text: "5 өдөр 4 шөнө",
        source_description: "Хайлаар Манжуур 5 өдөр 8 сарын 24",
        extra: {
          aliases: ["Хайлаар Манжуур 5 өдөр"],
          price_groups: [
            { dates: ["8 сарын 24"], adult_price: 1100000, child_price: 1100000 },
          ],
          extra_fees: [{ label: "Өрөөнд ганцаараа орох нэмэгдэл", amount: 250000, currency: "MNT" }],
        },
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /Хайлаар Манжуурын аялал - 5 өдөр 4 шөнө/);
  assert.match(reply || "", /8 сарын 24/);
  assert.match(reply || "", /1,100,000₮/);
  assert.match(reply || "", /250,000₮/);
  assert.doesNotMatch(reply || "", /4 өдөр 3 шөнө/);
});

test("single child age query returns the matching age tier instead of the first child price", () => {
  const reply = buildStructuredTripReply(
    "Хайнан Саньяа 2 настай хүүхэд хэдээр явах вэ?",
    [
      trip({
        id: "sanya",
        route_name: "Хайнан - Саньяа шууд нислэгтэй аялал",
        adult_price: 1430000,
        child_price: 1410000,
        extra: {
          aliases: ["Хайнан Саньяа", "Саньяа"],
          price_groups: [
            {
              label: "Үндсэн үнэ",
              note: "Пүрэв гариг болгон. Хүүхэд 6–12 нас 1,410,000₮; хүүхэд 2–6 нас 1,280,000₮; нярай 0–2 нас 1,030,000₮.",
              dates: ["7 сарын 2", "7 сарын 9"],
              adult_price: 1430000,
              child_price: 1410000,
              infant_price: 1030000,
              child_age: "6-12 нас",
              infant_age: "0-2 нас",
            },
          ],
          child_rules: [
            { label: "Хүүхэд", age_range: "6-12 нас", price: 1410000, currency: "MNT" },
            { label: "Хүүхэд", age_range: "2-6 нас", price: 1280000, currency: "MNT" },
            { label: "Нярай", age_range: "0-2 нас", price: 1030000, currency: "MNT" },
          ],
        },
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /1,280,000₮/);
  assert.match(reply || "", /2-6 нас|2–6 нас/);
  assert.doesNotMatch(reply || "", /1,410,000₮/);
  assert.doesNotMatch(reply || "", /1,030,000₮/);
});

test("infant price follow-up stays on the contextual trip instead of matching expensive-word route", () => {
  const reply = buildStructuredTripReply(
    [
      "Бэйдайхэ шар тэнгисийн эрэг + Бээжин газар нислэг хосолсон аялал",
      "нярай хүүхэд үнэтэй юу?",
    ].join("\n"),
    [
      trip({
        id: "beidaihe-combo",
        route_name: "Бэйдайхэ шар тэнгисийн эрэг + Бээжин газар нислэг хосолсон аялал",
        adult_price: 1270000,
        child_price: 1200000,
        extra: {
          price_groups: [
            {
              dates: ["7 сарын 9", "7 сарын 18", "7 сарын 27"],
              adult_price: 1270000,
              child_price: 1200000,
              infant_price: 1050000,
              child_age: "2-10 нас",
              infant_age: "0-23 сар",
            },
          ],
        },
      }),
      trip({
        id: "jining-expensive-test",
        route_name: "Жинин - Мини аватар - Хөх хот + үнэтэй шинжилгээтэй",
        adult_price: 1100000,
        child_price: 1070000,
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /Бэйдайхэ шар тэнгисийн эрэг/);
  assert.match(reply || "", /Нярай \/0-23 сар\/: 1,050,000₮/);
  assert.doesNotMatch(reply || "", /үнэтэй шинжилгээтэй/);
});

test("a 0₮ infant fare is never quoted as a free seat", () => {
  // Extracted posters routinely land infant_price: 0 when the poster simply had
  // no infant row. Quoting "Нярай: 0₮" tells the customer infants fly free.
  const zeroInfantTrip = trip({
    id: "zero-infant",
    route_name: "Тест аялал А",
    adult_price: 1000000,
    child_price: 900000,
    extra: {
      price_groups: [
        {
          dates: ["9 сарын 12"],
          adult_price: 1000000,
          child_price: 900000,
          infant_price: 0,
          child_age: "2-12 нас",
          infant_age: "0-2 нас",
        },
      ],
    },
  });

  const fullPrice = buildStructuredTripReply(
    [zeroInfantTrip.route_name, "үнэ хэд вэ?"].join("\n"),
    [zeroInfantTrip],
    NOW,
  );
  assert.match(fullPrice || "", /Том хүн: 1,000,000₮/);
  assert.doesNotMatch(fullPrice || "", /:\s*0₮/);
  assert.doesNotMatch(fullPrice || "", /Нярай/);

  // Asking specifically about infants must still answer the question asked,
  // rather than silently returning an adult/child block.
  const infantAsk = buildStructuredTripReply(
    [zeroInfantTrip.route_name, "нярай хүүхэд үнэ хэд вэ?"].join("\n"),
    [zeroInfantTrip],
    NOW,
  );
  assert.match(infantAsk || "", /Нярайн үнэ тодорхойгүй/);
  assert.doesNotMatch(infantAsk || "", /:\s*0₮/);
  assert.doesNotMatch(infantAsk || "", /null|undefined/);
});

test("a 0₮ fare is treated as unknown in passenger totals, not as free", () => {
  const zeroInfantTrip = trip({
    id: "zero-infant-total",
    route_name: "Тест аялал А",
    adult_price: 1000000,
    child_price: 900000,
    extra: {
      price_groups: [
        {
          dates: ["9 сарын 12"],
          adult_price: 1000000,
          child_price: 900000,
          infant_price: 0,
        },
      ],
    },
  });

  const reply = buildStructuredTripReply(
    [zeroInfantTrip.route_name, "2 том хүн 1 нярай нийт хэд вэ"].join("\n"),
    [zeroInfantTrip],
    NOW,
  );

  // The infant must not silently contribute 0₮ to a quoted total.
  assert.doesNotMatch(reply || "", /Нярай 1 x 0₮/);
  assert.doesNotMatch(reply || "", /null|undefined/);
});

test("price question still answers when every price group has already departed", () => {
  // Staff routinely add new departure dates without adding matching price
  // groups, so a live trip can have future departures while all of its
  // price_groups dates sit in the past. The group tier must then fall through
  // to the flat trip price instead of emitting a bare "💰 Үнэ:" header.
  const staleGroupTrip = trip({
    id: "stale-groups",
    route_name: "Тест аялал Б",
    adult_price: 2000000,
    child_price: 1500000,
    departure_dates: ["9 сарын 12", "10 сарын 3"],
    extra: {
      price_groups: [
        {
          dates: ["7 сарын 9", "7 сарын 18"],
          adult_price: 2000000,
          child_price: 1500000,
          infant_price: 1050000,
          child_age: "2-10 нас",
          infant_age: "0-23 сар",
        },
      ],
    },
  });

  const reply = buildStructuredTripReply(
    [staleGroupTrip.route_name, "үнэ хэд вэ?"].join("\n"),
    [staleGroupTrip],
    new Date("2026-08-15T04:00:00.000Z"),
  );

  assert.match(reply || "", /Том хүн: 2,000,000₮/);
  assert.match(reply || "", /Хүүхэд: 1,500,000₮/);
  // The old behaviour: a price header with nothing under it.
  assert.doesNotMatch(reply || "", /💰 Үнэ:\s*(\n📅|\n*$)/);
});

test("fresh expensive objection does not match the paid-exam route by word alone", () => {
  const reply = buildStructuredTripReply(
    "Үнэтэй юм байна",
    [
      trip({
        id: "jining-expensive-test",
        route_name: "Жинин - Мини аватар - Хөх хот + үнэтэй шинжилгээтэй",
        adult_price: 1100000,
        child_price: 1070000,
      }),
    ],
  );

  assert.equal(reply, null);
});

test("ambiguous passenger total question shows totals for each possible trip", () => {
  const reply = buildStructuredTripReply(
    "Бэйдайхэ 2 том 1 хүүхэд нийт хэд вэ",
    [
      trip({
        id: "beidaihe-ground",
        route_name: "ШАР ТЭНГИС БУЮУ БЭЙДАЙХЭ-БЭЭЖИНГИЙН ГАЗРЫН АЯЛАЛ",
        adult_price: 1180000,
        child_price: 1160000,
      }),
      trip({
        id: "beidaihe-combo",
        route_name: "Бэйдайхэ шар тэнгисийн эрэг+Бээжин газар нислэг хосолсон аялал",
        adult_price: 1270000,
        child_price: 1200000,
      }),
    ],
  );

  assert.match(reply || "", /3,520,000₮/);
  assert.match(reply || "", /3,740,000₮/);
  assert.match(reply || "", /Аль аяллынх нь зөв болохыг сонгоорой/);
});

test("fresh expensive objection gets a generic budget follow-up without route guessing", () => {
  const reply = buildPriceObjectionReply("Үнэтэй юм байна");

  assert.match(reply || "", /Үнэ өндөр санагдаж болно/);
  assert.match(reply || "", /төсөвтэй/);
  assert.doesNotMatch(reply || "", /Жинин|шинжилгээ|хямдрал/i);
});

test("generic discount negotiation asks for budget and group size instead of matching a random trip", () => {
  const reply = buildPriceObjectionReply("2 том хүн 1 хүүхэд явна, хямдруулж болох уу?");

  assert.match(reply || "", /ямар төсөв/);
  assert.match(reply || "", /аль аяллыг/);
  assert.doesNotMatch(reply || "", /хэдүүлээ/);
  assert.doesNotMatch(reply || "", /Жинин|Хөх хот|Хайлаар|шинжилгээ/i);
});

test("price objection helper does not swallow real price questions", () => {
  assert.equal(buildPriceObjectionReply("нярай хүүхэд үнэтэй юу?"), null);
  assert.equal(buildPriceObjectionReply("ямар үнэтэй вэ?"), null);
});

test("broad infant-price query selects the related variant that stores an infant price", () => {
  const reply = buildStructuredTripReply(
    "Бэйдайхэ нярай хэд вэ?",
    [
      trip({
        id: "beidaihe-ground-no-infant",
        route_name: "ШАР ТЭНГИС БУЮУ БЭЙДАЙХЭ-БЭЭЖИНГИЙН ГАЗРЫН АЯЛАЛ",
        adult_price: 1160000,
        child_price: 1120000,
        extra: {
          aliases: ["Бэйдайхэ"],
          price_groups: [
            { dates: ["7 сарын 16"], adult_price: 1160000, child_price: 1120000 },
          ],
        },
      }),
      trip({
        id: "beidaihe-combo-with-infant",
        route_name: "Бэйдайхэ шар тэнгисийн эрэг + Бээжин газар нислэг хосолсон аялал",
        adult_price: 1270000,
        child_price: 1200000,
        extra: {
          aliases: ["Бэйдайхэ"],
          price_groups: [
            {
              dates: ["7 сарын 18", "8 сарын 1"],
              adult_price: 1270000,
              child_price: 1200000,
              infant_price: 1050000,
              infant_age: "0-23 сар",
            },
          ],
        },
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /газар нислэг хосолсон аялал/);
  assert.match(reply || "", /Нярай \/0-23 сар\/: 1,050,000₮/);
  assert.doesNotMatch(reply || "", /1,120,000₮/);
});

test("past specific date price does not fall forward to a future departure", () => {
  const reply = buildStructuredTripReply(
    "Бэйдайхэ шар тэнгисийн эрэг + Бээжин газар нислэг хосолсон аялал\n6 сарын 27-ны үнэ хэд вэ?",
    [
      trip({
        id: "beidaihe-combo",
        route_name: "Бэйдайхэ шар тэнгисийн эрэг + Бээжин газар нислэг хосолсон аялал",
        adult_price: 1270000,
        child_price: 1200000,
        extra: {
          price_groups: [
            {
              dates: ["6 сарын 27"],
              adult_price: 1270000,
              child_price: 1200000,
              infant_price: 1050000,
            },
            {
              dates: ["7 сарын 9"],
              adult_price: 1270000,
              child_price: 1200000,
              infant_price: 1050000,
            },
          ],
        },
      }),
    ],
    new Date("2026-07-08T04:00:00.000Z"),
  );

  assert.match(reply || "", /6 сарын 27-д тохирох үнийн мэдээлэл олдсонгүй/);
  assert.doesNotMatch(reply || "", /7 сарын 9/);
});

test("included-in-price question answers with ticket clarification instead of only the price", () => {
  const reply = buildStructuredTripReply(
    "Бээжин Юниверсал наадмын аяллын үнэд нислэгийн тийз багтсан уу?",
    [
      trip({
        id: "universal",
        route_name: "Бээжин - Юниверсал шууд нислэгтэй наадмын амралтаар гарах аялал",
        adult_price: 1790000,
        child_price: 1170000,
        extra: {
          aliases: ["Бээжин Юниверсал"],
          price_groups: [
            {
              label: "Наадмын тусгай",
              note: "Үнэ дээр нислэгийн тийз нэмэгдэнэ.",
              dates: ["7 сарын 9-14"],
              adult_price: 1790000,
              child_price: 1170000,
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
  assert.deepEqual(result?.brochure, { type: "url", value: "https://example.com/export-ground.pdf" });
  assert.deepEqual(result?.mediaUrls, []);
  assert.match(result?.reply || "", /Шар тэнгис/);
  assert.doesNotMatch(result?.reply || "", /Бэйдайхэ шар тэнгисийн эрэг \+ Бээжин/);
  assert.match(result?.reply || "", /PDF хөтөлбөр/);
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
  assert.match(result?.reply || "", /хавсаргалаа|Ñ…Ð°Ð²ÑÐ°Ñ€Ð³Ð°Ð»Ð°Ð°/);
  assert.doesNotMatch(result?.reply || "", /илгээж байна|Ð¸Ð»Ð³ÑÑÐ¶/);
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
  // The reply answers with what IS known and stays quiet about pictures —
  // the old "зураг системд ороогүй" footnote tripped the no-data silence
  // rule and suppressed the whole (correct) answer.
  assert.doesNotMatch(result?.reply || "", /системд ороогүй/);
  assert.doesNotMatch(result?.reply || "", /database/i);
});

test("seat reply omits seat wording when seats are unknown", () => {
  const reply = buildSeatsReply(
    "Зэт хаалга аяллын суудал байна уу?",
    [trip({ seats_left: null, seats_total: 20 })],
  );

  assert.match(reply || "", /Зэт/);
  assert.doesNotMatch(reply || "", /суудлын мэдээлэл|үлдсэн суудал|суудал дүүрсэн|цөөн үлдсэн/i);
});

test("seat reply omits seat wording when more than seven seats remain", () => {
  const reply = buildSeatsReply(
    "Зэт хаалга аяллын суудал байна уу?",
    [trip({ seats_left: 12, seats_total: 20 })],
  );

  assert.match(reply || "", /Зэт/);
  assert.doesNotMatch(reply || "", /12|үлдсэн суудал|цөөн үлдсэн|суудал дүүрсэн/i);
});

test("seat reply shows urgency when only a few seats remain", () => {
  const reply = buildSeatsReply(
    "Зэт хаалга аяллын суудал байна уу?",
    [trip({ seats_left: 3, seats_total: 20 })],
  );

  assert.match(reply || "", /Суудал цөөн үлдсэн тул захиалга өгөх бол аяллын зөвлөхтэй хурдан холбогдоорой./);
});

test("seat reply marks departure full only when seats_left is zero", () => {
  const reply = buildSeatsReply(
    "Зэт хаалга аяллын суудал байна уу?",
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

test("compare reply handles broad destination-vs-destination wording", () => {
  const reply = buildCompareReply("Бээжин уу Хайнан уу, аль нь дээр вэ?", [
    trip({
      id: "beijing-ground",
      route_name: "БЭЭЖИН - ЖИНИН – ЖАНЖАКОУ - ЭРЭЭН – 4 ХОТЫН АЯЛАЛ",
      adult_price: 1170000,
      child_price: 1130000,
      duration_text: "8 өдөр 7 шөнө",
    }),
    trip({
      id: "hainan-sanya",
      route_name: "Хайнан - Саньяа шууд нислэгтэй аялал",
      adult_price: 1430000,
      child_price: 1410000,
      duration_text: "9 өдөр / 8 шөнө",
    }),
  ]);

  assert.match(reply || "", /Аялал харьцуулалт/);
  assert.match(reply || "", /БЭЭЖИН/);
  assert.match(reply || "", /Хайнан/);
});

test("a direct-flight follow-up on a combo trip keeps the combo disclaimer even with stale contextual text prepended", () => {
  // Reproduces a live bug: the contextual blob prepends the bot's OWN previous
  // reply ("...хүүхдийн үнэ (2-10 нас) 1,200,000₮...") before the customer's
  // actual current line. That stale text must not be misread as the current
  // question — it hijacked "шууд нислэгтэй нь хэд байсан бэ?" into a bare
  // child-price answer with no combo disclaimer at all.
  const trips = [
    trip({
      id: "beidaihe-combo",
      route_name: "Бэйдайхэ шар тэнгисийн эрэг+Бээжин газар нислэг хосолсон аялал",
      category: "Газар нислэг хосолсон",
      adult_price: 1270000,
      child_price: 1200000,
      departure_dates: ["7 сарын 9", "7 сарын 18"],
    }),
  ];
  const staleContext =
    "Бэйдайхэ шар тэнгисийн эрэг + Бээжин газар нислэг хосолсон аяллын хүүхдийн үнэ (2-10 нас) 1,200,000₮ байна.\n\nХэрэв танд илүү дэлгэрэнгүй мэдээлэл хэрэгтэй бол асуугаарай! 😊";
  const contextualText = `${staleContext}\nтэр шууд нислэгтэй нь хэд байсан бэ?`;

  const reply = buildStructuredTripReply(contextualText, trips);

  assert.ok(reply);
  assert.match(reply as string, /газар \+ нислэг хосолсон аялал/);
  assert.match(reply as string, /Том хүн: 1,270,000₮/);
  assert.doesNotMatch(reply as string, /2027|20\d{2}-\d{2}-\d{2}/);
});

test("passenger-type price reply only reads the customer's current line, not stale prior context", () => {
  const trips = [
    trip({
      id: "beidaihe-combo-2",
      route_name: "Бэйдайхэ шар тэнгисийн эрэг+Бээжин газар нислэг хосолсон аялал",
      adult_price: 1270000,
      child_price: 1200000,
    }),
  ];
  const staleContext =
    "Бэйдайхэ шар тэнгисийн эрэг+Бээжин газар нислэг хосолсон аяллын хүүхдийн үнэ 1,200,000₮ байна.";
  const contextualText = `${staleContext}\nтом хүн хэд вэ?`;

  const reply = buildStructuredTripReply(contextualText, trips);

  assert.ok(reply);
  assert.match(reply as string, /Том хүн/);
  assert.doesNotMatch(reply as string, /Хүүхэд үнэ/);
});

test("price reply surfaces a mandatory extra fee stored in a foreign currency", () => {
  // Reproduces a live gap: a customer asking for the TOTAL cost of a trip
  // with a mandatory CNY exam fee got only the MNT base price back — the fee
  // silently disappeared because no fast-path reply builder ever read
  // extra.extra_fees, even though it's rendered into the AI's own Context.
  const withFee = trip({
    id: "hohhot-exam-fee",
    route_name: "Хөх хотын шинжилгээтэй - газрын аялал",
    adult_price: 1100000,
    child_price: 1060000,
    extra: {
      extra_fees: [
        { label: "Шинжилгээний төлбөр", amount: 600, currency: "CNY", applies_to: "том хүн" },
        { label: "Шинжилгээний төлбөр", amount: 300, currency: "CNY", applies_to: "хүүхэд" },
      ],
    },
  });

  const reply = buildSeatsReply("Хөх хотын шинжилгээтэй аялал хэд вэ?", [withFee]);

  assert.ok(reply);
  assert.match(reply as string, /Том хүн: 1,100,000₮/);
  assert.match(reply as string, /600.*CNY/);
  assert.match(reply as string, /300.*CNY/);
});

test("picture-only request for a trip without visual assets goes silent, program request still answers", () => {
  const bare = trip({
    id: "no-media",
    route_name: "Хайлаар Манжуурын аялал - 5 өдөр 4 шөнө",
    adult_price: 1100000,
    extra: {},
    photo_urls: [],
  });
  const photoAsk = buildTripProgramReply("Хайлаар Манжуур 5 өдөр зураг явуулаач", [bare]);
  assert.equal(photoAsk?.reply, "NOTRIPMEDIA");

  const programAsk = buildTripProgramReply("Хайлаар Манжуур 5 өдөр хөтөлбөр", [bare]);
  assert.notEqual(programAsk?.reply, "NOTRIPMEDIA");
  assert.match(programAsk?.reply || "", /Хайлаар Манжуурын аялал/);
});

test("picture-only request for a trip WITH photos sends those photos, never silence", () => {
  // Real bug (found 2026-07-22 probing the live demo/webhook): every active
  // trip stores its photos in the top-level photo_urls column, but the program
  // builder's media lookup only reads extra.program_images/media_assets. So a
  // photos-only ask ("X аяллын зураг") for a trip that HAS photos fell through
  // to the NOTRIPMEDIA silent branch — the customer asked for pictures of a
  // trip that has pictures and got silence + a staff handoff on all 14 photo
  // trips. photo_urls must be the fallback media source.
  const withPhotos = trip({
    id: "with-photos",
    route_name: "Далянь хотын шууд нислэгтэй аялал",
    adult_price: 1420000,
    extra: {},
    photo_urls: [
      "https://cdn.example.com/dalian-1.jpg",
      "https://cdn.example.com/dalian-2.jpg",
      "https://cdn.example.com/dalian-3.jpg",
      "https://cdn.example.com/dalian-4.jpg",
    ],
  });
  const photoAsk = buildTripProgramReply("Далянь аяллын зураг", [withPhotos]);
  assert.notEqual(photoAsk?.reply, "NOTRIPMEDIA");
  assert.deepEqual(photoAsk?.mediaUrls, withPhotos.photo_urls);
  assert.match(photoAsk?.reply || "", /Далянь хотын шууд нислэгтэй аялал/);
});

test("naming a trip by its own route-name words beats a competing trip's loose alias overlap", () => {
  // Real bug (2026-07-17): "Beejin jinin janjakow ereen 4 hotiin aylal" —
  // naming the 4-city trip by 4 of its own route-name words — matched the
  // UNRELATED Erlian-Beijing-Tianjin-Jeju cruise instead, because the
  // cruise's alias "Эрээн Бээжин Тяньжин Чежү Пусан круз" loosely shared 2
  // generic waypoint tokens (Эрээн, Бээжин) and a flat alias-hit bonus (80)
  // outscored the 4-city trip's real 4-word direct match (4*20=80, tied
  // before other boosts tipped it to the cruise).
  const fourCity = trip({
    id: "four-city",
    route_name: "БЭЭЖИН - ЖИНИН – ЖАНЖАКОУ - ЭРЭЭН – 4 ХОТЫН АЯЛАЛ",
    category: "Газрын аялал",
    extra: {},
  });
  const cruise = trip({
    id: "cruise",
    route_name: "Усан онгоцны аялал - Эрээн - Бээжин -Тяньжин - Чежү Пусан",
    category: "Круйз",
    extra: {
      aliases: [
        "Жэжү круз",
        "Усан онгоцны аялал",
        "Круйз аялал",
        "Эрээн Бээжин Тяньжин Чежү Пусан круз",
        "Тяньжин Инчон Жэжү круз",
      ],
    },
  });

  const matches = findTripMatches(
    "Beejin jinin janjakow ereen 4 hotiin aylal sonirhoj bna",
    [fourCity, cruise],
  );
  assert.equal(matches[0]?.trip.id, "four-city");
});

test("a name shared by several tours asks instead of guessing one", () => {
  // Structural shape being tested (synthetic names — never real catalog data):
  // one shared multi-word name ("Зэт хаалга") appearing in THREE tours, one of
  // which also registers that exact shared part as an alias. Nothing in the
  // message says which is meant, so committing to the top-scoring one shipped a
  // wrong price, programme AND poster at full confidence.
  const shared = [
    trip({ id: "tk-solo", route_name: "Зэт хаалга - шууд нислэгтэй", adult_price: 1000000,
      extra: { aliases: ["Зэт хаалга"] } }),
    trip({ id: "tk-second", route_name: "Зэт хаалга-Күби", adult_price: 1100000 }),
    trip({ id: "tk-combined", route_name: "Альфа + Зэт хаалга шууд нислэгтэй аялал", adult_price: 1200000 }),
  ];

  const resolution = resolveTripFromUserMessage("Зэт хаалга үнэ хэд вэ?", shared, {
    allowLooseFallback: false,
  });
  assert.equal(resolution.status, "ambiguous");

  // The alias above makes the solo tour the only "exactly mentioned" one; that
  // must not override the ambiguity and send its poster.
  const program = buildTripProgramReply("Зэт хаалга зураг", shared);
  assert.equal(program?.trip, null);
  assert.deepEqual(program?.mediaUrls, []);
});

test("naming both destinations still resolves the combined tour", () => {
  // Shape: a short name that is a strict subset of a longer combined name.
  const shared = [
    trip({ id: "tk-solo", route_name: "Зэт хаалга - шууд нислэгтэй", adult_price: 1000000 }),
    trip({ id: "tk-combined", route_name: "Альфа + Зэт хаалга шууд нислэгтэй аялал", adult_price: 1200000 }),
  ];
  const resolution = resolveTripFromUserMessage("Альфа + Зэт хаалга үнэ", shared, {
    allowLooseFallback: false,
  });
  assert.equal(resolution.status, "verified");
  assert.equal(resolution.trip?.id, "tk-combined");
});

test("a uniquely named tour still answers directly", () => {
  const trips = [
    trip({ id: "unique-a", route_name: "Дельта хотын шууд нислэгтэй аялал", photo_urls: ["https://example.com/d1.png"] }),
    trip({ id: "unique-b", route_name: "Гамма Сигмагийн аялал" }),
  ];
  const resolution = resolveTripFromUserMessage("Дельта зураг", trips, { allowLooseFallback: false });
  assert.equal(resolution.status, "verified");
  assert.equal(resolution.trip?.id, "unique-a");
});

test("a documented-free infant is quoted as Үнэгүй, not suppressed as missing", () => {
  // child_rules note "Үнэгүй" on a 0₮ infant entry means genuinely free (agency
  // policy) — this must render as a real answer, not the "тодорхойгүй" fallback
  // meant for a poster that never carried an infant price at all.
  const freeInfantTrip = trip({
    id: "free-infant",
    route_name: "Тест аялал В",
    adult_price: 1000000,
    child_price: 900000,
    extra: {
      price_groups: [{
        dates: ["9 сарын 12"],
        adult_price: 1000000,
        child_price: 900000,
        infant_price: 0,
        infant_age: "0-2 нас",
      }],
      child_rules: [
        { note: "Үнэгүй", label: "Нярай", price: 0, age_range: "0-2 нас" },
      ],
    },
  });

  // Pinned clock: the fixture's price group departs on 9 сарын 12, and this
  // test is about the FREE-INFANT rendering, not date filtering. Left
  // unpinned it silently became a time bomb (caught by a clock-shift sweep) —
  // once that date passed, the group dropped out and the assertion started
  // exercising the flat-price path instead of the one under test.
  const priceReply = buildStructuredTripReply(
    [freeInfantTrip.route_name, "үнэ хэд вэ?"].join("\n"),
    [freeInfantTrip],
    NOW,
  );
  assert.match(priceReply || "", /Нярай[^:]*:\s*Үнэгүй/);
  assert.doesNotMatch(priceReply || "", /тодорхойгүй/);

  const infantAsk = buildStructuredTripReply(
    [freeInfantTrip.route_name, "нярай хүүхэд үнэ хэд вэ?"].join("\n"),
    [freeInfantTrip],
    NOW,
  );
  assert.match(infantAsk || "", /Үнэгүй/);
  assert.doesNotMatch(infantAsk || "", /тодорхойгүй|Холбогдох дугаараа/);
});

test("a documented-free infant survives its price group's dates passing", () => {
  // Trip-level "infants ride free" (child_rules) must not disappear from the
  // main price answer once every price group has departed — the flat-price
  // fall-through used to drop it, so the same trip answered "Үнэгүй" to
  // "нярай үнэ?" but omitted infants entirely from "үнэ хэд вэ?".
  const freeInfantTrip = trip({
    id: "free-infant-departed",
    route_name: "Тест аялал З",
    adult_price: 1000000,
    child_price: 900000,
    extra: {
      price_groups: [{ dates: ["9 сарын 12"], adult_price: 1000000, child_price: 900000, infant_price: 0, infant_age: "0-2 нас" }],
      child_rules: [{ note: "Үнэгүй", label: "Нярай", price: 0, age_range: "0-2 нас" }],
    },
  });

  const afterDeparture = new Date("2026-12-20T04:00:00.000Z");
  const reply = buildStructuredTripReply(
    [freeInfantTrip.route_name, "үнэ хэд вэ?"].join("\n"),
    [freeInfantTrip],
    afterDeparture,
  );
  assert.match(reply || "", /Том хүн: 1,000,000₮/);
  assert.match(reply || "", /Нярай:\s*Үнэгүй/);
});

test("a free-infant note never zeroes out a real, separately-priced child fare", () => {
  // Real catalog bug this guards: one trip's child_rules used the SAME label
  // ("Хүүхэд") for both the genuine child tier (1,070,000₮) and a mislabeled
  // infant tier (0₮, "Үнэгүй", age 2024-2026 = 0-2yo) — matching on label alone
  // made the real child price disappear as "Үнэгүй" too.
  const mixedTrip = trip({
    id: "mixed-labels",
    route_name: "Тест аялал Г",
    adult_price: 1100000,
    child_price: 1070000,
    extra: {
      price_groups: [{
        dates: ["Өдөр бүр"],
        adult_price: 1100000,
        child_price: 1070000,
        infant_price: 0,
        child_age: "2016-2023 он",
        infant_age: "2024-2026 он",
      }],
      child_rules: [
        { note: "", label: "Хүүхэд", price: 1070000, age_range: "2016-2023 он" },
        { note: "Үнэгүй", label: "Хүүхэд", price: 0, age_range: "2024-2026 он" },
      ],
    },
  });

  // The invariant asserted here is deliberately the TIME-INDEPENDENT one: the
  // real child fare must survive, always. Whether the 2024-2026 band still
  // reads as "infant" legitimately depends on the current year (those children
  // are 4+ by 2028 and correctly stop qualifying), and that determination is
  // made against the system clock inside isInfantShapedAge — it is NOT
  // controlled by the `now` argument threaded through the reply builders, so
  // passing a pinned date here would not actually pin it. Year-independent
  // free-infant rendering is covered separately by the "0-2 нас" fixture test.
  const reply = buildStructuredTripReply(
    [mixedTrip.route_name, "үнэ хэд вэ?"].join("\n"),
    [mixedTrip],
  );
  assert.match(reply || "", /Хүүхэд[^:]*:\s*1,070,000₮/, "the real child price must survive");
  assert.doesNotMatch(
    reply || "",
    /Хүүхэд[^:]*:\s*Үнэгүй/,
    "a 0/Үнэгүй rule for a different age band must never make the real child tier free",
  );
});

test("distinct age-banded child fares are broken out instead of one flat price", () => {
  // Real catalog bug: a trip with TWO child_rules tiers at different prices
  // (1,160,000₮ for one birth-year band, 1,130,000₮ for another) had no
  // price_groups, so the reply fell back to a single flat child_price and
  // silently overcharged the cheaper band.
  const tieredTrip = trip({
    id: "tiered-child",
    route_name: "Тест аялал Д",
    adult_price: 1170000,
    child_price: 1160000,
    extra: {
      child_rules: [
        { note: "", label: "хүүхэд", price: 1160000, age_range: "2014-2015 онд төрсөн" },
        { note: "", label: "хүүхэд", price: 1130000, age_range: "2016-2023 онд төрсөн" },
        { note: "Үнэгүй", label: "Нярай", price: 0, age_range: "2024-2026 онд төрсөн" },
      ],
    },
  });

  const reply = buildStructuredTripReply(
    [tieredTrip.route_name, "үнэ хэд вэ?"].join("\n"),
    [tieredTrip],
  );
  assert.match(reply || "", /1,160,000₮/);
  assert.match(reply || "", /1,130,000₮/);
  assert.match(reply || "", /Нярай:\s*Үнэгүй/);
});

test("a genitive-case trip name ('X-ийн') still resolves to the trip", () => {
  // Shape (synthetic name): the customer inflects the destination — Mongolian is
  // agglutinative, so "Зэтань" becomes "Зэтанийн" ("Zetan's"). The query token
  // then never string-equals the bare route token, and the resolver used to
  // return not_found and drop the whole message silently.
  const trips = [
    trip({ id: "inflected", route_name: "Зэтань хотын шууд нислэгтэй аялал", adult_price: 1000000 }),
    trip({ id: "other", route_name: "Гамма Сигмагийн аялал" }),
  ];
  const resolution = resolveTripFromUserMessage("Зэтанийн аялалын үнэ хэд вэ?", trips, {
    allowLooseFallback: false,
  });
  assert.equal(resolution.status, "verified");
  assert.equal(resolution.trip?.id, "inflected");
});

test("compound photo+price question answers the price even when the trip has no photos", () => {
  // Real bug: a message asking for BOTH a photo and a real answer (price/
  // dates/duration) for a trip with zero photo_urls returned complete
  // silence + handoff for the WHOLE message, not just the unavailable photo
  // part -- buildTripProgramReply's "no photos" sentinel was treated as
  // final by the caller instead of falling back to the structured answer.
  const noPhotoTrip = trip({
    id: "no-photos",
    route_name: "Тест аялал Е",
    adult_price: 1420000,
    child_price: 1320000,
    photo_urls: [],
  });
  const result = buildProgramOrStructuredReply(
    `${noPhotoTrip.route_name} үнэ хэд вэ, мөн зураг үзүүлээч`,
    [noPhotoTrip],
  );
  assert.ok(result, "must not return null/silence when a real answer exists");
  assert.match(result?.reply || "", /1,420,000₮/);
  assert.notEqual(result?.reply, "NOTRIPMEDIA");
});

test("a photo-only question for a photo-less trip still stays silent (owner policy)", () => {
  // The fallback above must not turn EVERY photo request into a wall of
  // unrelated price/date text -- a bare "зураг" ask with nothing else
  // answerable keeps the intended silent handoff.
  const noPhotoTrip = trip({
    id: "no-photos-2",
    route_name: "Тест аялал Ж",
    photo_urls: [],
    adult_price: null,
    child_price: null,
  });
  const result = buildProgramOrStructuredReply(`${noPhotoTrip.route_name} зураг үзүүлээч`, [noPhotoTrip]);
  assert.equal(result?.reply, "NOTRIPMEDIA");
});
