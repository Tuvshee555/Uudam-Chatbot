import fs from "node:fs";
import path from "node:path";
import {
  buildCompareReply,
  buildDiscountReply,
  buildSeatsReply,
  buildStructuredTripReply,
  buildTripProgramReply,
  hasCompareIntent,
  hasDiscountIntent,
  hasSeatsIntent,
} from "../src/lib/travelFastPaths";
import type { TravelTrip } from "../src/lib/travelTypes";

type RawTrip = Record<string, unknown>;

type QaCase = {
  id: string;
  text: string;
  expect: Array<RegExp | string>;
  reject?: Array<RegExp | string>;
  media?: "none" | "brochure" | "photos";
  note: string;
};

const inputPath = process.argv[2] || path.join(process.env.USERPROFILE || "", "Downloads", "uudam-trips-2026-07-08.json");
const raw = JSON.parse(fs.readFileSync(inputPath, "utf8")) as unknown;
const rawTrips = Array.isArray(raw)
  ? raw as RawTrip[]
  : Array.isArray((raw as { trips?: unknown }).trips)
    ? (raw as { trips: RawTrip[] }).trips
    : [];

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
    : [];
}

function normalizeTrip(rawTrip: RawTrip): TravelTrip {
  const extra = {
    aliases: strings(rawTrip.aliases),
    price_groups: records(rawTrip.price_groups),
    discounts: records(rawTrip.discounts),
    child_rules: records(rawTrip.child_rules),
    extra_fees: records(rawTrip.extra_fees),
    departure_rule: typeof rawTrip.departure_rule === "string" ? rawTrip.departure_rule : "",
    included_items: strings(rawTrip.included_items),
    excluded_items: strings(rawTrip.excluded_items),
    room_prices: records(rawTrip.room_prices),
    important_notes: strings(rawTrip.important_notes),
    brochure_pdf_url: typeof rawTrip.brochure_pdf_url === "string" ? rawTrip.brochure_pdf_url : "",
    source_provenance: records(rawTrip.source_provenance),
    answer_hints: strings(rawTrip.answer_hints),
    needs_human_review: rawTrip.needs_human_review === true,
    review_reasons: strings(rawTrip.review_reasons),
    customer_visible: typeof rawTrip.customer_visible === "boolean" ? rawTrip.customer_visible : true,
  };

  return {
    id: typeof rawTrip.id === "string" ? rawTrip.id : `qa-${String(rawTrip.route_name || "").slice(0, 20)}`,
    category: typeof rawTrip.category === "string" ? rawTrip.category : "",
    operator_name: typeof rawTrip.operator_name === "string" ? rawTrip.operator_name : "UUDAM TRAVEL AGENCY",
    route_name: typeof rawTrip.route_name === "string" ? rawTrip.route_name : "",
    duration_text: typeof rawTrip.duration_text === "string" ? rawTrip.duration_text : "",
    adult_price: typeof rawTrip.adult_price === "number" ? rawTrip.adult_price : null,
    child_price: typeof rawTrip.child_price === "number" ? rawTrip.child_price : null,
    currency: typeof rawTrip.currency === "string" ? rawTrip.currency : "MNT",
    departure_dates: strings(rawTrip.departure_dates),
    seats_total: typeof rawTrip.seats_total === "number" ? rawTrip.seats_total : null,
    seats_left: typeof rawTrip.seats_left === "number" ? rawTrip.seats_left : null,
    has_food: typeof rawTrip.has_food === "boolean" ? rawTrip.has_food : null,
    status: ["active", "cancelled", "sold_out", "draft"].includes(String(rawTrip.status))
      ? rawTrip.status as TravelTrip["status"]
      : "active",
    notes: typeof rawTrip.notes === "string" ? rawTrip.notes : "",
    hotel: typeof rawTrip.hotel === "string" ? rawTrip.hotel : "",
    source_description: typeof rawTrip.source_description === "string" ? rawTrip.source_description : "",
    photo_urls: strings(rawTrip.photo_urls).filter((url) => url.startsWith("https://")),
    extra,
    created_at: "",
    updated_at: "",
  };
}

