import assert from "node:assert/strict";
import test from "node:test";
import { appendLeadCaptureCta, buildClarificationButtons, buildCompareReply, buildDiscountReply, buildPriceObjectionReply, buildProgramOrStructuredReply, buildSeatsReply, buildSmartButtons, buildStructuredTripReply, buildTripProgramReply, LEAD_CAPTURE_CTA, resolveTripFromUserMessage } from "../src/lib/travelFastPaths";
import { findTripMatches } from "../src/lib/travelFastPathsSearch";
import { joinContextAndTurn } from "../src/lib/customerTurn";
import { quickReplyTitle } from "../src/lib/quickReplyTitle";
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
    infant_price: null,
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
  const resolution = resolveTripFromUserMessage("Surmak une hed ve?", [
    trip({ id: "surmak-felmor", route_name: "Surmak Felmor аялал" }),
    trip({ id: "surmak-anmor", route_name: "Surmak Anmor аялал" }),
  ]);

  assert.equal(resolution.status, "ambiguous");
  assert.deepEqual(
    resolution.candidates.map((candidate) => candidate.id).sort(),
    ["surmak-anmor", "surmak-felmor"],
  );
});

test("appendLeadCaptureCta adds the phone ask to a normal fast-path answer", () => {
  const out = appendLeadCaptureCta("✈️ Вэлмор аялал\n💰 Том хүн: 1,210,000₮", false);
  assert.match(out, /1,210,000₮/);
  assert.ok(out.endsWith(LEAD_CAPTURE_CTA));
});

test("appendLeadCaptureCta skips when phone already collected", () => {
  const reply = "✈️ Вэлмор аялал\n💰 Том хүн: 1,210,000₮";
  assert.equal(appendLeadCaptureCta(reply, true), reply);
});

test("smart buttons offer useful next taps for a matched trip with photos", () => {
  const buttons = buildSmartButtons(
    "✈️ Кардан сэрвэн тэнгисийн эрэг + Вэлмор газар нислэг хосолсон аялал\n💰 Том хүн: 1,270,000₮",
    [
      trip({
        id: "kardan-combo",
        route_name: "Кардан сэрвэн тэнгисийн эрэг + Вэлмор газар нислэг хосолсон аялал",
        photo_urls: ["https://example.com/kardan-1.jpg"],
      }),
    ],
  );

  // "Зөвлөхтэй холбогдох" rides along on every set: reaching a human has to
  // be a visible choice, not one the customer has to know to ask for.
  assert.deepEqual(buttons, [
    "Хөтөлбөр үзэх",
    "Зураг үзэх",
    "Захиалах",
    "Зөвлөхтэй холбогдох",
  ]);
});

test("clarification buttons are numbered and messenger-sized", () => {
  const buttons = buildClarificationButtons([
    trip({
      id: "four-city-ground",
      route_name: "ЗЭТ - АЛЬФА – ВЭЛМОР - КАРДАН – 4 ХОТЫН АЯЛАЛ",
    }),
    trip({
      id: "sea-combo",
      route_name: "Лумиа сэрвэн тэнгисийн эрэг + Зэт газар нислэг хосолсон аялал",
    }),
  ]);

  assert.equal(buttons.length, 2);
  assert.ok(buttons[0].startsWith("1. "));
  assert.ok(buttons[1].startsWith("2. "));
  // The label is the quick-reply PAYLOAD and keeps the whole name (a 20-char
  // cut came back as "1. <first 20 characters>...", shared by two trips); the
  // title Messenger displays is what must fit.
  assert.equal(buttons[0], "1. ЗЭТ - АЛЬФА – ВЭЛМОР - КАРДАН – 4 ХОТЫН АЯЛАЛ");
  assert.ok(buttons.every((button) => quickReplyTitle(button).length <= 20));
});

