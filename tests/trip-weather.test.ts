import assert from "node:assert/strict";
import test from "node:test";
import { buildTripWeatherReply, hasWeatherIntent, isWeatherTurn, WEATHER_WHICH_TRIP_REPLY } from "../src/lib/tripWeather";
import type { TravelTrip } from "../src/lib/travelTypes";

// Invented catalogue — never real trips in tests.
const base: Omit<TravelTrip, "id" | "route_name"> = {
  category: "Аялал", operator_name: "Uudam", duration_text: "7 өдөр", adult_price: 1990000,
  child_price: null, infant_price: null, currency: "MNT", departure_dates: ["2027-10-08"],
  seats_total: null, seats_left: null, has_food: true, status: "active", notes: "", hotel: "",
  source_description: "", photo_urls: [], created_at: "", updated_at: "", extra: {},
};
const velmor: TravelTrip = { ...base, id: "velmor", route_name: "Вэлмор – Кардан аялал" };
const ostrin: TravelTrip = { ...base, id: "ostrin", route_name: "Острин далайн аялал" };
const ostrin2: TravelTrip = { ...base, id: "ostrin-2", route_name: "Острин – Пэлдар аялал" };
const trips = [velmor, ostrin, ostrin2];

test("weather questions are recognised in Cyrillic, Latin-typed Mongolian and English", () => {
  for (const q of [
    "Вэлмор цаг агаар ямар байна",
    "тэнд цаг агаар ямар байх вэ?",
    "хэдэн градус байна",
    "хэдэн хэм байх бол",
    "хүйтэн байна уу",
    "дулаан уу",
    "бороо орох уу",
    "ямар хувцас авах вэ",
    "tsag agaar ymar bn",
    "what's the weather like",
  ]) {
    assert.equal(hasWeatherIntent(q), true, q);
  }
});

test("hot springs, sizes and prices are not weather questions", () => {
  for (const q of [
    "халуун рашаантай аялал байна уу",
    "Вэлмор аялал үнэ хэд вэ",
    "өрөөний хэмжээ ямар вэ",
    "хэзээ гарах вэ",
    "хөтөлбөр явуулаач",
  ]) {
    assert.equal(hasWeatherIntent(q), false, q);
  }
});

test("a named trip gets the website's report text verbatim, with the trip page link", async () => {
  const calls: string[] = [];
  const result = await buildTripWeatherReply("Вэлмор цаг агаар ямар байна", trips, async (id) => {
    calls.push(id);
    return { text: "🌍 Вэлмор — цаг агаар\nОдоо: ☀️ 25°C", tripSlug: "velmor-slug" };
  });
  assert.equal(result.kind, "answer");
  assert.deepEqual(calls, ["velmor"]);
  assert.match(result.reply, /^🌍 Вэлмор — цаг агаар\nОдоо: ☀️ 25°C/);
  assert.match(result.reply, /\/mn\/trips\/velmor-slug/);
});

test("several matching trips → ask which one, never guess", async () => {
  const result = await buildTripWeatherReply("Острин цаг агаар", trips, async () => {
    throw new Error("must not fetch before the trip is known");
  });
  assert.equal(result.kind, "clarify");
  if (result.kind === "clarify") assert.equal(result.candidates.length, 2);
});

test("no trip named → ask which trip instead of going silent", async () => {
  const result = await buildTripWeatherReply("цаг агаар ямар байна", trips, async () => null);
  assert.deepEqual(result, { kind: "ask", reply: WEATHER_WHICH_TRIP_REPLY });
});

test("website unreachable → honest message with a link, never an invented forecast", async () => {
  const result = await buildTripWeatherReply("Вэлмор цаг агаар", trips, async () => null);
  assert.equal(result.kind, "answer");
  assert.match(result.reply, /татаж чадсангүй/);
  assert.doesNotMatch(result.reply, /°/);
});

test("two trips with the SAME name: the picked trip id answers instead of re-asking forever", async () => {
  const cheap: TravelTrip = { ...base, id: "twin-a", route_name: "Сарвин – Дөлөн аялал" };
  const dear: TravelTrip = { ...base, id: "twin-b", route_name: "Сарвин – Дөлөн аялал" };
  const pool = [cheap, dear];
  const fetched: string[] = [];
  const stub = async (id: string) => {
    fetched.push(id);
    return { text: "🌍 Сарвин — цаг агаар", tripSlug: id };
  };
  const byName = await buildTripWeatherReply("Сарвин – Дөлөн аялал цаг агаар", pool, stub);
  assert.equal(byName.kind, "clarify");
  const picked = await buildTripWeatherReply("Сарвин – Дөлөн аялал 2", pool, stub, "twin-b");
  assert.equal(picked.kind, "answer");
  assert.deepEqual(fetched, ["twin-b"]);
});

test("tapping a trip after 'which trip?' keeps answering the weather question", () => {
  const history = [
    { role: "user" as const, text: "Острин цаг агаар ямар байна" },
    { role: "assistant" as const, text: "Аль аяллыг нь сонирхож байна вэ?\n1. Острин далайн аялал\n2. Острин – Пэлдар аялал" },
  ];
  assert.equal(isWeatherTurn("1. Острин далайн аялал", history), true);
  // …but not after an unrelated trip list.
  const priceHistory = [
    { role: "user" as const, text: "Острин үнэ хэд вэ" },
    history[1],
  ];
  assert.equal(isWeatherTurn("1. Острин далайн аялал", priceHistory), false);
  // …and not when the last reply did not ask which trip.
  assert.equal(isWeatherTurn("баярлалаа", [history[0], { role: "assistant", text: "🌍 Острин — цаг агаар" }]), false);
});
