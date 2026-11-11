import assert from "node:assert/strict";
import test from "node:test";
import { conversationGateHarness, type FixtureTrip } from "./helpers/conversationGateHarness";
import { fixtureTrip } from "./helpers/holidayFixture";

/**
 * Calendar / holiday / date / price journeys still failing in the understanding scenarios
 * (tests/understanding-scenarios.test.ts, 2026-11-11), each in the shape of its scenario on an
 * INVENTED catalogue (no real trip, place, price or date) through the real webhook:
 *  NEAR    a holiday + a place with nothing in its window: only departures within ~6 weeks of the
 *          holiday, nearest first; none that close = "the schedule is not out" and the website only
 *          (CASE-2, MC-04, OP-2.p3: "…амралтаар" is the holiday's break, not a trip's word)
 *  PARTY   holiday + place + party: each listed trip prints the party's fare for its holiday date (MC-01)
 *  RETURN  "12/30-нд явж 1 сарын эхээр буцдаг": leaving on 12/30, back in early January (OP-10.p2)
 *  FOLLOW  "dahin 2 sard…" under a trip and "үгүй <date>" corrections are date follow-ups (CASE-3.q.q3, CTX-04)
 *  NEWYEAR Latin "shine jilr" is New Year; "huuhed 4 ba 7 nastai…" under that list gets each trip's
 *          fare for those ages, or says it is unknown for that trip (CASE-5.t1b)
 *  QUOTED  "870k багц" under a list is the quoted-price lookup (CASE-6.p2)
 *  DATEFARE "хүүхдийн үнэ" after "Аль гарах өдрөөр аялах вэ?" answers per departure, never the same menu again
 *
 * Clock: 2026-11-06 (Tsagaan Sar 2027 = 6-9 February). Model: the mock; nothing paid, nothing sent.
 */

const NOW = "2026-11-06T04:00:00Z";
const trip = (id: string, name: string, dates: string[], fares: [number, number | null, number | null], extra: Record<string, unknown> = {}, fields: Record<string, unknown> = {}) => {
  const built = fixtureTrip(id, name, dates, fares, fields) as FixtureTrip & { extra: Record<string, unknown> };
  built.extra = { ...built.extra, ...extra };
  return built;
};

