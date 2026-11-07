import assert from "node:assert/strict";
import test from "node:test";
import { conversationGateHarness } from "./helpers/conversationGateHarness";
import { HOLIDAY_CATALOG, HOLIDAY_NOW, PRICE_NOISE_TRIPS, WEEKLY_TRIP } from "./helpers/holidayFixture";

/**
 * Customer journeys for the CALENDAR / HOLIDAY / DATE group (live conversations 2026-11-01..06),
 * on an INVENTED catalogue (tests/helpers/holidayFixture.ts) and the real webhook:
 *  CASE1 a holiday asked after a country list is a holiday question, never the soonest departures
 *  CASE2 holiday + a place with no departure in the window: the window is named, dates are the ones nearest to it
 *  CASE3 a date follow-up in ordinary words (typos, a verb, a filler) is answered, with or without a trip on screen
 *  CASE4 a place no trip goes to is a constraint: silence and a lead, never another place's list
 *  CASE5 a family asks New Year abroad, then fares by age under the list
 *  CASE6 a quoted price, written any way, finds the trip sold at it
 * plus the owner's unseen paraphrases and ordinary questions that must still be answered.
 *
 * Clock: 2026-11-06 (the Tsagaan Sar table has 2026-2030, so the coming one is 2027-02-06..09; the harness
 * default of 2098 makes it "unknown"). Model: the mock (no provider key, nothing paid, nothing sent).
 */