test("appendLeadCaptureCta skips clarifying (ambiguous) replies", () => {
  const ambiguous = buildStructuredTripReply("Surmak une hed ve?", [
    trip({ id: "surmak-felmor", route_name: "Surmak Felmor аялал", adult_price: 1490000 }),
    trip({ id: "surmak-anmor", route_name: "Surmak Anmor аялал", adult_price: 1790000 }),
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
  const reply = buildStructuredTripReply("Surmak une hed ve?", [
    trip({ id: "surmak-felmor", route_name: "Surmak Felmor аялал", adult_price: 1490000 }),
    trip({ id: "surmak-anmor", route_name: "Surmak Anmor аялал", adult_price: 1790000 }),
  ]);

  assert.match(reply || "", /Аль аяллыг нь сонирхож/i);
  assert.match(reply || "", /Surmak Felmor/);
  assert.match(reply || "", /Surmak Anmor/);
  assert.match(reply || "", /1,490,000/);
  assert.match(reply || "", /1,790,000/);
});

test("trip info reply never leaks an internal duration QA sentinel", () => {
  const reply = buildSeatsReply("Зэтгорийн хаалга суудал бий юу?", [
    trip({
      id: "zetgoriin-khaalga-unverified-duration",
      duration_text: "Нийт хугацаа тодорхойгүй, баталгаажуулах шаардлагатай",
    }),
  ]);

  assert.ok(reply);
  assert.doesNotMatch(reply as string, /баталгаажуулах шаардлагатай/);
  assert.doesNotMatch(reply as string, /тодорхойгүй/);
});

test("broad Velmor price question clarifies instead of picking one variant", () => {
  const resolution = resolveTripFromUserMessage("Вэлмор аялал хэд вэ?", [
    trip({
      id: "velmor-four-city",
      route_name: "ВЭЛМОР - СЭЛВИН – ПЭЛМАК - ОРМАК – 4 ХОТЫН АЯЛАЛ",
      category: "Газрын аялал",
    }),
    trip({
      id: "kardan-velmor-combo",
      route_name: "Кардан сэрвэн тэнгисийн эрэг+Вэлмор газар нислэг хосолсон аялал",
      category: "Газар нислэг хосолсон",
    }),
    trip({
      id: "velmor-naadam-ground",
      route_name: "ВЭЛМОР - СЭЛВИН – ПЭЛМАК - ОРМАК-наадмын амралтаар явах газрын аялал",
      category: "Газрын аялал",
    }),
  ]);

  assert.equal(resolution.status, "ambiguous");
});

test("human correction not Velmor, the sea one picks the sea/beach variant", () => {
  const resolution = resolveTripFromUserMessage("Вэлмор биш, далайтай нь", [
    trip({
      id: "velmor-four-city",
      route_name: "ВЭЛМОР - СЭЛВИН – ПЭЛМАК - ОРМАК – 4 ХОТЫН АЯЛАЛ",
      category: "Газрын аялал",
    }),
    trip({
      id: "kardan-velmor-combo",
      route_name: "Кардан сэрвэн тэнгисийн эрэг+Вэлмор газар нислэг хосолсон аялал",
      category: "Газар нислэг хосолсон",
    }),
    trip({
      id: "velmor-naadam-ground",
      route_name: "ВЭЛМОР - СЭЛВИН – ПЭЛМАК - ОРМАК-наадмын амралтаар явах газрын аялал",
      category: "Газрын аялал",
    }),
  ]);

  assert.equal(resolution.status, "verified");
  assert.equal(
    resolution.status === "verified" ? resolution.trip.id : null,
    "kardan-velmor-combo",
  );
});

test("direct-flight Velmor price does not answer with combo tour price", () => {
  const reply = buildStructuredTripReply("Вэлмор шууд нислэгтэй нь хэд вэ?", [
    trip({
      id: "velmor-four-city",
      route_name: "ВЭЛМОР - СЭЛВИН – ПЭЛМАК - ОРМАК – 4 ХОТЫН АЯЛАЛ",
      category: "Газрын аялал",
      adult_price: 1790000,
      child_price: 1490000,
    }),
    trip({
      id: "kardan-velmor-combo",
      route_name: "Кардан сэрвэн тэнгисийн эрэг+Вэлмор газар нислэг хосолсон аялал",
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
  const reply = buildStructuredTripReply("Сэлвин Универсал шууд нислэгтэй хэд вэ, суудал байгаа юу?", [
    trip({
      id: "anmor-sold-out",
      route_name: "Вэлмор - Янмор шууд нислэгтэй наадмын амралтаар гарах аялал",
      category: "Шууд нислэгтэй аялал",
      status: "sold_out",
      extra: {
        aliases: ["Вэлмор Янмор", "Универсал"],
      },
    }),
    trip({
      id: "selvin-ground",
      route_name: "Сэлвин - Утай - Гүмбэн",
      category: "Газрын аялал",
    }),
  ]);

  assert.match(reply || "", /Янмор/);
  assert.match(reply || "", /суудал дууссан/);
  assert.doesNotMatch(reply || "", /яг шууд нислэгтэй аялал одоогоор тодорхой олдсонгүй/);
  assert.doesNotMatch(reply || "", /Сэлвин - Утай - Гүмбэн/);
});

test("sold-out reply pitches active same-destination trips instead of dead-ending", () => {
  const reply = buildStructuredTripReply("Универсал аялал суудал байгаа юу?", [
    trip({
      id: "anmor-sold-out",
      route_name: "Вэлмор - Янмор шууд нислэгтэй наадмын амралтаар гарах аялал",
      category: "Шууд нислэгтэй аялал",
      status: "sold_out",
      extra: { aliases: ["Вэлмор Янмор", "Универсал"] },
    }),
    trip({
      id: "velmor-four-city",
      route_name: "ВЭЛМОР - СЭЛВИН – ПЭЛМАК - ОРМАК – 4 ХОТЫН АЯЛАЛ",
      category: "Газрын аялал",
      adult_price: 1170000,
      duration_text: "8 өдөр 7 шөнө",
    }),
    trip({
      id: "mirven-unrelated",
      route_name: "Мирвэн - Нарвэл шууд нислэгтэй аялал",
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
  assert.doesNotMatch(reply || "", /Мирвэн/);
});

test("a paused trip is reported as not currently active, not sold out", () => {
  const reply = buildStructuredTripReply("Сэлвин Универсал шууд нислэгтэй хэд вэ, суудал байгаа юу?", [
    trip({
      id: "anmor-paused",
      route_name: "Вэлмор - Янмор шууд нислэгтэй наадмын амралтаар гарах аялал",
      category: "Шууд нислэгтэй аялал",
      status: "paused",
      extra: { aliases: ["Вэлмор Янмор", "Универсал"] },
    }),
    trip({
      id: "selvin-ground",
      route_name: "Сэлвин - Утай - Гүмбэн",
      category: "Газрын аялал",
    }),
  ]);

  assert.match(reply || "", /Янмор/);
  assert.match(reply || "", /идэвхгүй/);
  assert.doesNotMatch(reply || "", /суудал дууссан/);
});

test("a paused trip's reply pitches active same-destination trips too", () => {
  const reply = buildStructuredTripReply("Универсал аялал байгаа юу?", [
    trip({
      id: "anmor-paused",
      route_name: "Вэлмор - Янмор шууд нислэгтэй наадмын амралтаар гарах аялал",
      category: "Шууд нислэгтэй аялал",
      status: "paused",
      extra: { aliases: ["Вэлмор Янмор", "Универсал"] },
    }),
    trip({
      id: "velmor-four-city",
      route_name: "ВЭЛМОР - СЭЛВИН – ПЭЛМАК - ОРМАК – 4 ХОТЫН АЯЛАЛ",
      category: "Газрын аялал",
      adult_price: 1170000,
      duration_text: "8 өдөр 7 шөнө",
    }),
  ]);

  assert.match(reply || "", /идэвхгүй/);
  assert.match(reply || "", /нээлттэй/);
  assert.match(reply || "", /4 ХОТЫН АЯЛАЛ/);
});

test("program reply asks for clarification on shared city-only PDF request", () => {
  const result = buildTripProgramReply("Surmak program pdf", [
    trip({
      id: "surmak-felmor",
      route_name: "Surmak Felmor аялал",
      extra: { program_images: ["https://example.com/felmor-program.jpg"] },
    }),
    trip({
      id: "surmak-anmor",
      route_name: "Surmak Anmor аялал",
      extra: { program_images: ["https://example.com/anmor-program.jpg"] },
    }),
  ]);

  assert.match(result?.reply || "", /Аль аяллыг нь сонирхож/i);
  assert.equal(result?.trip, null);
  assert.deepEqual(result?.mediaUrls, []);
});

test("matches Peldor alias to the Lumia + Zetgoriin Khaalga route", () => {
  const reply = buildStructuredTripReply(
    "Лумиа Пэлдор аяллын 6 сарын 27, 7 сарын 18 үнэ адилхан уу?",
    [
      trip({
        id: "lumia",
        route_name: "Лумиа + Зэтгорийн хаалга шууд нислэгтэй аялал",
        duration_text: "6 өдөр / 5 шөнө",
        adult_price: 3601000,
        child_price: 1470000,
        extra: {
          aliases: ["Пэлдор", "Peldor", "Лумиа Пэлдор"],
          departure_date_groups: [
            {
              dates: ["6 сарын 27"],
              adult_price: 3601000,
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
        id: "kardan",
        route_name: "Кардан, Тэлмор хотын аялал",
        duration_text: "8 өдөр / 7 шөнө",
        adult_price: 2701000,
        child_price: 1320000,
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /Лумиа \+ Зэтгорийн хаалга/);
  assert.match(reply || "", /адил биш/);
  assert.doesNotMatch(reply || "", /Кардан/);
});

test("matches latin lumia query to the Lumia route", () => {
  const resolution = resolveTripFromUserMessage(
    "lumia aylal medeelel",
    [
      trip({
        id: "lumia-peldor",
        route_name: "Лумиа + Зэтгорийн хаалга шууд нислэгтэй аялал",
        extra: {
          aliases: ["Лумиа Пэлдор", "Лумиа Зэтгорийн хаалга", "Lumia"],
        },
      }),
      trip({
        id: "velmor-ground",
        route_name: "СЭРВЭН ТЭНГИС БУЮУ КАРДАН-ВЭЛМОРГИЙН ГАЗРЫН АЯЛАЛ",
      }),
    ],
  );

  assert.equal(resolution.status, "verified");
  assert.equal(
    resolution.status === "verified" ? resolution.trip.id : null,
    "lumia-peldor",
  );
});

test("prefers the direct-flight Zetgoriin Khaalga trip over longer variants", () => {
  const reply = buildStructuredTripReply(
    "Зэтгорийн хаалга шууд нислэгтэй аялал хэд вэ?",
    [
      trip({
        id: "base",
        route_name: "Зэтгорийн хаалга - шууд нислэгтэй",
        adult_price: 1480000,
        child_price: 1430000,
      }),
      trip({
        id: "with-eldor",
        route_name: "Зэтгорийн хаалга-Эльдор",
        adult_price: 3601000,
        child_price: 1470000,
      }),
      trip({
        id: "with-lumia",
        route_name: "Лумиа + Зэтгорийн хаалга шууд нислэгтэй аялал",
        adult_price: 3601000,
        child_price: 1470000,
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /^✈️ Зэтгорийн хаалга - шууд нислэгтэй/m);
  assert.match(reply || "", /1,480,000₮/);
  assert.doesNotMatch(reply || "", /Лумиа \+/);
  assert.doesNotMatch(reply || "", /Эльдор/);
});

test("prefers inferred combo Zetgoriin Khaalga trip when user asks газар нислэгтэй", () => {
  const reply = buildStructuredTripReply(
    "Зэтгорийн хаалга газар нислэгтэй хэд вэ?",
    [
      trip({
        id: "direct",
        route_name: "Зэтгорийн хаалга - шууд нислэгтэй",
        category: "шууд нислэгтэй аялал",
        adult_price: 1430000,
        child_price: 1410000,
        source_description: "8 өдөр 7 шөнө. УБ - Пэлдор - УБ шууд нислэгтэй.",
      }),
      trip({
        id: "combo",
        route_name: "Зэтгорийн хаалга-Эльдор",
        category: "",
        adult_price: 1480000,
        child_price: 1430000,
        source_description: "8 өдөр 7 шөнө. Зэтгорийн хаалга, Эльдор хосолсон аялал.",
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /^✈️ Зэтгорийн хаалга-Эльдор/m);
  assert.match(reply || "", /1,480,000₮/);
  assert.doesNotMatch(reply || "", /^✈️ Зэтгорийн хаалга - шууд нислэгтэй/m);
});

test("answers that hybrid land+flight route is not a direct flight", () => {
  const reply = buildStructuredTripReply(
    "Вэлмор Кардэн газар нислэг хосолсон аялал шууд нислэгтэй юу?",
    [
      trip({
        id: "hybrid",
        route_name: "Кардан+Вэлмор газар нислэг хосолсон аялал",
        duration_text: "9 өдөр / 8 шөнө",
        adult_price: 2030000,
        child_price: 1170000,
        source_description: "Газар нислэг хосолсон маршрут",
        extra: { aliases: ["Кардэн", "Бэйдэйхэ", "Kardan"] },
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /шууд нислэгтэй биш/);
  assert.match(reply || "", /9 өдөр \/ 8 шөнө/);
});

test("discount questions still show regular price when no promo price is stored", () => {
  const reply = buildDiscountReply(
    "Мирвэн Хайкоу аяллын хямдралтай үнэ байгаа юу?",
    [
      trip({
        id: "haikou",
        route_name: "Мирвэн - Хайкоу шууд нислэгтэй аялал",
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
    "Лумиа Пэлдор аяллын 6 сарын 27, 7 сарын 18 үнэ адилхан уу?",
    [
      trip({
        id: "lumia-missing-groups",
        route_name: "Лумиа + Зэтгорийн хаалга шууд нислэгтэй аялал",
        duration_text: "8 өдөр / 7 шөнө",
        adult_price: 3601000,
        child_price: 1470000,
        departure_dates: ["6 сарын 27", "7 сарын 18"],
        extra: { aliases: ["Пэлдор", "Лумиа Пэлдор"] },
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
        id: "kardan-flight",
        route_name: "ÐšÐ°Ñ€Ð´Ð°Ð½+Ð’ÑÐ»Ð¼Ð¾Ñ€ Ð³Ð°Ð·Ð°Ñ€ Ð½Ð¸ÑÐ»ÑÐ³ Ñ…Ð¾ÑÐ¾Ð»ÑÐ¾Ð½ Ð°ÑÐ»Ð°Ð»",
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
        route_name: "Ð’ÑÐ»Ð¼Ð¾Ñ€ Ñ…Ð¾Ñ‚Ñ‹Ð½ Ð°ÑÐ»Ð°Ð»",
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
        route_name: "Ð¡ÑÐ»Ð²Ð¸Ð½ Ð¼Ð¸Ð½Ð¸ ÑÐ¼Ð±Ð°Ñ€",
        duration_text: "4 Ó©Ð´Ó©Ñ€ / 3 ÑˆÓ©Ð½Ó©",
        adult_price: 1110000,
        departure_dates: ["7 ÑÐ°Ñ€Ñ‹Ð½ 9"],
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /1270000|1,270,000/);
  assert.match(reply || "", /ÐšÐ°Ñ€Ð´Ð°Ð½\+Ð’ÑÐ»Ð¼Ð¾Ñ€/);
  assert.doesNotMatch(reply || "", /Ð¡ÑÐ»Ð²Ð¸Ð½/);
  assert.doesNotMatch(reply || "", /Ð’ÑÐ»Ð¼Ð¾Ñ€ Ñ…Ð¾Ñ‚Ñ‹Ð½ Ð°ÑÐ»Ð°Ð»/);
});

test("combined date and price query falls back to close matches on the same date only", () => {
  const reply = buildStructuredTripReply(
    "7/9 1310000 Ð°ÑÐ»Ð°Ð»",
    [
      trip({
        id: "close-a",
        route_name: "ÐšÐ°Ñ€Ð´Ð°Ð½+Ð’ÑÐ»Ð¼Ð¾Ñ€ Ð³Ð°Ð·Ð°Ñ€ Ð½Ð¸ÑÐ»ÑÐ³ Ñ…Ð¾ÑÐ¾Ð»ÑÐ¾Ð½ Ð°ÑÐ»Ð°Ð»",
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
        route_name: "Ð’ÑÐ»Ð¼Ð¾Ñ€ ÑˆÑƒÑƒÐ´ Ð½Ð¸ÑÐ»ÑÐ³Ñ‚ÑÐ¹",
        duration_text: "5 Ó©Ð´Ó©Ñ€ / 4 ÑˆÓ©Ð½Ó©",
        departure_dates: ["7 ÑÐ°Ñ€Ñ‹Ð½ 9"],
        extra: {
          price_groups: [
            {
              dates: ["7 ÑÐ°Ñ€Ñ‹Ð½ 9"],
              adult_price: 2301000,
              child_price: 1210000,
            },
          ],
        },
      }),
      trip({
        id: "other-date",
        route_name: "ÐœÐ¸Ñ€Ð²ÑÐ½ ÑˆÑƒÑƒÐ´ Ð½Ð¸ÑÐ»ÑÐ³Ñ‚ÑÐ¹",
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
  assert.match(reply || "", /ÐšÐ°Ñ€Ð´Ð°Ð½\+Ð’ÑÐ»Ð¼Ð¾Ñ€/);
  assert.match(reply || "", /Ð’ÑÐ»Ð¼Ð¾Ñ€ ÑˆÑƒÑƒÐ´ Ð½Ð¸ÑÐ»ÑÐ³Ñ‚ÑÐ¹/);
  assert.doesNotMatch(reply || "", /ÐœÐ¸Ñ€Ð²ÑÐ½/);
});

test("month-specific child price only returns that month and passenger type", () => {
  const reply = buildStructuredTripReply(
    "Кардан 8 сарын хүүхдийн үнэ өөр үү?",
    [
      trip({
        id: "kardan-month-child",
        route_name: "Кардан + Вэлмор газар нислэг хосолсон аялал",
        departure_dates: ["7 сарын 9", "7 сарын 18", "8 сарын 1", "8 сарын 8"],
        extra: {
          aliases: ["Кардан", "Кардэн"],
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
    "Вэлмор Кардэн газар нислэг хосолсон аялал",
    [
      trip({
        id: "kardan-premium",
        route_name: "Кардан + Вэлмор газар нислэг хосолсон аялал",
        duration_text: "9 өдөр / 8 шөнө",
        departure_dates: ["6 сарын 20", "6 сарын 27", "7 сарын 9", "7 сарын 18", "7 сарын 27", "8 сарын 1", "8 сарын 8", "8 сарын 15", "8 сарын 22"],
        extra: {
          aliases: ["Кардэн", "Бэйдэйхэ", "Kardan"],
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
    "ÐšÐ°Ñ€Ð´Ð°Ð½ Ð°ÑÐ»Ð»Ñ‹Ð½ Ð´ÑÐ»Ð³ÑÑ€ÑÐ½Ð³Ò¯Ð¹ Ñ…Ó©Ñ‚Ó©Ð»Ð±Ó©Ñ€ pdf",
    [
      trip({
        id: "program-pdf",
        route_name: "ÐšÐ°Ñ€Ð´Ð°Ð½ Ð°ÑÐ»Ð°Ð»",
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
    "Талвин poster зураг явуул",
    [
      trip({
        id: "talvin",
        route_name: "Талвин арлын аялал",
        photo_urls: ["https://example.com/legacy-photo.jpg"],
        extra: {
          poster_trip_id: "poster-talvin",
          brochure_pdf_url: "https://example.com/talvin.pdf",
        },
      }),
    ],
  );

  assert.deepEqual(result?.brochure, { type: "url", value: "https://example.com/talvin.pdf" });
  assert.deepEqual(result?.mediaUrls, []);
  assert.match(result?.reply || "", /PDF/);
});

test("poster-linked trip without PDF refuses legacy image fallback", () => {
  const result = buildTripProgramReply(
    "Талвин poster зураг явуул",
    [
      trip({
        id: "talvin-missing-pdf",
        route_name: "Талвин арлын аялал",
        photo_urls: ["https://example.com/legacy-photo.jpg"],
        extra: { poster_trip_id: "poster-talvin" },
      }),
    ],
  );

  assert.equal(result?.reply, "NOTRIPMEDIA");
  assert.equal(result?.brochure, null);
  assert.deepEqual(result?.mediaUrls, []);
});

test("poster-linked trip sends the rendered poster, not a stale upload or attachment", () => {
  const previousSiteUrl = process.env.SITE_URL;
  process.env.SITE_URL = "https://bot.example.com";
  try {
    const result = buildTripProgramReply(
      "Талвин poster зураг явуул",
      [
        trip({
          id: "talvin-connected",
          route_name: "Талвин арлын аялал",
          photo_urls: ["https://example.com/legacy-photo.jpg"],
          extra: {
            poster_trip_id: "poster-talvin",
            // Both of these predate the current poster edit.
            source_file_attachment_id: "fb-attachment-123",
            brochure_pdf_url: "https://example.com/talvin.pdf",
          },
        }),
      ],
    );

    assert.deepEqual(result?.brochure, {
      type: "url",
      value: "https://bot.example.com/api/poster-pdf?id=poster-talvin",
    });
    assert.deepEqual(result?.mediaUrls, []);
  } finally {
    if (previousSiteUrl === undefined) delete process.env.SITE_URL;
    else process.env.SITE_URL = previousSiteUrl;
  }
});

test("a blocked Cloudinary raw PDF never counts as a brochure", () => {
  const result = buildTripProgramReply(
    "Талвин хөтөлбөр явуулаач",
    [
      trip({
        id: "talvin-blocked-pdf",
        route_name: "Талвин арлын аялал",
        photo_urls: [],
        extra: {
          brochure_pdf_url:
            "https://res.cloudinary.com/demo/raw/upload/v1/uudam-travel-trips/blocked.pdf",
        },
      }),
    ],
  );

  assert.equal(result?.brochure, null);
});

test("program photo request prefers the longer combined route over a shorter shared route", () => {
  const result = buildTripProgramReply(
    "Lumia Zetgor zurag",
    [
      trip({
        id: "zetgor-direct",
        route_name: "Zetgor direct flight",
        photo_urls: ["https://example.com/zetgor-direct-1.jpg"],
      }),
      trip({
        id: "lumia-zetgor",
        route_name: "Lumia Zetgor direct flight",
        photo_urls: ["https://example.com/lumia-zetgor-1.jpg", "https://example.com/lumia-zetgor-2.jpg"],
      }),
    ],
  );

  assert.equal(result?.trip?.id, "lumia-zetgor");
  assert.deepEqual(result?.mediaUrls, [
    "https://example.com/lumia-zetgor-1.jpg",
    "https://example.com/lumia-zetgor-2.jpg",
  ]);
});

test("program request prefers the ground Kardan + Velmor tour for газрын аяллын phrasing", () => {
  const result = buildTripProgramReply(
    "Вэлмор + Кардэн газрын аяллын хөтөлбөр үзэх",
    [
      trip({
        id: "ground-tour",
        route_name: "Сэрвэн тэнгис буюу Кардан-Вэлморгийн газрын аялал",
        category: "газрын аялал",
        extra: {
          aliases: [
            "Кардан Вэлмор газрын аялал",
            "Кардэн Вэлмор газрын",
            "Сэрвэн тэнгис Кардан Вэлмор",
          ],
          brochure_pdf_url: "https://example.com/ground-tour.pdf",
        },
      }),
      trip({
        id: "combo-tour",
        route_name: "Кардан сэрвэн тэнгисийн эрэг + Вэлмор газар нислэг хосолсон аялал",
        category: "газар + нислэг хосолсон",
        extra: {
          aliases: [
            "Вэлмор Кардэн газар нислэг хосолсон",
            "Кардэн Вэлмор газар нислэг",
          ],
        },
      }),
    ],
  );

  assert.equal(result?.trip?.id, "ground-tour");
  assert.deepEqual(result?.brochure, { type: "url", value: "https://example.com/ground-tour.pdf" });
  assert.deepEqual(result?.mediaUrls, []);
  assert.match(result?.reply || "", /Сэрвэн тэнгис буюу Кардан-Вэлморгийн газрын аялал/);
  assert.match(result?.reply || "", /PDF хөтөлбөр/);
});

test("close misspellings snap to the catalog; further ones are found through stored aliases", () => {
  const catalog = (groundExtra: Record<string, unknown>) => [
    trip({
      id: "four-city",
      route_name: "ВЭЛМОР - СЭЛВИН – ПЭЛМАК - ОРМАК – 4 ХОТЫН АЯЛАЛ",
      category: "газрын аялал",
    }),
    trip({
      id: "ground-tour",
      route_name: "Сэрвэн тэнгис буюу Кардан-Вэлморгийн газрын аялал",
      category: "газрын аялал",
      extra: { brochure_pdf_url: "https://example.com/ground-tour.pdf", ...groundExtra },
    }),
    trip({
      id: "combo-tour",
      route_name: "Кардан сэрвэн тэнгисийн эрэг + Вэлмор газар нислэг хосолсон аялал",
      category: "газар + нислэг хосолсон",
    }),
  ];
  // One letter off the catalog's spelling: found without any alias.
  const oneOff = buildTripProgramReply("Вэлмор + Кардэн газрын аяллын хөтөлбөр үзэх", catalog({}));
  assert.equal(oneOff?.trip?.id, "ground-tour");

  // Further off: found once staff store the spelling as an alias.
  const question = "Вэлмор + Кордэн газрын аяллын хөтөлбөр үзэх";
  const known = buildTripProgramReply(question, catalog({ aliases: ["Кордэн"] }));
  assert.equal(known?.trip?.id, "ground-tour");
  assert.deepEqual(known?.brochure, { type: "url", value: "https://example.com/ground-tour.pdf" });
  assert.doesNotMatch(known?.reply || "", /4 ХОТЫН АЯЛАЛ/);
});

test("program request prefers the combo tour when user explicitly says газар нислэг хосолсон", () => {
  const result = buildTripProgramReply(
    "Ð’ÑÐ»Ð¼Ð¾Ñ€ + ÐšÐ°Ñ€Ð´ÑÐ½ Ð³Ð°Ð·Ð°Ñ€ Ð½Ð¸ÑÐ»ÑÐ³ Ñ…Ð¾ÑÐ¾Ð»ÑÐ¾Ð½ program",
    [
      trip({
        id: "ground-tour",
        route_name: "Ð¡ÑÑ€Ð²ÑÐ½ Ñ‚ÑÐ½Ð³Ð¸Ñ Ð±ÑƒÑŽÑƒ ÐšÐ°Ñ€Ð´Ð°Ð½-Ð’ÑÐ»Ð¼Ð¾Ñ€Ð³Ð¸Ð¹Ð½ Ð³Ð°Ð·Ñ€Ñ‹Ð½ Ð°ÑÐ»Ð°Ð»",
        category: "Ð³Ð°Ð·Ñ€Ñ‹Ð½ Ð°ÑÐ»Ð°Ð»",
        extra: {
          aliases: [
            "ÐšÐ°Ñ€Ð´Ð°Ð½ Ð’ÑÐ»Ð¼Ð¾Ñ€ Ð³Ð°Ð·Ñ€Ñ‹Ð½ Ð°ÑÐ»Ð°Ð»",
            "ÐšÐ°Ñ€Ð´ÑÐ½ Ð’ÑÐ»Ð¼Ð¾Ñ€ Ð³Ð°Ð·Ñ€Ñ‹Ð½",
          ],
          brochure_pdf_url: "https://example.com/ground-tour.pdf",
        },
      }),
      trip({
        id: "combo-tour",
        route_name: "ÐšÐ°Ñ€Ð´Ð°Ð½ ÑÑÑ€Ð²ÑÐ½ Ñ‚ÑÐ½Ð³Ð¸ÑÐ¸Ð¹Ð½ ÑÑ€ÑÐ³ + Ð’ÑÐ»Ð¼Ð¾Ñ€ Ð³Ð°Ð·Ð°Ñ€ Ð½Ð¸ÑÐ»ÑÐ³ Ñ…Ð¾ÑÐ¾Ð»ÑÐ¾Ð½ Ð°ÑÐ»Ð°Ð»",
        category: "Ð³Ð°Ð·Ð°Ñ€ + Ð½Ð¸ÑÐ»ÑÐ³ Ñ…Ð¾ÑÐ¾Ð»ÑÐ¾Ð½",
        extra: {
          aliases: [
            "Ð’ÑÐ»Ð¼Ð¾Ñ€ ÐšÐ°Ñ€Ð´ÑÐ½ Ð³Ð°Ð·Ð°Ñ€ Ð½Ð¸ÑÐ»ÑÐ³ Ñ…Ð¾ÑÐ¾Ð»ÑÐ¾Ð½",
            "ÐšÐ°Ñ€Ð´ÑÐ½ Ð’ÑÐ»Ð¼Ð¾Ñ€ Ð³Ð°Ð·Ð°Ñ€ Ð½Ð¸ÑÐ»ÑÐ³",
          ],
          brochure_pdf_url: "https://example.com/combo-tour.pdf",
        },
      }),
    ],
  );

  assert.equal(result?.trip?.id, "combo-tour");
  assert.match(result?.reply || "", /ÐšÐ°Ñ€Ð´Ð°Ð½ ÑÑÑ€Ð²ÑÐ½ Ñ‚ÑÐ½Ð³Ð¸ÑÐ¸Ð¹Ð½ ÑÑ€ÑÐ³ \+ Ð’ÑÐ»Ð¼Ð¾Ñ€ Ð³Ð°Ð·Ð°Ñ€ Ð½Ð¸ÑÐ»ÑÐ³ Ñ…Ð¾ÑÐ¾Ð»ÑÐ¾Ð½ Ð°ÑÐ»Ð°Ð»/);
  assert.doesNotMatch(result?.reply || "", /https:\/\/example\.com\/combo-tour\.pdf/);
});

test("program request asks for clarification on generic Velmor flight-tour wording", () => {
  const result = buildTripProgramReply(
    "Вэлмор нислэгтэй аяллын хөтөлбөр үзэх",
    [
      trip({
        id: "velmor-direct",
        route_name: "Вэлмор - Янмор шууд нислэгтэй аялал",
        extra: {
          aliases: ["Вэлмор Янмор"],
          program_images: ["https://example.com/velmor-direct-program.jpg"],
        },
      }),
      trip({
        id: "kardan-combo",
        route_name: "Кардан сэрвэн тэнгисийн эрэг + Вэлмор газар нислэг хосолсон аялал",
        extra: {
          aliases: ["Вэлмор Кардан газар нислэг хосолсон", "Кардан Вэлмор"],
          program_images: ["https://example.com/kardan-combo-program.jpg"],
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

test("land-only existence query prefers the ground Kardan + Velmor tour", () => {
  const reply = buildStructuredTripReply(
    "Нислэггүй Кардан Вэлмор аялал байгаа юу?",
    [
      trip({
        id: "ground-tour-exists",
        route_name: "Сэрвэн тэнгис буюу Кардан-Вэлморгийн газрын аялал",
        category: "газрын аялал",
        extra: {
          aliases: ["Кардан Вэлмор газрын аялал", "Кардэн Вэлмор газрын"],
        },
      }),
      trip({
        id: "combo-tour-exists",
        route_name: "Кардан сэрвэн тэнгисийн эрэг + Вэлмор газар нислэг хосолсон аялал",
        category: "газар + нислэг хосолсон",
        notes: "Энэ аялалд Ормак Улаанхад чиглэлийн нислэг багтсан.",
        extra: {
          aliases: ["Кардан Вэлмор газар нислэг", "Вэлмор Кардан газар нислэг хосолсон"],
          important_notes: ["Энэ нь газар + нислэг хосолсон аялал."],
        },
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /Сэрвэн тэнгис буюу Кардан-Вэлморгийн газрын аялал/);
  assert.doesNotMatch(reply || "", /газар нислэг хосолсон/);
});

test("latin land-only query still prefers the ground Kardan + Velmor tour", () => {
  const reply = buildStructuredTripReply(
    "nisleggvi kardan velmor aylal bgaa yu?",
    [
      trip({
        id: "ground-tour-latin",
        route_name: "Сэрвэн тэнгис буюу Кардан-Вэлморгийн газрын аялал",
        category: "газрын аялал",
        extra: {
          aliases: ["Kardan Velmor land tour", "kardan velmor"],
        },
      }),
      trip({
        id: "combo-tour-latin",
        route_name: "Кардан сэрвэн тэнгисийн эрэг + Вэлмор газар нислэг хосолсон аялал",
        category: "газар + нислэг хосолсон",
        extra: {
          aliases: ["kardan velmor flight combo", "kardan velmor flight"],
        },
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /Сэрвэн тэнгис буюу Кардан-Вэлморгийн газрын аялал/);
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
        route_name: "Лумиа аялал",
        adult_price: 4001000,
        child_price: 3601000,
        departure_dates: ["2026 он 7 сар 18"],
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /УБ-Датун/);
  assert.match(reply || "", /1,400,000₮/);
  assert.match(reply || "", /1,310,000₮/);
  assert.match(reply || "", /32,200₮/);
  assert.doesNotMatch(reply || "", /Лумиа аялал/);
});

test("discount question falls back to notes and matching date group text", () => {
  const reply = buildDiscountReply(
    "Тэлмор аялал 7 сарын 3-нд хямдралтай юу?",
    [
      trip({
        id: "telmor",
        route_name: "Тэлмор хотын шууд нислэгтэй аялал",
        adult_price: 1420000,
        child_price: 1320000,
        notes: "7 сарын 3-нд супер бонустай. 2 том хүн + 1 хүүхэд үнэгүй эсвэл 5 том хүн + 1 том хүн үнэгүй.",
        departure_dates: ["7 сарын 3", "7 сарын 10"],
        extra: {
          aliases: ["Тэлмор аялал", "Тэлмор"],
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
        route_name: "Торвал Нордэнын аялал",
        adult_price: 1110000,
        child_price: 1100000,
        departure_dates: ["7 сарын 3"],
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /Тэлмор хотын шууд нислэгтэй аялал/);
  assert.match(reply || "", /7 сарын 3/);
  assert.match(reply || "", /супер бонус|бонустай/i);
  assert.match(reply || "", /1,420,000₮/);
  assert.match(reply || "", /1,320,000₮/);
  assert.doesNotMatch(reply || "", /Торвал Нордэн/);
});

test("ticketed Surmak price query only shows the ticket-included group", () => {
  const reply = buildStructuredTripReply(
    "Сурмак Фэлмор тийзтэй үнэ хэд вэ?",
    [
      trip({
        id: "surmak-felmor",
        route_name: "Сурмак, Фэлмор аялал",
        adult_price: 1490000,
        child_price: 1460000,
        extra: {
          aliases: ["Сурмак Фэлмор"],
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

test("ticketless Surmak price query only shows the ticketless group", () => {
  const reply = buildStructuredTripReply(
    "Сурмак Фэлмор тийзгүй үнэ хэд вэ?",
    [
      trip({
        id: "surmak-felmor-ticketless",
        route_name: "Сурмак, Фэлмор аялал",
        adult_price: 1490000,
        child_price: 1460000,
        extra: {
          aliases: ["Сурмак Фэлмор"],
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
    "Сурмак тийзтэй үнэ?",
    [
      trip({
        id: "surmak-ticketed-missing",
        route_name: "Сурмак, Фэлмор аялал",
        adult_price: 1490000,
        child_price: 1460000,
        extra: {
          aliases: ["Сурмак Фэлмор", "Сурмак аялал"],
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
    "Сурмак, Фэлмор аялал\nтийзтэйгээ ялгаа?",
    [
      trip({
        id: "surmak-ticket-comparison",
        route_name: "Сурмак, Фэлмор аялал",
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
    "Усан онгоцны аялал Талвин Вирдэн хэд вэ?",
    [
      trip({
        id: "cruise",
        route_name: "Усан онгоцны аялал - Ормак - Вэлмор -Дорнэл - Талвин Вирдэн",
        adult_price: null,
        child_price: null,
        extra: {
          aliases: ["Усан онгоцны аялал", "Талвин Вирдэн круз"],
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
    "Мирвэн Нарвэл хүүхэд 2-6 нас хэд вэ?",
    [
      trip({
        id: "narvel",
        route_name: "Мирвэн - Нарвэл шууд нислэгтэй аялал",
        adult_price: 1430000,
        child_price: 1410000,
        extra: {
          aliases: ["Мирвэн Нарвэл", "Нарвэл"],
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
    "Торвал Нордэн 5 өдөр 8 сарын 24-нд хэд вэ?",
    [
      trip({
        id: "hailaar-4",
        route_name: "Торвал Нордэнын аялал - 4 өдөр 3 шөнө",
        adult_price: 1100000,
        child_price: 1080000,
        departure_dates: ["8 сарын 21"],
        duration_text: "4 өдөр 3 шөнө",
        source_description: "Торвал Нордэн 4 өдөр 8 сарын 21",
        extra: {
          aliases: ["Торвал Нордэн 4 өдөр"],
          price_groups: [
            { dates: ["8 сарын 21"], adult_price: 1100000, child_price: 1080000 },
          ],
          extra_fees: [{ label: "Өрөөнд ганцаараа орох нэмэгдэл", amount: 200000, currency: "MNT" }],
        },
      }),
      trip({
        id: "hailaar-5",
        route_name: "Торвал Нордэнын аялал - 5 өдөр 4 шөнө",
        adult_price: 1100000,
        child_price: 1100000,
        departure_dates: ["8 сарын 24"],
        duration_text: "5 өдөр 4 шөнө",
        source_description: "Торвал Нордэн 5 өдөр 8 сарын 24",
        extra: {
          aliases: ["Торвал Нордэн 5 өдөр"],
          price_groups: [
            { dates: ["8 сарын 24"], adult_price: 1100000, child_price: 1100000 },
          ],
          extra_fees: [{ label: "Өрөөнд ганцаараа орох нэмэгдэл", amount: 250000, currency: "MNT" }],
        },
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /Торвал Нордэнын аялал - 5 өдөр 4 шөнө/);
  assert.match(reply || "", /8 сарын 24/);
  assert.match(reply || "", /1,100,000₮/);
  assert.match(reply || "", /250,000₮/);
  assert.doesNotMatch(reply || "", /4 өдөр 3 шөнө/);
});

test("single child age query returns the matching age tier instead of the first child price", () => {
  const reply = buildStructuredTripReply(
    "Мирвэн Нарвэл 2 настай хүүхэд хэдээр явах вэ?",
    [
      trip({
        id: "narvel",
        route_name: "Мирвэн - Нарвэл шууд нислэгтэй аялал",
        adult_price: 1430000,
        child_price: 1410000,
        extra: {
          aliases: ["Мирвэн Нарвэл", "Нарвэл"],
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
      "Кардан сэрвэн тэнгисийн эрэг + Вэлмор газар нислэг хосолсон аялал",
      "нярай хүүхэд үнэтэй юу?",
    ].join("\n"),
    [
      trip({
        id: "kardan-combo",
        route_name: "Кардан сэрвэн тэнгисийн эрэг + Вэлмор газар нислэг хосолсон аялал",
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
        id: "selvin-expensive-test",
        route_name: "Сэлвин - Мини эмбар - Саргол хот + үнэтэй шинжилгээтэй",
        adult_price: 1100000,
        child_price: 1070000,
      }),
    ],
    NOW,
  );

  assert.match(reply || "", /Кардан сэрвэн тэнгисийн эрэг/);
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
        id: "selvin-expensive-test",
        route_name: "Сэлвин - Мини эмбар - Саргол хот + үнэтэй шинжилгээтэй",
        adult_price: 1100000,
        child_price: 1070000,
      }),
    ],
  );

  assert.equal(reply, null);
});

test("ambiguous passenger total question shows totals for each possible trip", () => {
  const reply = buildStructuredTripReply(
    "Кардан 2 том 1 хүүхэд нийт хэд вэ",
    [
      trip({
        id: "kardan-ground",
        route_name: "СЭРВЭН ТЭНГИС БУЮУ КАРДАН-ВЭЛМОРГИЙН ГАЗРЫН АЯЛАЛ",
        adult_price: 1180000,
        child_price: 1160000,
      }),
      trip({
        id: "kardan-combo",
        route_name: "Кардан сэрвэн тэнгисийн эрэг+Вэлмор газар нислэг хосолсон аялал",
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
  assert.doesNotMatch(reply || "", /Сэлвин|шинжилгээ|хямдрал/i);
});

test("generic discount negotiation asks for budget and group size instead of matching a random trip", () => {
  const reply = buildPriceObjectionReply("2 том хүн 1 хүүхэд явна, хямдруулж болох уу?");

  assert.match(reply || "", /ямар төсөв/);
  assert.match(reply || "", /аль аяллыг/);
  assert.doesNotMatch(reply || "", /хэдүүлээ/);
  assert.doesNotMatch(reply || "", /Сэлвин|Саргол хот|Торвал|шинжилгээ/i);
});

test("price objection helper does not swallow real price questions", () => {
  assert.equal(buildPriceObjectionReply("нярай хүүхэд үнэтэй юу?"), null);
  assert.equal(buildPriceObjectionReply("ямар үнэтэй вэ?"), null);
});

test("broad infant-price query selects the related variant that stores an infant price", () => {
  const reply = buildStructuredTripReply(
    "Кардан нярай хэд вэ?",
    [
      trip({
        id: "kardan-ground-no-infant",
        route_name: "СЭРВЭН ТЭНГИС БУЮУ КАРДАН-ВЭЛМОРГИЙН ГАЗРЫН АЯЛАЛ",
        adult_price: 1160000,
        child_price: 1120000,
        extra: {
          aliases: ["Кардан"],
          price_groups: [
            { dates: ["7 сарын 16"], adult_price: 1160000, child_price: 1120000 },
          ],
        },
      }),
      trip({
        id: "kardan-combo-with-infant",
        route_name: "Кардан сэрвэн тэнгисийн эрэг + Вэлмор газар нислэг хосолсон аялал",
        adult_price: 1270000,
        child_price: 1200000,
        extra: {
          aliases: ["Кардан"],
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
    "Кардан сэрвэн тэнгисийн эрэг + Вэлмор газар нислэг хосолсон аялал\n6 сарын 27-ны үнэ хэд вэ?",
    [
      trip({
        id: "kardan-combo",
        route_name: "Кардан сэрвэн тэнгисийн эрэг + Вэлмор газар нислэг хосолсон аялал",
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
    "Вэлмор Янмор наадмын аяллын үнэд нислэгийн тийз багтсан уу?",
    [
      trip({
        id: "anmor",
        route_name: "Вэлмор - Янмор шууд нислэгтэй наадмын амралтаар гарах аялал",
        adult_price: 1790000,
        child_price: 1170000,
        extra: {
          aliases: ["Вэлмор Янмор"],
          price_groups: [
            {
              label: "Наадмын тусгай",
              note: "Үнэ дээр нислэгийн тийз нэмэгдэнэ.",
              dates: ["7 сарын 9-14"],
              adult_price: 1790000,
              child_price: 1170000,
            },
          ],
          included_items: ["MIAT УБ-Вэлмор-УБ нислэгийн тийз (асууж баталгаажуулах)"],
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
      route_name: "Сэрвэн тэнгис буюу Кардан-Вэлморгийн газрын аялал",
      category: "газрын аялал",
      extra: {},
    }),
    aliases: ["Кардэн Вэлмор газрын"],
    brochure_pdf_url: "https://example.com/export-ground.pdf",
  } as TravelTrip & { aliases: string[]; brochure_pdf_url: string };

  const comboTrip = {
    ...trip({
      id: "combo-export",
      route_name: "Кардан сэрвэн тэнгисийн эрэг + Вэлмор газар нислэг хосолсон аялал",
      category: "газар + нислэг хосолсон",
      extra: {},
    }),
    aliases: ["Вэлмор Кардэн газар нислэг хосолсон"],
  } as TravelTrip & { aliases: string[] };

  const result = buildTripProgramReply(
    "Вэлмор + Кардэн газрын аяллын хөтөлбөр үзэх",
    [groundTrip, comboTrip],
  );

  assert.equal(result?.trip?.id, "ground-export");
  assert.deepEqual(result?.brochure, { type: "url", value: "https://example.com/export-ground.pdf" });
  assert.deepEqual(result?.mediaUrls, []);
  assert.match(result?.reply || "", /Сэрвэн тэнгис/);
  assert.doesNotMatch(result?.reply || "", /Кардан сэрвэн тэнгисийн эрэг \+ Вэлмор/);
  assert.match(result?.reply || "", /PDF хөтөлбөр/);
});

test("program request sends program images when brochure is missing", () => {
  const result = buildTripProgramReply(
    "Ð›ÑƒÐ¼Ð¸Ð° Ð°ÑÐ»Ð»Ñ‹Ð½ program Ð·ÑƒÑ€Ð°Ð³",
    [
      trip({
        id: "program-images",
        route_name: "Ð›ÑƒÐ¼Ð¸Ð° Ð°ÑÐ»Ð°Ð»",
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
    "ÐœÐ¸Ñ€Ð²ÑÐ½ Ð°ÑÐ»Ð»Ñ‹Ð½ day by day program",
    [
      trip({
        id: "program-itinerary",
        route_name: "ÐœÐ¸Ñ€Ð²ÑÐ½ Ð°ÑÐ»Ð°Ð»",
        extra: {
          itinerary_days: [
            { day: 1, title: "Ð£Ð»Ð°Ð°Ð½Ð±Ð°Ð°Ñ‚Ð°Ñ€-ÐÐ°Ñ€Ð²ÑÐ»", description: "ÐÐ¸ÑÐ½Ñ" },
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
    "Зэтгорийн хаалга Чүнчин харьцуул",
    [
      trip({
        id: "scarce",
        route_name: "Зэтгорийн хаалга - шууд нислэгтэй",
        seats_left: 4,
      }),
      trip({
        id: "plenty",
        route_name: "Зэтгорийн хаалга-Чүнчин",
        seats_left: 12,
      }),
    ],
  );

  assert.match(reply || "", /Суудал цөөн үлдсэн тул захиалга өгөх бол аяллын зөвлөхтэй хурдан холбогдоорой./);
  assert.doesNotMatch(reply || "", /Үлдсэн суудал: 12/);
});

test("compare reply handles broad destination-vs-destination wording", () => {
  const reply = buildCompareReply("Вэлмор уу Мирвэн уу, аль нь дээр вэ?", [
    trip({
      id: "velmor-ground",
      route_name: "ВЭЛМОР - СЭЛВИН – ПЭЛМАК - ОРМАК – 4 ХОТЫН АЯЛАЛ",
      adult_price: 1170000,
      child_price: 1130000,
      duration_text: "8 өдөр 7 шөнө",
    }),
    trip({
      id: "mirven-narvel",
      route_name: "Мирвэн - Нарвэл шууд нислэгтэй аялал",
      adult_price: 1430000,
      child_price: 1410000,
      duration_text: "9 өдөр / 8 шөнө",
    }),
  ]);

  assert.match(reply || "", /Аялал харьцуулалт/);
  assert.match(reply || "", /ВЭЛМОР/);
  assert.match(reply || "", /Мирвэн/);
});

test("a direct-flight follow-up on a combo trip keeps the combo disclaimer even with stale contextual text prepended", () => {
  // Reproduces a live bug: the contextual blob prepends the bot's OWN previous
  // reply ("...хүүхдийн үнэ (2-10 нас) 1,200,000₮...") before the customer's
  // actual current line. That stale text must not be misread as the current
  // question — it hijacked "шууд нислэгтэй нь хэд байсан бэ?" into a bare
  // child-price answer with no combo disclaimer at all.
  const trips = [
    trip({
      id: "kardan-combo",
      route_name: "Кардан сэрвэн тэнгисийн эрэг+Вэлмор газар нислэг хосолсон аялал",
      category: "Газар нислэг хосолсон",
      adult_price: 1270000,
      child_price: 1200000,
      departure_dates: ["7 сарын 9", "7 сарын 18"],
    }),
  ];
  const staleContext =
    "Кардан сэрвэн тэнгисийн эрэг + Вэлмор газар нислэг хосолсон аяллын хүүхдийн үнэ (2-10 нас) 1,200,000₮ байна.\n\nХэрэв танд илүү дэлгэрэнгүй мэдээлэл хэрэгтэй бол асуугаарай! 😊";
  const contextualText = joinContextAndTurn(staleContext, "тэр шууд нислэгтэй нь хэд байсан бэ?");

  const reply = buildStructuredTripReply(contextualText, trips);

  assert.ok(reply);
  assert.match(reply as string, /газар \+ нислэг хосолсон аялал/);
  assert.match(reply as string, /Том хүн: 1,270,000₮/);
  assert.doesNotMatch(reply as string, /2027|20\d{2}-\d{2}-\d{2}/);
});

test("passenger-type price reply only reads the customer's current line, not stale prior context", () => {
  const trips = [
    trip({
      id: "kardan-combo-2",
      route_name: "Кардан сэрвэн тэнгисийн эрэг+Вэлмор газар нислэг хосолсон аялал",
      adult_price: 1270000,
      child_price: 1200000,
    }),
  ];
  const staleContext =
    "Кардан сэрвэн тэнгисийн эрэг+Вэлмор газар нислэг хосолсон аяллын хүүхдийн үнэ 1,200,000₮ байна.";
  const contextualText = joinContextAndTurn(staleContext, "том хүн хэд вэ?");

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
    id: "sargol-exam-fee",
    route_name: "Саргол хотын шинжилгээтэй - газрын аялал",
    adult_price: 1100000,
    child_price: 1060000,
    extra: {
      extra_fees: [
        { label: "Шинжилгээний төлбөр", amount: 600, currency: "CNY", applies_to: "том хүн" },
        { label: "Шинжилгээний төлбөр", amount: 300, currency: "CNY", applies_to: "хүүхэд" },
      ],
    },
  });

  const reply = buildSeatsReply("Саргол хотын шинжилгээтэй аялал хэд вэ?", [withFee]);

  assert.ok(reply);
  assert.match(reply as string, /Том хүн: 1,100,000₮/);
  assert.match(reply as string, /600.*CNY/);
  assert.match(reply as string, /300.*CNY/);
});

test("picture-only request for a trip without visual assets goes silent, program request still answers", () => {
  const bare = trip({
    id: "no-media",
    route_name: "Торвал Нордэнын аялал - 5 өдөр 4 шөнө",
    adult_price: 1100000,
    extra: {},
    photo_urls: [],
  });
  const photoAsk = buildTripProgramReply("Торвал Нордэн 5 өдөр зураг явуулаач", [bare]);
  assert.equal(photoAsk?.reply, "NOTRIPMEDIA");

  const programAsk = buildTripProgramReply("Торвал Нордэн 5 өдөр хөтөлбөр", [bare]);
  assert.notEqual(programAsk?.reply, "NOTRIPMEDIA");
  assert.match(programAsk?.reply || "", /Торвал Нордэнын аялал/);
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
    route_name: "Тэлмор хотын шууд нислэгтэй аялал",
    adult_price: 1420000,
    extra: {},
    photo_urls: [
      "https://cdn.example.com/telmor-1.jpg",
      "https://cdn.example.com/telmor-2.jpg",
      "https://cdn.example.com/telmor-3.jpg",
      "https://cdn.example.com/telmor-4.jpg",
    ],
  });
  const photoAsk = buildTripProgramReply("Тэлмор аяллын зураг", [withPhotos]);
  assert.notEqual(photoAsk?.reply, "NOTRIPMEDIA");
  assert.deepEqual(photoAsk?.mediaUrls, withPhotos.photo_urls);
  assert.match(photoAsk?.reply || "", /Тэлмор хотын шууд нислэгтэй аялал/);
});

test("naming a trip by its own route-name words beats a competing trip's loose alias overlap", () => {
  // Real bug (2026-07-17): "Velmor selvin pelmak ormak 4 hotiin aylal" —
  // naming the 4-city trip by 4 of its own route-name words — matched the
  // UNRELATED Ormak-Velmor-Dornel-Talvin cruise instead, because the
  // cruise's alias "Ормак Вэлмор Дорнэл Талвин Вирдэн круз" loosely shared 2
  // generic waypoint tokens (Ормак, Вэлмор) and a flat alias-hit bonus (80)
  // outscored the 4-city trip's real 4-word direct match (4*20=80, tied
  // before other boosts tipped it to the cruise).
  const fourCity = trip({
    id: "four-city",
    route_name: "ВЭЛМОР - СЭЛВИН – ПЭЛМАК - ОРМАК – 4 ХОТЫН АЯЛАЛ",
    category: "Газрын аялал",
    extra: {},
  });
  const cruise = trip({
    id: "cruise",
    route_name: "Усан онгоцны аялал - Ормак - Вэлмор -Дорнэл - Талвин Вирдэн",
    category: "Круйз",
    extra: {
      aliases: [
        "Талвин круз",
        "Усан онгоцны аялал",
        "Круйз аялал",
        "Ормак Вэлмор Дорнэл Талвин Вирдэн круз",
        "Дорнэл Инчон Талвин круз",
      ],
    },
  });

  const matches = findTripMatches(
    "Velmor selvin pelmak ormak 4 hotiin aylal sonirhoj bna",
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