const HOLIDAY: FixtureTrip[] = [
  // Гелвар: nothing over Tsagaan Sar; 1/12 is 25 days before it, 12/2 and 11/20 are months away.
  trip("gel-a", "ГЕЛВАР – ОСТРИН АЯЛАЛ", ["2026-11-20", "2027-01-12"], [2_100_000, 1_800_000, null], { aliases: ["Гелвар", "Gelvar"], destinations: ["Гелвар", "Острин"] }, { duration_text: "6 өдөр 5 шөнө" }),
  trip("gel-b", "ГЕЛВАР – ТОРНИН ЭРГИЙН АЯЛАЛ", ["2026-12-02"], [2_500_000, 2_200_000, null], { aliases: ["Гелвар", "Gelvar"], destinations: ["Гелвар", "Торнин"] }, { duration_text: "6 өдөр 5 шөнө" }),
  // Миртан: only departures months before the holiday.
  trip("mirtan", "МИРТАН – ЛОВЕН АЯЛАЛ", ["2026-11-25", "2026-12-09"], [3_000_000, 2_600_000, null], { aliases: ["Миртан", "Mirtan"], destinations: ["Миртан", "Ловен"] }),
  trip("mirtan-b", "МИРТАН – САЛВЕН АЯЛАЛ", ["2026-11-26"], [3_200_000, 2_800_000, null], { aliases: ["Миртан", "Mirtan"], destinations: ["Миртан", "Салвен"] }),
  // Солвера: two trips on the road over (or just after) Tsagaan Sar.
  trip("solvera", "СОЛВЕРА – ДЕНТАР АЯЛАЛ", ["2026-11-27", "2027-01-30", "2027-02-06"], [4_000_000, 3_500_000, 700_000], { aliases: ["Солвера", "Solvera"], destinations: ["Солвера", "Дентар"] }),
  trip("solvera-b", "СОЛВЕРА – ОРНЕЛ АЯЛАЛ", ["2027-02-11"], [4_500_000, 3_900_000, 700_000], { aliases: ["Солвера", "Solvera"], destinations: ["Солвера", "Орнел"] }),
  // A sea trip whose title ends in "АМРАЛТ" (rest), the word of "цагаан сарын амралтаар".
  trip("koralin", "КОРАЛИН АРЛЫН ДАЛАЙН АМРАЛТ", ["2026-11-28", "2026-12-12"], [3_100_000, 2_700_000, null], { aliases: ["Коралин"], destinations: ["Коралин"] }),
];
const NEW_YEAR: FixtureTrip[] = [
  // New Year: one with a child fare, one without.
  trip("kaldora-ny", "КАЛДОРА НИСЛЭГТЭЙ ШИНЭ ЖИЛИЙН АЯЛАЛ", ["2026-12-29"], [3_300_000, 3_000_000, 500_000], { destinations: ["Калдора"] }),
  trip("brenta", "БРЕНТА – ОЛВИН АЯЛАЛ", ["2026-12-28"], [2_700_000, null, null], { destinations: ["Брента", "Олвин"] }),
];
const LEAVE_AND_BACK: FixtureTrip[] = [
  // Leaving 30 December: back on 3 January, or on the 18th; and a trip leaving in early January.
  trip("talven", "ТАЛВЕН ХОТЫН АЯЛАЛ", ["2026-12-30"], [2_900_000, 2_500_000, null], { destinations: ["Талвен"] }, { duration_text: "5 өдөр 4 шөнө" }),
  trip("rosvel", "РОСВЕЛ УРТ АЯЛАЛ", ["2026-12-30"], [6_900_000, 6_000_000, null], { destinations: ["Росвел"] }, { duration_text: "20 өдөр 19 шөнө" }),
  trip("jan-trip", "ВОРДАН ХОТЫН АЯЛАЛ", ["2027-01-05"], [1_500_000, 1_200_000, null], { destinations: ["Вордан"] }),
];
const OTHERS: FixtureTrip[] = [
  // The quoted price of the agency's post.
  trip("veltra", "ВЕЛТРА – ХОРМИН ХОТЫН АЯЛАЛ", ["2026-12-03", "2026-12-17"], [870_000, 760_000, null], { destinations: ["Велтра", "Хормин"] }, { duration_text: "7 өдөр 6 шөнө" }),
  // The ad's trip on screen: one November departure.
  trip("torval-ad", "ТОРВАЛ + ЭЛДИН ШУУД НИСЛЭГТЭЙ АЯЛАЛ", ["2026-11-19"], [3_760_000, 3_430_000, null], { aliases: ["Элдин"], destinations: ["Торвал", "Элдин"] }),
  // Fares that differ by departure.
  trip("zelmor", "ЗЕЛМОР – КАРВЕН 9 ӨДӨР", ["2026-11-18", "2026-11-25", "2026-12-02"], [4_090_000, 3_790_000, 590_000], {
    destinations: ["Зелмор", "Карвен"],
    price_groups: [
      { dates: ["2026-11-18", "2026-11-25"], adult_price: 4_090_000, child_price: 3_790_000 },
      { dates: ["2026-12-02"], adult_price: 4_490_000, child_price: 3_990_000 },
    ],
  }, { duration_text: "9 өдөр 8 шөнө" }),
];

const NO_HELP = { intent: "other", topics: [], certainty: "none" };