const trips = rawTrips.map(normalizeTrip).filter((trip) => trip.route_name);
const now = new Date("2026-07-09T00:00:00.000+08:00");

function answer(text: string): { reply: string | null; mediaUrls: string[]; brochure: string | null; source: string } {
  if (hasSeatsIntent(text)) {
    const reply = buildSeatsReply(text, trips);
    return { reply, mediaUrls: [], brochure: null, source: "seats" };
  }
  if (hasDiscountIntent(text)) {
    const reply = buildDiscountReply(text, trips, now);
    return { reply, mediaUrls: [], brochure: null, source: "discount" };
  }
  if (hasCompareIntent(text)) {
    const reply = buildCompareReply(text, trips);
    return { reply, mediaUrls: [], brochure: null, source: "compare" };
  }
  const program = buildTripProgramReply(text, trips);
  if (program) {
    const brochure = program.brochure?.type === "url" ? program.brochure.value : null;
    const mediaUrls = program.mediaUrls;
    return { reply: program.reply, mediaUrls, brochure, source: "program" };
  }
  const reply = buildStructuredTripReply(text, trips, now);
  return { reply, mediaUrls: [], brochure: null, source: "structured" };
}

const cases: QaCase[] = [
  { id: "ambiguous-tenger", text: "Тэнгэрийн хаалга хэд вэ?", expect: ["Аль аяллыг", "Тэнгэрийн хаалга - шууд нислэгтэй", "Тэнгэрийн хаалга — газар+нислэг", "Тэнгэрийн хаалга-Чунчин"], note: "Near-duplicate Tenger variants must clarify." },
  { id: "ambiguous-hailaar", text: "Хайлаар аялал хэд вэ?", expect: ["Аль аяллыг", "Хайлаар Манжуурын аялал - 4 өдөр 3 шөнө", "Хайлаар Манжуурын аялал - 5 өдөр 4 шөнө", "Хайлаар Чичихар"], note: "Hailaar has three plausible matches." },
  { id: "ambiguous-jinin", text: "Жинин аялал хэд вэ?", expect: ["Аль аяллыг", "Жинин"], reject: ["Шинжилгээний төлбөр"], note: "Broad Jinin should not pick one price." },
  { id: "draft-shanghai", text: "Шанхай Ханжоу хэд вэ?", expect: ["Шанхай+Ханжоу", "3,220,000₮", "3,160,000₮"], reject: ["ШАНХАЙ ХӨТӨЛБӨРТЭЙ", "3,690,000"], note: "Draft Shanghai trip must stay hidden." },
  { id: "tenger-direct", text: "Тэнгэрийн хаалга шууд нислэгтэй нь хэд вэ?", expect: ["Тэнгэрийн хаалга - шууд нислэгтэй", "2,990,000₮", "2,790,000₮"], reject: ["2,770,000₮", "газар+нислэг"], note: "Direct-flight Tenger and combo Tenger are different products." },
  { id: "tenger-combo", text: "Тэнгэрийн хаалга газар нислэг хосолсон нь хэд вэ?", expect: ["Тэнгэрийн хаалга — газар+нислэг", "2,770,000₮", "2,470,000₮"], reject: ["2,990,000₮"], note: "Combo Tenger should not inherit direct-flight price." },
  { id: "cruise-null-base", text: "Усан онгоцны аялал Чежү Пусан хэд вэ?", expect: ["Усан онгоцны аялал", "1,890,000₮", "710CNY"], reject: ["тодорхойгүй"], note: "Null top-level price must use price_groups and show mandatory fees." },
  { id: "exam-fee-total", text: "Хөх хотын шинжилгээтэй аялал нийт хэдэн төгрөг болох вэ?", expect: ["Хөх хотын шинжилгээтэй", "890,000₮", "700,000₮", "600CNY", "300CNY"], note: "Base MNT plus CNY exam fees must be visible." },
  { id: "sold-out-universal", text: "Бээжин Юниверсал шууд нислэгтэй наадмын аялал суудал байна уу?", expect: ["Юниверсал", "суудал дууссан"], reject: ["яг шууд нислэгтэй аялал одоогоор тодорхой олдсонгүй", "1,790,000₮"], note: "Sold-out exact match should be named as sold out." },
  { id: "ocr-zhangjiajie", text: "Шанхай Жанжиажэ аяллын үнэ хэд вэ?", expect: ["Шанхай + Тэнгэрийн хаалга", "3,590,000₮", "3,660,000₮", "800CNY"], note: "OCR/alias correction: Жанжиажэ maps to Shanghai + Tenger." },
  { id: "sanya-age-2", text: "Хайнан Саньяа 2 настай хүүхэд хэдээр явах вэ?", expect: ["Хайнан - Саньяа", "2-6 нас", "2,190,000₮"], reject: ["2,790,000₮", "490,000₮"], note: "Single child age must choose 2-6 tier." },
  { id: "sanya-age-7", text: "Хайнан Саньяа 7 настай хүүхэд хэд вэ?", expect: ["Хайнан - Саньяа", "6-12 нас", "2,790,000₮"], reject: ["2,190,000₮"], note: "Single age 7 should choose 6-12 tier." },
  { id: "tokyo-ticketed", text: "Токио Фүжи аяллын онгоцны тийзтэй үнэ хэд вэ?", expect: ["Токио, Фүжи", "Онгоцны тийзтэй үнэ", "5,600,000₮", "5,050,000₮", "211,000MNT"], reject: ["3,490,000₮", "Онгоцны тийзгүй үнэ"], note: "Ticketed Tokyo price group must be isolated." },
  { id: "tokyo-ticketless", text: "Токио Фүжи аяллын онгоцны тийзгүй үнэ хэд вэ?", expect: ["Токио, Фүжи", "Онгоцны тийзгүй үнэ", "3,490,000₮", "3,250,000₮", "211,000MNT"], reject: ["5,600,000₮", "Онгоцны тийзтэй үнэ"], note: "Ticketless Tokyo price group must be isolated." },
  { id: "dalian-discount", text: "Далянь аялал хямдралтай юу үндсэн үнэ хэд вэ?", expect: ["Далянь", "Үндсэн үнэ", "2,890,000₮", "2 том хүн + 1 хүүхэд үнэгүй"], note: "Discount answer should still show base price." },
  { id: "beidaihe-land", text: "Бэйдайхэ Бээжин нислэггүй газрын аялал байгаа юу?", expect: ["ШАР ТЭНГИС", "1,390,000₮", "1,190,000₮"], reject: ["газар нислэг хосолсон", "2,150,000₮"], note: "Land-only phrasing should exclude combo tour." },
  { id: "beidaihe-combo", text: "Бэйдайхэ Бээжин газар нислэг хосолсон аялал хэд вэ?", expect: ["Бэйдайхэ", "газар нислэг хосолсон", "2,150,000₮", "1,710,000₮"], reject: ["1,390,000₮"], note: "Combo phrasing should exclude land-only tour." },
  { id: "hailaar-5-late", text: "Хайлаар Манжуур 5 өдөр 8 сарын 24-нд хэд вэ?", expect: ["Хайлаар Манжуурын аялал - 5 өдөр 4 шөнө", "8 сарын 24", "990,000₮", "890,000₮", "250,000MNT"], reject: ["1,190,000₮"], note: "Date-specific late-August Hailaar 5-day price differs." },
  { id: "hailaar-4-late", text: "Хайлаар Манжуур 4 өдөр 8 сарын 21-нд хэд вэ?", expect: ["Хайлаар Манжуурын аялал - 4 өдөр 3 шөнө", "8 сарын 21", "890,000₮", "790,000₮", "200,000MNT"], reject: ["1,090,000₮"], note: "Date-specific late-August Hailaar 4-day price differs." },
  { id: "jeju-fee", text: "Жэжү арлын шууд нислэгтэй аялал хэд вэ нийт зардал?", expect: ["Жэжү арлын шууд нислэгтэй", "4,290,000₮", "4,090,000₮", "900,000MNT"], note: "Jeju extra single-room fee should be visible." },
  { id: "shanghai-program", text: "Шанхай Жанжиажэ аяллын хөтөлбөр байна уу?", expect: ["Шанхай + Тэнгэрийн хаалга"], media: "brochure", note: "Program request should return the right brochure." },
  { id: "hohhot-program", text: "Хөх хотын шинжилгээтэй аяллын PDF хөтөлбөр явуулаач", expect: ["Хөх хотын шинжилгээтэй"], media: "brochure", note: "Brochure URL should be selected for health-check trip." },
  { id: "sold-out-program", text: "Бээжин Юниверсал аяллын хөтөлбөр байна уу?", expect: ["Юниверсал", "суудал дууссан"], reject: ["PDF"], media: "none", note: "Sold-out trip should not send brochure as bookable program." },
  { id: "macau-alias", text: "Макао Жухай Хайлан арал хэд вэ?", expect: ["Макао - Жухай - Хайлин арал", "2,590,000₮", "2,190,000₮"], note: "Alias typo Хайлан should match Хайлин." },
  { id: "guangzhou-alias", text: "Гуанжоу Макао Шэнжин аяллын үнэ хэд вэ?", expect: ["Гуанжоу, Макао, Шэнжин", "2,590,000₮", "2,190,000₮"], note: "Multi-city route alias should match." },
  { id: "jinin-mini-free-vs-paid", text: "Жинин Мини аватар Хөх хот үнэгүй шинжилгээтэй нь хэд вэ?", expect: ["Жинин-Мини аватар-Хөх хотын аялал", "890,000₮", "750,000₮"], reject: ["үнэтэй шинжилгээтэй"], note: "Free/paid exam variants should not be confused." },
  { id: "jinin-mini-paid-vs-free", text: "Жинин Мини аватар Хөх хот үнэтэй шинжилгээтэй нь нийт хэд вэ?", expect: ["Жинин - Мини аватар - Хөх хот + үнэтэй шинжилгээтэй", "890,000₮", "750,000₮", "600CNY", "300CNY"], note: "Paid exam variant should surface CNY fees." },
];

