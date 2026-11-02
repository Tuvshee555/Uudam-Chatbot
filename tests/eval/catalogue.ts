/**
 * Invented catalogue for the chatbot evaluation (scripts/chatbot-eval.ts). Every name, place,
 * price, date, phone number and address here is made up; none is a live Uudam trip. The shapes
 * mirror the live rows (travel_trip_entries + extra), so the deterministic layers, the
 * understanding step and the free-text model all see realistic data: same-destination
 * variants, per-date price groups, hotel options, child and infant bands, inclusions, booking
 * terms, itineraries, a sold-out date, a recurring weekly trip, an archived and a sold-out trip,
 * and a description with line breaks (the shape that broke the catalogue summariser).
 *
 * The harness freezes "today" at 2098-02-01, so every departure below is in 2098.
 */
import type { FixtureTrip } from "../helpers/conversationGateHarness";

const AGE_RULES = { adult: "12+ нас", child: "2-11 нас", infant: "0-23 сар" };

function trip(id: string, name: string, fields: Partial<FixtureTrip> & { extra?: Record<string, unknown> }): FixtureTrip {
  const { extra, ...rest } = fields;
  return {
    id, route_name: name, operator_name: "Вэлмор Трэвэл", category: "Аялал", duration_text: "5 өдөр 4 шөнө",
    adult_price: null, child_price: null, infant_price: null, currency: "MNT", departure_dates: [],
    seats_total: null, seats_left: null, has_food: null, status: "active", notes: "", hotel: "", source_description: "",
    photo_urls: [], created_at: "2097-12-01T00:00:00.000Z", updated_at: "2098-01-15T00:00:00.000Z",
    ...rest,
    extra: { customer_visible: true, age_rules: AGE_RULES, ...(extra || {}) },
  } as unknown as FixtureTrip;
}

const day = (n: number, title: string, description: string, hotel?: string) => ({ day: n, title, description, ...(hotel ? { hotel } : {}), meals: { breakfast: true, lunch: false, dinner: false } });

export const EVAL_TODAY = "2098-02-01";