test("calendar / holiday / price journeys still open in the scenarios (invented catalogue)", async (context) => {
  const harness = await conversationGateHarness(context);
  context.mock.timers.setTime(Date.parse(NOW));
  const { setTripSelection } = await import("../src/lib/tripSelectionState");
  let serial = 0;
  const fresh = () => `facal-${++serial}`;
  const say = async (sender: string, text: string, model: Record<string, unknown> = NO_HELP) => {
    const result = await harness.turn(sender, text, model);
    return { ...result, text: result.sends.map((send) => send.text).join("\n") };
  };
  /** Every date printed on a trip card ("📅 1/12, 2/6") as "1/12". */
  const cardDates = (reply: string) => reply.split("\n").filter((line) => line.startsWith("📅"))
    .flatMap((line) => line.slice(2).split(",").map((date) => date.trim()).filter(Boolean));

  await context.test("NEAR holiday + place, nothing in the window: only the departures within weeks of it, else the website", async () => {
    harness.catalog(HOLIDAY);
    for (const text of ["Цагаан сараар Гелвар явмаар байна", "tsagaan sarar gelvar yavmaar bn", "Цагаан сарын амралтаар Гелвар явах аялал байгаа юу"]) {
      const reply = await say(fresh(), text);
      assert.equal(reply.sends.length, 1, text);
      assert.match(reply.text, /Цагаан сарын үеэр \(2027 оны 2 сарын 6–9 орчим\)/u, text);
      assert.deepEqual(cardDates(reply.text), ["1/12"], `${text}: only the departure 25 days before the holiday: ${reply.text}`);
      assert.doesNotMatch(reply.text, /ТОРНИН|11\/20|12\/2/u, `${text}: departures months away are not offered for the holiday`);
    }
    // Nothing within weeks of the holiday: the schedule is not out, and the website is the answer.
    const far = await say(fresh(), "Цагаан сараар Миртан явмаар байна");
    assert.equal(far.sends.length, 1);
    assert.match(far.text, /^Цагаан сарын үеэр \(2027 оны 2 сарын 6–9 орчим\) Миртан чиглэлд гарах аяллын хуваарь одоогоор гараагүй байна 🙏 Шинэ хуваарийг эндээс харна уу: https:\/\/uudamtravel\.mn/u);
    assert.doesNotMatch(far.text, /📅|11\/25|12\/9|МИРТАН/u, `no far dates: ${far.text}`);
    // "…амралтаар" belongs to the holiday: the family's question is about the holiday, not the sea trip titled "…АМРАЛТ".
    const family = await say(fresh(), "Цагаан сарын амралтаар гэр бүлээрээ явах аялал байна уу");
    assert.equal(family.sends.length, 1);
    assert.match(family.text, /^🌙 Цагаан сарын үеэр/u, family.text);
    assert.match(family.text, /СОЛВЕРА/u);
    assert.doesNotMatch(family.text, /КОРАЛИН/u, `the sea trip is not the holiday answer: ${family.text}`);
  });

  await context.test("PARTY holiday + place + party: each trip prints the party's fare for its holiday date", async () => {
    harness.catalog(HOLIDAY);
    for (const text of ["Цагаан сараар Солвера 2 том 2 хүүхэдтэй явмаар байна", "tsagaan sarar solvera 2 om 2 huuhedtei yavmaar bna",
      "Цагаан сарын амралтаар Солвера руу 2 хүн, 2 хүүхэдтэй явья", "Солверагийн цагаан сарын аялал, том хүн 2, хүүхэд 2"]) {
      const reply = await say(fresh(), text);
      assert.equal(reply.sends.length, 1, text);
      assert.match(reply.text, /^🌙 Цагаан сарын үеэр/u, text);
      assert.match(reply.text, /СОЛВЕРА – ДЕНТАР АЯЛАЛ[^]*?👥 Нийт: 15,000,000₮ \(2 том хүн x 4,000,000₮ \+ 2 хүүхэд x 3,500,000₮\)/u, `${text}: ${reply.text}`);
      assert.match(reply.text, /СОЛВЕРА – ОРНЕЛ АЯЛАЛ[^]*?👥 Нийт: 16,800,000₮ \(2 том хүн x 4,500,000₮ \+ 2 хүүхэд x 3,900,000₮\)/u, text);
    }
  });

  await context.test("RETURN a day of leaving and a return window: the trips leaving that day and back in time", async () => {
    harness.catalog(LEAVE_AND_BACK);
    const reply = await say(fresh(), "12/30-нд явж 1 сарын эхээр буцдаг аялал байна уу");
    assert.equal(reply.sends.length, 1);
    assert.match(reply.text, /12 сарын 30|12\/30/u, reply.text);
    assert.match(reply.text, /ТАЛВЕН/u);
    assert.doesNotMatch(reply.text, /РОСВЕЛ/u, "back on the 18th is not early January");
    assert.doesNotMatch(reply.text, /ВОРДАН|1 сард гарах|1\/5/u, "the return window is not a month of leaving");
  });

  await context.test("FOLLOW a date follow-up with a filler or a correction word is answered for the trip in scope", async () => {
    harness.catalog([...HOLIDAY, ...OTHERS]);
    const onScreen = fresh();
    await setTripSelection(onScreen, { tripId: "torval-ad", date: null, hotel: null, package: null, passengers: [] } as never);
    const again = await say(onScreen, "dahin 2 sard yavmaar bn");
    assert.equal(again.sends.length, 1, "answered, not silence");
    assert.match(again.text, /ТОРВАЛ|11 сарын 19/u, again.text);
    const correction = fresh();
    const first = await say(correction, "Солвера 2 сарын 6", { intent: "trip", certainty: "one", tripId: "solvera", topics: ["availability"], date: "2027-02-06" });
    assert.match(first.text, /2 сарын 6/u);
    const fixed = await say(correction, "үгүй 1 сарын 30", { intent: "trip", certainty: "one", tripId: "solvera", topics: ["availability"], date: "2027-01-30" });
    assert.equal(fixed.sends.length, 1, "the corrected date is answered");
    assert.match(fixed.text, /1 сарын 30/u, fixed.text);
    assert.doesNotMatch(fixed.text, /2 сарын 6\b/u);
  });

  await context.test("NEWYEAR Latin 'shine jilr' is New Year; ages under that list get each trip's fare or 'unknown'", async () => {
    harness.catalog(NEW_YEAR);
    const sender = fresh();
    const list = await say(sender, "shine jilr gadaad ayal bgaa yu", { intent: "catalog", topics: ["dates"], certainty: "none" });
    assert.equal(list.sends.length, 1, "the New Year list, not silence");
    assert.match(list.text, /Шинэ жилийн үеэр/u);
    assert.match(list.text, /КАЛДОРА/u);
    assert.match(list.text, /БРЕНТА/u);
    const fares = await say(sender, "huuhed 4 ba 7 nastai ne yaaj tulhu ve", { intent: "trip", topics: ["price"], certainty: "several",
      passengers: [{ kind: "child", count: 1, age: 4 }, { kind: "child", count: 1, age: 7 }] });
    assert.equal(fares.sends.length, 1, "answered under the list");
    assert.match(fares.text, /КАЛДОРА[^\n]*: 2 хүүхэд \/2-11 нас\/ x 3,000,000₮/u, fares.text);
    assert.match(fares.text, /• БРЕНТА – ОЛВИН АЯЛАЛ — энэ насны үнэ бүртгэгдээгүй/u, `a trip with no child fare says so: ${fares.text}`);
  });

  await context.test("QUOTED '870k багц' under a list is the price of the post", async () => {
    harness.catalog([...NEW_YEAR, ...OTHERS]);
    const sender = fresh();
    await say(sender, "Sain bnuu ene shine jiliin ayalal haashaa be", { intent: "catalog", topics: ["dates"], certainty: "none" });
    const quoted = await say(sender, "870k багц", { intent: "trip", topics: ["price"], certainty: "none" });
    assert.equal(quoted.sends.length, 1, "answered, not silence");
    assert.match(quoted.text, /ВЕЛТРА/u, quoted.text);
  });

  await context.test("DATEFARE a fare kind asked after 'which departure?' is answered per departure", async () => {
    harness.catalog(OTHERS);
    const sender = fresh();
    const model = { intent: "trip", certainty: "one", tripId: "zelmor", topics: ["price"] };
    const card = await say(sender, "ЗЕЛМОР – КАРВЕН аялал", model);
    assert.match(card.text, /Аль гарах өдрөөр аялах вэ\?/u);
    for (const text of ["хүүхдийн үнэ", "huuhdiin une hed ve"]) {
      const child = await say(sender, text, model);
      assert.equal(child.sends.length, 1, text);
      assert.doesNotMatch(child.text, /Аль гарах өдрөөр аялах вэ\?/u, `${text}: the same menu again: ${child.text}`);
      assert.match(child.text, /11 сарын 18, 11 сарын 25\nХүүхэд \(2-11 нас\): 3,790,000₮/u, child.text);
      assert.match(child.text, /12 сарын 2\nХүүхэд \(2-11 нас\): 3,990,000₮/u, child.text);
    }
  });
});