function includes(reply: string, needle: RegExp | string): boolean {
  return typeof needle === "string" ? reply.includes(needle) : needle.test(reply);
}

const failures: Array<{ test: QaCase; reply: string | null; mediaUrls: string[]; brochure: string | null; source: string; reason: string }> = [];
const rows: Array<Record<string, unknown>> = [];

for (const test of cases) {
  const result = answer(test.text);
  const reply = result.reply || "";
  for (const expected of test.expect) {
    if (!includes(reply, expected)) {
      failures.push({ test, ...result, reason: `missing ${String(expected)}` });
      break;
    }
  }
  for (const rejected of test.reject || []) {
    if (includes(reply, rejected)) {
      failures.push({ test, ...result, reason: `unexpected ${String(rejected)}` });
      break;
    }
  }
  if (test.media === "none" && (result.mediaUrls.length > 0 || result.brochure)) {
    failures.push({ test, ...result, reason: "unexpected media" });
  }
  if (test.media === "brochure" && !result.brochure) {
    failures.push({ test, ...result, reason: "missing brochure" });
  }
  if (test.media === "photos" && result.mediaUrls.length === 0) {
    failures.push({ test, ...result, reason: "missing photos" });
  }
  rows.push({
    id: test.id,
    source: result.source,
    media: result.brochure ? "brochure" : result.mediaUrls.length ? `${result.mediaUrls.length} photos` : "none",
    ok: !failures.some((failure) => failure.test.id === test.id),
    reply: reply.replace(/\n/g, " ").slice(0, 220),
    note: test.note,
  });
}

console.table(rows.map(({ id, source, media, ok }) => ({ id, source, media, ok })));

if (failures.length > 0) {
  console.error(`\nFAILURES (${failures.length})`);
  for (const failure of failures) {
    console.error(`\n[${failure.test.id}] ${failure.reason}`);
    console.error(`Q: ${failure.test.text}`);
    console.error(`source=${failure.source} brochure=${failure.brochure || ""} media=${failure.mediaUrls.join(",")}`);
    console.error(failure.reply || "(null reply)");
  }
  process.exit(1);
}

console.log(`\nAll ${cases.length} hard QA cases passed against ${trips.length} trips from ${inputPath}.`);
console.log(`Trips with photo_urls in this export: ${trips.filter((trip) => trip.photo_urls.length > 0).length}.`);