export const evalCatalogue: FixtureTrip[] = [
  trip("vel-direct", "ВЭЛМОР ШУУД НИСЛЭГТЭЙ АЯЛАЛ", {
    category: "Шууд нислэгтэй", duration_text: "5 өдөр 4 шөнө", adult_price: 2_190_000, child_price: 1_790_000, infant_price: 390_000,
    departure_dates: ["2098-03-05", "2098-03-19", "2098-04-02"], has_food: true, hotel: "Velmor Plaza 4*",
    source_description: "Вэлмор хот руу шууд нислэгээр явах 5 өдрийн аялал.",
    extra: {
      aliases: ["Вэлмор", "Velmor", "Вэлмор шууд"], destinations: ["Вэлмор"], transport_type: "direct_flight",
      included_items: ["Нислэгийн тийз", "4* буудал (2 хүний өрөө)", "Өглөөний цай", "Аяллын даатгал", "Хөтөч"],
      excluded_items: ["Хувийн зардал", "Үдийн болон оройн хоол"],
      booking_terms: { deposit: "Урьдчилгаа 30%", payment: "Үлдэгдлийг хөдлөхөөс 10 хоногийн өмнө төлнө.", documents: "Гадаад паспорт", visa: "Виз шаардлагагүй.", cancellation: "Хөдлөхөөс 14 хоногийн өмнө цуцалбал урьдчилгаа бүрэн буцаана." },
      itinerary_days: [day(1, "Нислэг, буудалд байрлах", "Өглөө нисч, үдээс хойш буудалдаа байрлана.", "Velmor Plaza 4*"), day(2, "Хотын аялал", "Төв талбай, музей, орой чөлөөт цаг."), day(3, "Далайн эрэг", "Эргийн зугаалга, усан парк (нэмэлт төлбөртэй)."), day(4, "Чөлөөт өдөр", "Дэлгүүр хэсэх, чөлөөт цаг."), day(5, "Буцах нислэг", "Өглөөний цайны дараа ниснэ.")],
    },
  }),
  trip("vel-land", "ВЭЛМОР ГАЗРЫН АЯЛАЛ", {
    category: "Газрын аялал", duration_text: "8 өдөр 7 шөнө", adult_price: 1_290_000, child_price: 990_000, infant_price: 190_000,
    departure_dates: ["2098-03-02", "2098-03-16", "2098-03-30"], has_food: false, hotel: "Velmor Inn 3*",
    source_description: "Автобусаар явах Вэлмор хотын газрын аялал.",
    extra: {
      aliases: ["Вэлмор", "Velmor", "Вэлмор газрын"], destinations: ["Вэлмор"], transport_type: "land",
      included_items: ["Аяллын автобус (нэг хүн нэг суудал)", "3* буудал", "Хөтөч"],
      excluded_items: ["Хоол", "Хувийн зардал"],
      booking_terms: { deposit: "Урьдчилгаа 300,000₮", visa: "Виз шаардлагагүй." },
    },
  }),
  trip("vel-combo", "ВЭЛМОР ГАЗАР НИСЛЭГ ХОСОЛСОН АЯЛАЛ", {
    category: "Газар + нислэг хосолсон", duration_text: "7 өдөр 6 шөнө", adult_price: 1_690_000, child_price: 1_390_000, infant_price: 290_000,
    departure_dates: ["2098-03-09", "2098-03-23"], has_food: true, hotel: "Velmor Inn 3*",
    source_description: "Автобусаар явж нислэгээр буцах Вэлмор хотын хосолсон аялал.",
    extra: {
      aliases: ["Вэлмор", "Velmor", "хосолсон"], destinations: ["Вэлмор"], transport_type: "land_flight",
      price_groups: [
        { label: "3 сарын 9", dates: ["2098-03-09"], adult_price: 1_690_000, child_price: 1_390_000, infant_price: 290_000 },
        { label: "3 сарын 23", dates: ["2098-03-23"], adult_price: 1_790_000, child_price: 1_490_000, infant_price: 290_000 },
      ],
      included_items: ["Нислэгийн тийз (буцах)", "Аяллын автобус", "3* буудал", "Өглөөний цай"],
      excluded_items: ["Хувийн зардал"],
    },
  }),
  trip("norvel", "НОРВЕЛ ХОТЫН АЯЛАЛ", {
    category: "Шууд нислэгтэй", duration_text: "4 өдөр 3 шөнө", adult_price: null, child_price: null, infant_price: null,
    departure_dates: ["2098-02-20", "2098-03-13", "2098-04-10"], has_food: true,
    source_description: "Норвел хотын богино аялал, хоёр буудлын сонголттой.",
    extra: {
      aliases: ["Норвел", "Norvel"], destinations: ["Норвел"], transport_type: "direct_flight",
      price_groups: [
        { label: "Norvel Inn 3*", hotel: "Norvel Inn 3*", hotel_id: "norvel-inn", dates: ["2098-02-20", "2098-03-13", "2098-04-10"], adult_price: 990_000, child_price: 790_000 },
        { label: "Norvel Grand 5*", hotel: "Norvel Grand 5*", hotel_id: "norvel-grand", dates: ["2098-02-20", "2098-03-13", "2098-04-10"], adult_price: 1_390_000, child_price: 1_090_000 },
      ],
      included_items: ["Нислэгийн тийз", "Буудал", "Өглөөний цай"],
    },
  }),
  trip("kaldor-sea", "КАЛДОР ДАЛАЙН ЭРГИЙН АМРАЛТ", {
    category: "Шууд нислэгтэй", duration_text: "6 өдөр 5 шөнө", adult_price: 2_890_000, child_price: 2_490_000, infant_price: 490_000,
    departure_dates: ["2098-02-15", "2098-03-06", "2098-03-20", "2098-04-03"], hotel: "Kaldor Bay Resort 4*",
    notes: "Далайн эрэг дээрх 4* буудалд амрах аялал. Өглөөний цай багтсан.",
    source_description: "Далайн эргийн амралт.",
    extra: {
      aliases: ["Калдор", "Kaldor", "далайн амралт", "далайн эрэг"], destinations: ["Калдор"], transport_type: "direct_flight",
      website_departure_availability: [{ date: "2098-02-15", status: "SOLD_OUT", seatsLeft: 0 }, { date: "2098-03-06", status: "OPEN", seatsLeft: 12 }],
      included_items: ["Нислэгийн тийз", "4* буудал (өглөөний цайтай)", "Нисэх буудал – буудал хоорондын унаа", "Аяллын даатгал"],
      excluded_items: ["Үдийн болон оройн хоол", "Хувийн зардал"],
      booking_terms: { deposit: "Урьдчилгаа 500,000₮", payment: "Үлдэгдлийг хөдлөхөөс 7 хоногийн өмнө төлнө.", documents: "Гадаад паспорт (6 сарын хүчинтэй)", visa: "Виз шаардлагагүй.", cancellation: "Урьдчилгаа буцаагдахгүй." },
      itinerary_days: [day(1, "Нислэг", "Нисч очоод буудалдаа байрлана.", "Kaldor Bay Resort 4*"), day(2, "Далайн эрэг", "Чөлөөт амралт."), day(3, "Арлын аялал", "Завиар арал руу өдрийн аялал."), day(4, "Чөлөөт өдөр", "Чөлөөт амралт."), day(5, "Хотын аялал", "Зах, музей."), day(6, "Буцах нислэг", "Өглөө нисч ирнэ.")],
    },
  }),
  trip("orvelia-checkup", "ОРВЕЛИЯ ЭРҮҮЛ МЭНДИЙН ШИНЖИЛГЭЭТЭЙ АЯЛАЛ", {
    category: "Газрын аялал", duration_text: "7 өдөр 6 шөнө", adult_price: 1_590_000, child_price: 1_290_000, infant_price: 250_000,
    departure_dates: ["2098-03-08", "2098-04-12"], has_food: true, hotel: "Orvelia Health Hotel 4*",
    // Line breaks on purpose: the live catalogue holds descriptions like this.
    notes: [
      "Орвелиа хотод эрүүл мэндийн бүрэн үзлэг өгөх 7 өдрийн аялал.",
      "",
      "Шинжилгээнд багтсан зүйлс",
      "Үндсэн үзлэг:",
      "Дотор эрүүл мэндийн үзлэг,",
      "Зүрхний цахилгаан бичлэг",
      "Цусны шинжилгээ:",
      "Цусны ерөнхий шинжилгээ",
      "Элэгний үйл ажиллагааны шинжилгээ",
    ].join("\n"),
    extra: {
      aliases: ["Орвелиа", "Orvelia", "шинжилгээтэй аялал"], destinations: ["Орвелиа"], transport_type: "land",
      included_items: ["Эрүүл мэндийн шинжилгээ", "Аяллын автобус", "4* буудал", "Өглөөний цай", "Орчуулагч"],
      excluded_items: ["Нэмэлт шинжилгээний төлбөр", "Хувийн зардал"],
      important_notes: ["Шинжилгээний өглөө өлөн байна."],
    },
  }),
  trip("lunaria-park", "ЛУНАРИА ПАРК ГЭР БҮЛИЙН АЯЛАЛ", {
    category: "Шууд нислэгтэй", duration_text: "5 өдөр 4 шөнө", adult_price: 2_390_000, child_price: 1_990_000, infant_price: 390_000,
    departure_dates: ["2098-03-12", "2098-03-26", "2098-04-09"], has_food: true, hotel: "Lunaria Family Hotel 4*",
    source_description: "Хүүхэдтэй гэр бүлд тохирсон парктай аялал.",
    extra: {
      aliases: ["Лунариа", "Lunaria", "Лунариа парк"], destinations: ["Лунариа"], transport_type: "direct_flight",
      child_rules: [{ label: "Хүүхэд", age_range: "2-11 нас", price: 1_990_000 }, { label: "Нярай", age_range: "0-23 сар", price: 390_000 }],
      included_items: ["Нислэгийн тийз", "Паркийн тасалбар (2 өдөр)", "4* буудал", "Өглөөний цай"],
      excluded_items: ["Паркийн доторх хоол", "Хувийн зардал"],
      discounts: [{ label: "Эрт захиалгын хямдрал", dates: ["2098-04-09"], adult_price: 2_190_000, child_price: 1_790_000, condition: "3 сарын 1-ээс өмнө захиалбал" }],
      booking_terms: { deposit: "Урьдчилгаа 400,000₮", documents: "Гадаад паспорт, хүүхдийн төрсний гэрчилгээ" },
    },
  }),
  trip("tervis-cruise", "ТЭРВИС УСАН ОНГОЦНЫ АЯЛАЛ", {
    category: "Усан онгоцны аялал", duration_text: "9 өдөр 8 шөнө", adult_price: 4_590_000, child_price: 3_990_000, infant_price: null,
    departure_dates: ["2098-05-10"], has_food: true, hotel: "Усан онгоцны дотоод каюта",
    extra: { aliases: ["Тэрвис", "Tervis", "круиз", "усан онгоц"], destinations: ["Тэрвис"], transport_type: "cruise",
      included_items: ["Усан онгоцны каюта", "Өдрийн 3 хоол", "Нислэгийн тийз"] },
  }),
  trip("solmar-spring", "СОЛМАР ХАЛУУН РАШААНЫ АЯЛАЛ", {
    category: "Газрын аялал", duration_text: "3 өдөр 2 шөнө", adult_price: 590_000, child_price: 450_000, infant_price: 90_000,
    departure_dates: ["Баасан гараг бүр"], has_food: true, hotel: "Solmar Spa Hotel 3*",
    source_description: "Долоо хоног бүрийн Баасан гарагт гардаг халуун рашааны богино аялал.",
    extra: { aliases: ["Солмар", "Solmar", "рашаан", "халуун рашаан"], destinations: ["Солмар"], transport_type: "land",
      recurring_schedule: "Баасан гараг бүр", included_items: ["Автобус", "Буудал", "Рашаан сувиллын орох эрх"] },
  }),
  trip("irven-newyear", "ИРВЭН ШИНЭ ЖИЛИЙН АЯЛАЛ", {
    category: "Шууд нислэгтэй", duration_text: "6 өдөр 5 шөнө", adult_price: 3_290_000, child_price: 2_890_000, infant_price: 490_000,
    departure_dates: ["2098-12-28"], has_food: true, hotel: "Irven Central 4*",
    extra: { aliases: ["Ирвэн", "Irven", "шинэ жил"], destinations: ["Ирвэн"], transport_type: "direct_flight",
      included_items: ["Нислэгийн тийз", "4* буудал", "Шинэ жилийн гала оройн зоог"] },
  }),
  trip("mirra-soldout", "МИРРА АРЛЫН АЯЛАЛ", {
    status: "sold_out", category: "Шууд нислэгтэй", duration_text: "5 өдөр 4 шөнө", adult_price: 1_990_000, child_price: 1_690_000, infant_price: 290_000,
    departure_dates: ["2098-02-22"], seats_total: 20, seats_left: 0,
    extra: { aliases: ["Мирра", "Mirra"], destinations: ["Мирра"], transport_type: "direct_flight" },
  }),
  trip("durvan-old", "ДУРВАН ХУУЧИН АЯЛАЛ", {
    status: "archived", category: "Газрын аялал", duration_text: "4 өдөр 3 шөнө", adult_price: 890_000, child_price: 690_000,
    departure_dates: ["2097-10-01"],
    extra: { customer_visible: false, aliases: ["Дурван"], archived_reason: "all_departure_dates_passed" },
  }),
];