test("holiday / calendar journeys (invented catalogue)", async (context) => {
  const harness = await conversationGateHarness(context);
  context.mock.timers.setTime(Date.parse(HOLIDAY_NOW));
  harness.catalog([...HOLIDAY_CATALOG, WEEKLY_TRIP, ...PRICE_NOISE_TRIPS]);
  const { setTripSelection } = await import("../src/lib/tripSelectionState");
  let serial = 0;
  const say = async (sender: string, text: string, model: Record<string, unknown> = {}) => {
    const result = await harness.turn(sender, text, model);
    return { ...result, text: result.sends.map((send) => send.text).join("\n") };
  };
  /** A customer with the ad's trip already selected (the Messenger ad referral selects it). */
  const withTrip = async (tripId: string) => {
    const sender = `hol-${++serial}`;
    await setTripSelection(sender, { tripId, date: null, hotel: null, package: null, passengers: [] } as never);
    return sender;
  };
  const fresh = () => `hol-${++serial}`;
  /** Every date printed on a trip card ("📅 12/3, 12/10") as "12/3". */
  const dates = (reply: string) => reply.split("\n").filter((line) => line.startsWith("📅")).flatMap((line) => line.slice(2).split(",").map((date) => date.trim()).filter(Boolean));
  const inFebruaryWindow = (date: string) => /^(?:1\/(?:3[01])|2\/(?:[1-9]|1[0-6]))$/.test(date);
  const WINDOW = /\(2027 оны 2 сарын 6–9 орчим\)/u;
  try {
    await context.test("CASE1 a holiday asked after a country list is a holiday question, not the soonest departures", async () => {
      const sender = fresh();
      await say(sender, "Тарвия");
      await say(sender, "2 сард");
      const holiday = await say(sender, "цагаан сарын үейр ямар аялалууд байна");
      assert.match(holiday.text, /Цагаан сарын үеэр/u);
      assert.match(holiday.text, WINDOW);
      assert.doesNotMatch(holiday.text, /Манай аяллууд/u);
      assert.ok(dates(holiday.text).length > 0 && dates(holiday.text).every(inFebruaryWindow), `only dates around the holiday, never November: ${dates(holiday.text)}`);
      // Unseen paraphrases: a typo, Latin letters, another catalogue word, the holiday named after a month.
      for (const text of ["цагаан сарын уеэр ямар аялал байна", "tsagaan sariin uyeer yamar aylaluud bna", "Цагаан сараар хаашаа явж болох вэ?", "2 сарын цагаан сараар ямар аялал байна"]) {
        const reply = await say(fresh(), text);
        assert.equal(reply.sends.length, 1, text);
        assert.ok(dates(reply.text).length > 0 && dates(reply.text).every((date) => /^(?:1\/|2\/)/.test(date)), `${text}: ${dates(reply.text)}`);
        assert.doesNotMatch(reply.text, /Манай аяллууд/u, text);
      }
    });

    await context.test("CASE2 holiday + a place, no departure in the window: the window is named and the dates are the nearest to it", async () => {
      // The first text is typed as the customer did (a Latin e inside "үeээр"); the rest have no catalogue word at all.
      for (const text of ["Цагаан сарын үeээр Пекара хотын хэрэм үзэх аялал сонирхоё", "Цагаан сараар Пекара явмаар байна", "Цагаан сарын дараа Пекара явах аялал байна уу",
        "tsagaan saraar Pekara yavmaar bna", "Цагаан сарын амралтаар Пекара явах аялал байгаа юу", "цагаан сарын үеэр пекара явъя",
        "Tsagaan sar deer Pekara yavah bolomjtoi yu", "Цагаан сараар Пекара"]) {
        const reply = await say(fresh(), text);
        assert.equal(reply.sends.length, 1, text);
        assert.match(reply.text, /^Цагаан сарын (?:үеэр|дараа) \(2027 оны 2 сарын 6–9 орчим\) Пекара чиглэлд гарах аяллын хуваарь одоогоор гараагүй байна/u, `${text}: ${reply.text}`);
        assert.doesNotMatch(reply.text, /Тэр хугацаанд гарах аялал алга/u, text);
        // Nearest to the holiday first: the January departure, not the November ones or December's.
        assert.ok(reply.text.indexOf("ПЕКАРА - ЖИРОН") < reply.text.indexOf("ПЕКАРА - ТОРВИН"), `nearest-to-window order: ${reply.text}`);
        assert.match(reply.text, /📅 [^\n]*1\/10/u, text);
      }
      // Singular "аялал", the holiday's name only: still one path (it used to flip on one catalogue word).
      const sameWithCatalogueWord = await say(fresh(), "Цагаан сарын үеэр Пекара явж болох уу?");
      assert.match(sameWithCatalogueWord.text, /Пекара чиглэлд гарах аяллын хуваарь одоогоор гараагүй/u);
    });

    await context.test("CASE2b a holiday that has departures names which days it covers and which only leave near it", async () => {
      const reply = await say(fresh(), "Цагаан сараар Тарвия явмаар байна");
      assert.match(reply.text, /^🌙 Цагаан сарын үеэр \(2027 оны 2 сарын 6–9 орчим\) Тарвия чиглэлд аялах боломжтой аяллууд:/u);
      // The same ask in other words, a Latin spelling of the place, and the holiday's other name.
      for (const text of ["Сар шинээр Тарвия явъя", "цагаан сарын амралтаар Тарвия руу явмаар байна", "tsagaan sariin uyeer Tarvia yavah"]) {
        const again = await say(fresh(), text);
        assert.match(again.text, /^🌙 Цагаан сарын үеэр \(2027 оны 2 сарын 6–9 орчим\) Тарвия чиглэлд аялах боломжтой аяллууд:/u, text);
      }
      assert.match(reply.text, /✅ Цагаан сарын өдрүүдийг хамарна/u);
      assert.match(reply.text, /↔ Цагаан сарын өдрүүдээс хойш гарна/u);
      assert.ok(dates(reply.text).every(inFebruaryWindow), `${dates(reply.text)}`);
      const after = await say(fresh(), "Цагаан сарын дараа Тарвия явах аялал байна уу");
      assert.match(after.text, /^🌙 Цагаан сарын дараа/u);
      assert.ok(dates(after.text).length > 0 && dates(after.text).every((date) => /^2\/(?:1[0-9]|2[0-9])$/.test(date)), `the weeks after the holiday: ${dates(after.text)}`);
    });

    await context.test("CASE3 a date follow-up in ordinary words under the ad's trip is answered, never silence", async () => {
      for (const text of ["Он гараад цагаан сар тааруулсан ийм хөтөлбөртэй аялал гарах уу?", "2027 ионы 2-р сард аялах юмаа", "2 сард явмаар байна", "тэгвэл цагаан сараар гарах уу",
        "2027 ioni 2-r sard ayalah yumaa", "Дараа жилийн 2 сард аялмаар байна", "цагаан сарын үеэр гарах боломжтой юу"]) {
        const reply = await say(await withTrip("korvelin-ad"), text);
        assert.equal(reply.sends.length, 1, `answered: ${text}`);
        assert.match(reply.text, /КОРВЕЛИН|11 сарын 19|11\/19/u, `about the trip on screen: ${text}: ${reply.text}`);
        assert.doesNotMatch(reply.text, /ШИНЭ ЖИЛИЙН/u, `a word of the date phrase did not pick another trip: ${text}`);
        // The trip's own text never promised a Tsagaan Sar programme, so the bot does not either.
        assert.doesNotMatch(reply.text, /цагаан сарын хөтөлбөр/iu, text);
      }
      const holiday = await say(await withTrip("korvelin-ad"), "Он гараад цагаан сар тааруулсан ийм хөтөлбөртэй аялал гарах уу?");
      assert.match(holiday.text, /^Цагаан сарын үеэр \(2027 оны 2 сарын 6–9 орчим\) гарах аяллын хуваарь одоогоор гараагүй байна/u);
      // The year the customer states is the year: February 2027, never November 2026.
      const month = await say(await withTrip("korvelin-ad"), "2027 ионы 2-р сард аялах юмаа");
      assert.match(month.text, /^Тэр хугацаанд гарах аялал алга\. Гарах өдрүүд:\n• КОРВЕЛИН[^\n]*: 11 сарын 19/u);
    });

    await context.test("CASE3b the same follow-ups with no trip on screen get the trips that leave then, not silence", async () => {
      for (const text of ["тэгвэл цагаан сараар гарах уу", "2027 ионы 2-р сард аялах юмаа", "Дараа жилийн 2 сард аялмаар байна", "2 сард явмаар байна"]) {
        const reply = await say(fresh(), text);
        assert.equal(reply.sends.length, 1, `answered: ${text}`);
        assert.ok(dates(reply.text).length > 0 && dates(reply.text).every((date) => /^(?:1\/3[01]|2\/\d+)$/.test(date)), `${text}: ${dates(reply.text)}`);
        assert.doesNotMatch(reply.text, /ШИНЭ ЖИЛИЙН/u, text);
      }
    });

    await context.test("CASE3c the window an earlier turn asked for is kept when the next message only names a place", async () => {
      const holiday = fresh();
      assert.match((await say(holiday, "Цагаан сараар явмаар байна")).text, /Цагаан сарын үеэр/u);
      const place = await say(holiday, "Тарвия");
      assert.equal(place.sends.length, 1);
      assert.deepEqual([...new Set(place.sends.flatMap((send) => send.text.split("\n").filter((line) => line.startsWith("1. ") || line.startsWith("2. "))))].sort(),
        ["1. ТАРВИЯ — ОРМЕЛ АЯЛАЛ", "2. ТАРВИЯ АЯЛАЛ — ЛУМАР, ВЕЛНА"].sort());
      assert.ok(dates(place.text).every(inFebruaryWindow), `the holiday's dates, not the earliest ones: ${dates(place.text)}`);
      // A place with nothing in the window: the window the customer asked for is named, not dropped or guessed.
      const none = fresh();
      await say(none, "Цагаан сараар явмаар байна");
      const pekara = await say(none, "Пекара");
      assert.equal(pekara.sends.length, 1);
      assert.match(pekara.text, /^Цагаан сарын үеэр \(2027 оны 2 сарын 6–9 орчим\) гарах аяллын хуваарь одоогоор гараагүй байна/u);
      assert.match(pekara.text, /ПЕКАРА/u);
      // A month asked first keeps its month for the place that follows.
      const month = fresh();
      await say(month, "2 сард явмаар байна");
      const tarvia = await say(month, "Тарвия");
      assert.equal(tarvia.sends.length, 1);
      assert.ok(dates(tarvia.text).length > 0 && dates(tarvia.text).every((date) => /^2\//.test(date)), `${dates(tarvia.text)}`);
    });

    await context.test("CASE4 a place no trip goes to is a constraint: silence and one lead, never another place's trips", async () => {
      const texts = ["12 сарын шинэ жилийн хөтөлбөртэй Оролгын аялал байна уу?", "Шинэ жилээр Оролго явах аялал байна уу?", "Цагаан сараар Оролго явмаар байна", "12 сард Оролго явах аялал байна уу",
        "Shine jileer Orolgo yavmaar bna", "Оролго руу цагаан сараар явах аялал бий юу", "Orolgo ruu shine jileer yavmaar bna", "Шинэ жилээр Оролго явъя"];
      for (const [index, text] of texts.entries()) {
        // With the model reading the place, and with it reading nothing (certainty "none").
        for (const model of [{ place: "Оролго", unknown_destination: "Оролго", intent: "trip", certainty: "none" }, {}]) {
          const reply = await say(`unknown-${index}-${Object.keys(model).length}`, text, model);
          assert.equal(reply.sends.length, 0, `silence for an unknown place: ${text} -> ${reply.text}`);
          assert.equal(reply.leads.length, 1, `a staff lead for: ${text}`);
        }
      }
      // A place the catalogue holds, in the same sentences, is answered with that place's trips.
      for (const text of ["Шинэ жилээр Пекара явах аялал байна уу?", "Цагаан сараар Пекара явмаар байна", "12 сард Пекара явах аялал байна уу"]) {
        const reply = await say(fresh(), text);
        assert.equal(reply.sends.length, 1, text);
        assert.match(reply.text, /ПЕКАРА/u, text);
        assert.doesNotMatch(reply.text, /ТАРВИЯ|САНВИЯ|ВЕЛМОРА/u, text);
      }
    });

    await context.test("CASE5 New Year abroad lists the trips on the road at New Year first, and fares by age under the list are answered per trip", async () => {
      const opening = "Hello, ger buleeree gadaad temdegleh gesen ym. Shine jiliin uyeer ali ali ulsruu aylaltai bga ve?";
      const list = await say(fresh(), opening);
      assert.match(list.text, /^🎄 Шинэ жилийн үеэр гарах аяллууд \(12 сар – 1 сарын эхээр\):/u);
      assert.ok(list.text.indexOf("САНВИЯ - ХОРТ НИСЛЭГТЭЙ ШИНЭ ЖИЛИЙН АЯЛАЛ") > 0 && list.text.indexOf("САНВИЯ - ХОРТ НИСЛЭГТЭЙ ШИНЭ ЖИЛИЙН АЯЛАЛ") < list.text.indexOf("2. "),
        `the trip named for New Year is the first card: ${list.text}`);
      assert.doesNotMatch(list.text, /ШИНЖИЛГЭЭТЭЙ/u, "a medical-check trip is not a family New Year trip");
      assert.match(list.text, /✅ Шинэ жилийн өдрүүдийг хамарна/u);
      assert.ok(!dates(list.text).includes("12/1") && !dates(list.text).includes("12/3"), `the days that touch New Year, not the first of December: ${dates(list.text)}`);
      for (const text of ["4 bolon 7 nastai huuhed tulbur hed ve?", "4 болон 7 настай хүүхэд төлбөр хэд вэ", "хүүхэд 5 настай үнэ хэд вэ", "Хүүхэд 7 настай, төлбөр хэд вэ", "2 хүүхэдтэй үнэ хэд вэ"]) {
        const sender = fresh();
        const shown = await say(sender, opening);
        const fares = await say(sender, text);
        assert.equal(fares.sends.length, 1, `answered: ${text}`);
        assert.equal(fares.answerModelCalls, 0, `the answer model never re-asks a choice already on screen: ${text}`);
        for (const name of ["САНВИЯ - ХОРТ НИСЛЭГТЭЙ ШИНЭ ЖИЛИЙН АЯЛАЛ", "ВЕЛМОРА — ДОРНАН АЯЛАЛ", "САНВИЯ - ХОРТ НИСЛЭГТЭЙ - Мягмар гариг"]) {
          assert.ok(shown.text.includes(name) && fares.text.includes(name), `${text}: ${name} is on screen and priced`);
        }
        assert.match(fares.text, /x 3,990,000₮/u, `the listed trips' own child fares: ${text}`);
        assert.match(fares.text, /x 4,490,000₮/u, text);
        assert.match(fares.text, /x 2,690,000₮/u, text);
        assert.doesNotMatch(fares.text, /Ямар аяллыг сонирхож байгаагаа сонгоно уу/u, text);
      }
      // A party with adults is a total per trip; the dates under the fare card are the ones just listed.
      const sender = fresh();
      await say(sender, opening);
      const total = await say(sender, "2 том 2 хүүхэдтэй явбал нийт хэд вэ");
      assert.match(total.text, /16,560,000₮ \(2 том хүн \/12\+ нас\/ x 4,290,000₮ \+ 2 хүүхэд \/2-11 нас\/ x 3,990,000₮\)/u);
      const card = fresh();
      await say(card, opening);
      const cards = await say(card, "хүүхдийн үнэ хэд вэ");
      assert.match(cards.text, /ВЕЛМОРА — ДОРНАН АЯЛАЛ\n[^\n]*\n[^\n]*\n📅 12\/29\n/u, `the departure listed, not the earliest of the window: ${cards.text}`);
      assert.doesNotMatch(cards.text, /12\/12/u);
    });

    await context.test("CASE6 a quoted price, written any way, finds the trip sold at it (adult fares only)", async () => {
      for (const text of ["990000 geed bga yum", "990k", "990К", "990 мянгатай аялал байна уу", "990 мянга орчим", "990,000 гээд байсан", "990 мянган төгрөгийн аялал", "ene aylal 990k bgaa yu", "0.99 сая"]) {
        const reply = await say(fresh(), text);
        assert.equal(reply.sends.length, 1, `answered: ${text}`);
        assert.match(reply.text, /^990,000₮ үнэтэй тохирох аяллууд:/u, text);
        assert.match(reply.text, /ЖОРВИН-МИНИ ВАЛДА-ХОРТАН ХОТЫН АЯЛАЛ/u, text);
        assert.doesNotMatch(reply.text, /ЛОРНАН|Нярай|Хүүхэд/u, `child and infant fares ending in it are other trips' discounts: ${text}`);
        assert.match(reply.text, /Зарын постер эсвэл линкээ илгээвэл/u, `it does not claim to know the advert: ${text}`);
      }
      // After the New Year question of the same conversation.
      const sender = fresh();
      await say(sender, "Sain bnuu ene shine jiliin ayalal haashaa be");
      assert.match((await say(sender, "990000 geed bga yum")).text, /ЖОРВИН-МИНИ ВАЛДА/u);
      // A trip sold on a weekday schedule has no calendar date and is still found.
      const weekly = await say(fresh(), "880k");
      assert.match(weekly.text, /КОРДАН - МИРЕЛ[^\n]*гарах: Пүрэв, Ням гариг/u);
      // No trip sells exactly that: the amount is read as a budget, said so, and nothing is called "the advertised trip".
      for (const text of ["1 сая орчим", "1 саяын аялал байна уу"]) {
        const budget = await say(fresh(), text);
        assert.equal(budget.sends.length, 1, text);
        assert.match(budget.text, /^Таны хэлсэн 1 сая төгрөгтэй яг таарах аялал олдсонгүй\. 1 сая төгрөг хүртэлх аяллууд:/u, text);
        assert.match(budget.text, /ЖОРВИН-МИНИ ВАЛДА/u);
        assert.doesNotMatch(budget.text, /үнэтэй тохирох/u, text);
      }
      // A full digit string typed like an advert's price that no trip sells is not guessed at, and a phone number is no price.
      assert.equal((await say(fresh(), "1234567 geed bga yum")).sends.length, 0);
      assert.doesNotMatch((await say(fresh(), "99168432")).text, /хүртэлх аяллууд|үнэтэй тохирох/u);
    });

    await context.test("the owner's unseen sentences: a holiday with children, a date beside New Year, and a negated sibling", async () => {
      const children = await say(fresh(), "2027 оны цагаан сараар хүүхдүүдтэйгээ аялахад юу байна?");
      assert.equal(children.sends.length, 1);
      assert.match(children.text, WINDOW);
      assert.ok(dates(children.text).length > 0 && dates(children.text).every(inFebruaryWindow), `${dates(children.text)}`);
      const thirtieth = await say(fresh(), "Аяллыг 12 сарын 30-нд эхлээд шинэ он гарсны дараа буцахаар байна уу?");
      assert.match(thirtieth.text, /^12 сарын 30-нд гарах аяллууд/u);
      assert.deepEqual(dates(thirtieth.text), ["12/30", "12/30"], "the 30th the customer typed is the window, not December from the 1st");
      // The negation engine belongs to another stream: here only that a calendar change did not turn it into a holiday or month list.
      const negated = await say(fresh(), "Пекара үзмээр байна гэхдээ Торвин хэрэггүй.");
      assert.ok(negated.sends.length <= 1);
      assert.doesNotMatch(negated.text, /Цагаан сар|Шинэ жил|сард гарах/u);
    });

    await context.test("ordinary questions are still answered: a holiday trip with a place, a plain month, a plain date", async () => {
      const holiday = await say(fresh(), "Цагаан сарын үеэр Тарвия явж болох уу?");
      assert.match(holiday.text, /^🌙 Цагаан сарын үеэр \(2027 оны 2 сарын 6–9 орчим\) Тарвия чиглэлд аялах боломжтой аяллууд:/u);
      const month = await say(fresh(), "12 сард гарах аялал байна уу");
      assert.match(month.text, /^12 сард гарах аяллууд/u);
      assert.ok(dates(month.text).length > 0 && dates(month.text).every((date) => /^12\//.test(date)), `${dates(month.text)}`);
      const date = await say(fresh(), "12 сарын 30-нд гарах аялал байна уу");
      assert.match(date.text, /^Тийм ээ, 12 сарын 30-нд гарах аялал байна/u);
      assert.match(date.text, /ПЕКАРА - ТОРВИН ШУУД НИСЛЭГТЭЙ АЯЛАЛ[\s\S]*САНВИЯ - ХОРТ НИСЛЭГТЭЙ ШИНЭ ЖИЛИЙН АЯЛАЛ/u);
      const newYear = await say(fresh(), "Шинэ жилийн аялал");
      assert.match(newYear.text, /^🎄 Шинэ жилийн үеэр гарах аяллууд/u);
    });
  } finally {
    await harness.close();
  }
});