/** Invented bot settings in the same shape as the live row (hand-over words are configuration, not customer data). */
export const evalSettings: Record<string, unknown> = {
  business_name: "Вэлмор Трэвэл",
  system_prompt: "You are the official AI travel assistant for Velmor Travel. ALWAYS reply in Mongolian only. Use only the approved travel data. Never invent prices, dates, seats, food inclusion, operators, or route details.",
  handoff_enabled: true,
  handoff_keywords: ["хүнтэй ярих", "хүнтэй ярья", "хүнтэй холбогдъё", "хүнтэй холбоо", "ажилтантай ярих", "ажилтантай холбогдъё", "оператортой ярих", "жинхэнэ хүн", "бодит хүн", "хүн рүү холбо", "talk to human", "talk to a person", "real person", "customer service", "speak to someone", "live agent"],
  handoff_reply: "Таны хүсэлтийг хүлээн авлаа. Манай ажилтан удахгүй тантай холбогдоно. Түр хүлээнэ үү. 🙋",
  handoff_pause_minutes: 60,
  quick_info_keywords: ["info", "мэдээлэл", "дэлгэрэнгүй", "site", "website", "вэб", "web"],
  quick_info_reply: "Сайн байна уу! Вэлмор Трэвэл. Бүх аяллын мэдээллийг манай вэбсайтаас үзнэ үү: https://velmor.example.invalid",
  extra: {
    greeting: { enabled: false }, goodbye: { enabled: false }, reminder_enabled: false, seasons_enabled: false,
    contact_phones: "7700 1234 / 9900 5678",
    office_address: "Энхтайваны өргөн чөлөө 1, Вэлмор төв, 2 давхар",
  },
};

export const EVAL_PHONES = ["77001234", "99005678"];
