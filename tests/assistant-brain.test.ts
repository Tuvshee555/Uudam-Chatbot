import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { AIChangeProposal, TravelTrip } from "../src/lib/travelTypes";

applyTestEnv();

// The clock sits in November so "12/27" rolls to this coming December.
const NOW = new Date("2098-11-01T04:00:00Z");

function trip(fields: Partial<TravelTrip> & Pick<TravelTrip, "id" | "route_name">): TravelTrip {
  return {
    category: "", operator_name: "UUDAM TRAVEL AGENCY", duration_text: "8 өдөр 7 шөнө",
    adult_price: 4_290_000, child_price: 3_990_000, infant_price: 690_000, currency: "MNT",
    departure_dates: [], seats_total: null, seats_left: null, has_food: true, status: "active",
    notes: "", hotel: "", source_description: "", photo_urls: [], extra: {},
    created_at: "2098-10-01T00:00:00Z", updated_at: "2098-10-01T00:00:00Z", ...fields,
  };
}

const NORVEL = trip({
  id: "t-norvel", route_name: "ТУРШИЛТ – НОРВЕЛ ХОТЫН АЯЛАЛ",
  departure_dates: ["2098-12-27", "2098-12-28"],
  extra: {
    aliases: ["Norvel", "Норвэл"],
    website_departure_availability: [
      { date: "2098-12-27", status: "OPEN", seatsLeft: 12 },
      { date: "2098-12-28", status: "SOLD_OUT", seatsLeft: 0 },
    ],
  },
});
const NORVEL_NY = trip({ id: "t-norvel-ny", route_name: "НОРВЕЛ – ШИНЭ ЖИЛИЙН АЯЛАЛ", departure_dates: ["2098-12-29"], updated_at: "2098-10-20T00:00:00Z",
  extra: { website_departure_availability: [{ date: "2098-12-29", status: "OPEN", seatsLeft: 20 }] } });
const VELMOR = trip({
  id: "t-velmor", route_name: "ВЭЛМОР АРЛЫН АЯЛАЛ", adult_price: 5_290_000, child_price: 4_890_000, infant_price: 750_000,
  departure_dates: ["2098-11-18", "2098-12-02"],
  extra: {
    price_groups: [
      { label: "2098-11-18", dates: ["2098-11-18"], adult_price: 5_290_000, child_price: 4_890_000, infant_price: 750_000,
        passenger_prices: [
          { label: "Хүүхэд 7-13 нас", age_range: "7-13 нас", price: 4_890_000, currency: "MNT" },
          { label: "Хүүхэд 3-6 нас", age_range: "3-6 нас", price: 3_490_000, currency: "MNT" },
          { label: "Нярай 0-2 нас", age_range: "0-2 нас", price: 750_000, currency: "MNT" },
        ] },
      { label: "2098-12-02", dates: ["2098-12-02"], adult_price: 5_490_000, child_price: 4_890_000, infant_price: 750_000,
        passenger_prices: [
          { label: "Хүүхэд 7-13 нас", age_range: "7-13 нас", price: 4_890_000, currency: "MNT" },
          { label: "Хүүхэд 3-6 нас", age_range: "3-6 нас", price: 3_490_000, currency: "MNT" },
          { label: "Нярай 0-2 нас", age_range: "0-2 нас", price: 750_000, currency: "MNT" },
        ] },
    ],
  },
});
const GERMOL = trip({ id: "t-germol", route_name: "ГЭРМОЛ АЯЛАЛ", status: "archived", adult_price: null, child_price: null, infant_price: null });
const TRIPS = [NORVEL, NORVEL_NY, VELMOR, GERMOL];

test("the words of an instruction become one exact intent", async () => {
  const { parseIntent } = await import("../src/lib/assistantBrain");
  assert.deepEqual(parseIntent("Норвел 12/27 дүүрсэн", NOW), { kind: "date_state", state: "full", dates: ["2098-12-27"], allDates: false, wholeTrip: false });
  assert.deepEqual(parseIntent("норвел 12/28 цөөн суудал", NOW), { kind: "date_state", state: "low", dates: ["2098-12-28"], allDates: false, wholeTrip: false });
  assert.deepEqual(parseIntent("12/27-г буцааж нээ", NOW), { kind: "date_state", state: "open", dates: ["2098-12-27"], allDates: false, wholeTrip: false });
  assert.deepEqual(parseIntent("Norvel 12/27 duursen", NOW), { kind: "date_state", state: "full", dates: ["2098-12-27"], allDates: false, wholeTrip: false });
  assert.deepEqual(parseIntent("Норвел бүх өдөр дүүрсэн", NOW), { kind: "date_state", state: "full", dates: [], allDates: true, wholeTrip: false });
  assert.deepEqual(parseIntent("Норвел аяллыг цуцал", NOW), { kind: "status", status: "cancelled" });
  assert.deepEqual(parseIntent("Норвел түр зогсоо", NOW), { kind: "status", status: "paused" });
  assert.deepEqual(parseIntent("Гэрмол аяллыг идэвхжүүл", NOW), { kind: "status", status: "active" });
  assert.deepEqual(parseIntent("Гэрмол аяллыг устга", NOW), { kind: "archive" });
  assert.deepEqual(parseIntent("Вэлмор том хүн 5,390,000 хүүхэд 4,000,000 нярай 700,000", NOW),
    { kind: "price", change: { adult: { set: 5_390_000 }, child: { set: 4_000_000 }, infant: { set: 700_000 } }, mentioned: true });
  assert.deepEqual(parseIntent("Норвел хүүхэд 300k бага", NOW), { kind: "price", change: { child: { belowAdult: 300_000 } }, mentioned: true });
  assert.deepEqual(parseIntent("Норвел нярай үнэгүй", NOW), { kind: "price", change: { infant: { set: 0 } }, mentioned: true });
  assert.deepEqual(parseIntent("Норвел бүх үнэ +100k", NOW), { kind: "price", change: { everyone: 100_000 }, mentioned: true });
  assert.deepEqual(parseIntent("Норвел том хүний үнийг 200,000-аар нэм", NOW), { kind: "price", change: { adult: { delta: 200_000 } }, mentioned: true });
  assert.deepEqual(parseIntent("Норвел үнэ 4,390,000", NOW), { kind: "price", change: { adult: { set: 4_390_000 } }, mentioned: true });
  assert.deepEqual(parseIntent("Норвел үнийг өөрчил", NOW), { kind: "price", change: {}, mentioned: false });
  assert.deepEqual(parseIntent("Норвел үлдсэн суудал 5", NOW), { kind: "seats", seats_left: 5 });
  assert.deepEqual(parseIntent("Норвел нийт 30 суудал", NOW), { kind: "seats", seats_total: 30 });
  assert.deepEqual(parseIntent("Норвел хоолгүй болго", NOW), { kind: "food", has_food: false });
  assert.deepEqual(parseIntent("Норвел хоол багтсан", NOW), { kind: "food", has_food: true });
  assert.deepEqual(parseIntent("«ТУРШИЛТ – НОРВЕЛ ХОТЫН АЯЛАЛ» нэрийг «НОРВЕЛ ХОТЫН АЯЛАЛ (ХУДАЛДАА)» болго", NOW), { kind: "rename", name: "НОРВЕЛ ХОТЫН АЯЛАЛ (ХУДАЛДАА)" });
  assert.deepEqual(parseIntent("Норвел 12/30 гаралт нэм", NOW), { kind: "dates", add: ["2098-12-30"], remove: [] });
  assert.deepEqual(parseIntent("Норвел 12/27-г хас", NOW), { kind: "dates", add: [], remove: ["2098-12-27"] });
  assert.deepEqual(parseIntent("Норвел буудал: Нордик 5* эсвэл Сиа 4*", NOW), { kind: "hotel", hotel: "Нордик 5* эсвэл Сиа 4*" });
  assert.equal(parseIntent("Норвел аяллын хөтөлбөрийг Word файлаас шинэчил", NOW).kind, "unknown");
});

test("a trip is found from an id token, a quoted name, a loose name, an archived name, or the conversation", async () => {
  const { resolveTrip } = await import("../src/lib/assistantBrain");
  assert.deepEqual(resolveTrip("12/27 дүүрсэн [аялал: «x» trip_id=t-velmor]", TRIPS), { kind: "certain", trip: VELMOR, how: "id" });
  assert.deepEqual(resolveTrip("«ТУРШИЛТ – НОРВЕЛ ХОТЫН АЯЛАЛ» цуцал", TRIPS), { kind: "certain", trip: NORVEL, how: "quoted" });
  const alias = resolveTrip("Norvel хоолгүй", TRIPS);
  assert.equal(alias.kind, "certain", "an alias in Latin names its trip even though every Norvel trip sounds the same");
  if (alias.kind === "certain") assert.equal(alias.trip.id, "t-norvel");
  const velmor = resolveTrip("вэлмор том хүн 5,390,000", TRIPS);
  assert.equal(velmor.kind, "certain");
  if (velmor.kind === "certain") assert.equal(velmor.trip.id, "t-velmor");
  const archived = resolveTrip("гэрмол аяллыг идэвхжүүл", TRIPS);
  assert.equal(archived.kind, "certain");
  if (archived.kind === "certain") assert.equal(archived.trip.id, "t-germol");
  const loose = resolveTrip("норвел цуцал", TRIPS);
  assert.equal(loose.kind, "ambiguous", "two Norvel trips share the word");
  if (loose.kind === "ambiguous") assert.deepEqual(loose.candidates.map((t) => t.id).sort(), ["t-norvel", "t-norvel-ny"]);
  const byDate = resolveTrip("норвел 12/29 дүүрсэн", TRIPS, { now: NOW });
  assert.equal(byDate.kind, "certain", "only one Norvel trip departs on 12/29");
  if (byDate.kind === "certain") assert.equal(byDate.trip.id, "t-norvel-ny");
  const byWord = resolveTrip("норвел шинэ жил цуцал", TRIPS);
  assert.equal(byWord.kind, "certain", "«шинэ» belongs to one of the two names");
  if (byWord.kind === "certain") assert.equal(byWord.trip.id, "t-norvel-ny");
  const followUp = resolveTrip("бас 12/28-ийг дүүрсэн болго", TRIPS, { context: "Админ: норвел 12/27 дүүрсэн\nAI: «ТУРШИЛТ – НОРВЕЛ ХОТЫН АЯЛАЛ» — 12-р сарын 27-ны өдрийг «Дүүрсэн» болгоно." });
  assert.deepEqual(followUp, { kind: "certain", trip: NORVEL, how: "context" });
  assert.deepEqual(resolveTrip("энэ аяллын үнийг 4,390,000 болго", TRIPS, { context: "AI: «ВЭЛМОР АРЛЫН АЯЛАЛ» — үлдсэн суудал 10 → 5." }), { kind: "certain", trip: VELMOR, how: "context" });
  assert.deepEqual(resolveTrip("цуцал", TRIPS), { kind: "none" });
});

test("one departure day sold out: an exact per-date action, never the whole trip", async () => {
  const { think } = await import("../src/lib/assistantBrain");
  const out = think({ text: "«ТУРШИЛТ – НОРВЕЛ ХОТЫН АЯЛАЛ» 12/27 дүүрсэн", trips: TRIPS, now: NOW });
  assert.equal(out.kind, "proposal");
  if (out.kind !== "proposal") return;
  assert.deepEqual(out.proposal.actions, [{ action: "set_date_state", trip_id: "t-norvel", date: "2098-12-27", state: "full" }]);
  assert.match(out.proposal.summary, /12-р сарын 27.*Дүүрсэн/);
  assert.equal(out.proposal.needs_confirmation, true);
});

test("a day already in that state is a note, not a proposal; every day is one action per date", async () => {
  const { think } = await import("../src/lib/assistantBrain");
  const same = think({ text: "«ТУРШИЛТ – НОРВЕЛ ХОТЫН АЯЛАЛ» 12/28 дүүрсэн", trips: TRIPS, now: NOW });
  assert.equal(same.kind, "note");
  const all = think({ text: "«ТУРШИЛТ – НОРВЕЛ ХОТЫН АЯЛАЛ» бүх өдөр дүүрсэн", trips: TRIPS, now: NOW });
  assert.equal(all.kind, "proposal");
  if (all.kind === "proposal") {
    assert.deepEqual(all.proposal.actions.map((a) => a.date), ["2098-12-27"], "12/28 was already full");
    assert.ok(all.proposal.conflict_items?.some((item) => item.type === "date_state_same"));
  }
});

test("no date named: the assistant asks which day, with the trip's real days and their current state", async () => {
  const { think } = await import("../src/lib/assistantBrain");
  const out = think({ text: "«ТУРШИЛТ – НОРВЕЛ ХОТЫН АЯЛАЛ» дүүрсэн", trips: TRIPS, now: NOW });
  assert.equal(out.kind, "ask");
  if (out.kind !== "ask") return;
  assert.equal(out.ask.id, "date");
  assert.deepEqual(out.ask.options.map((o) => o.label), ["12-р сарын 27 (Бямба)", "12-р сарын 28 (Ням)", "Бүх өдөр"]);
  assert.deepEqual(out.ask.options.map((o) => o.hint), ["Нээлттэй", "Дүүрсэн", undefined]);
  // Tapping a day carries the whole instruction back and yields the exact proposal.
  const next = think({ text: out.ask.options[0].answer, trips: TRIPS, now: NOW });
  assert.equal(next.kind, "proposal");
  if (next.kind === "proposal") assert.deepEqual(next.proposal.actions[0], { action: "set_date_state", trip_id: "t-norvel", date: "2098-12-27", state: "full" });
});

test("a day the trip does not have: the assistant says so and offers the days it has", async () => {
  const { think } = await import("../src/lib/assistantBrain");
  const out = think({ text: "«ТУРШИЛТ – НОРВЕЛ ХОТЫН АЯЛАЛ» 12/22 дүүрсэн", trips: TRIPS, now: NOW });
  assert.equal(out.kind, "ask");
  if (out.kind === "ask") {
    assert.match(out.ask.text, /12-р сарын 22 гарах өдөр алга/);
    assert.deepEqual(out.ask.options.map((o) => o.label), ["12-р сарын 27 (Бямба)", "12-р сарын 28 (Ням)"]);
  }
});

test("a loose name shared by two trips: one question with both trips as choices, and the tap resolves it", async () => {
  const { think, tripIdFromText } = await import("../src/lib/assistantBrain");
  const out = think({ text: "норвел хоолгүй", trips: TRIPS, now: NOW });
  assert.equal(out.kind, "ask");
  if (out.kind !== "ask") return;
  assert.equal(out.ask.id, "trip");
  assert.deepEqual(out.ask.options.map((o) => o.label).sort(), ["НОРВЕЛ – ШИНЭ ЖИЛИЙН АЯЛАЛ", "ТУРШИЛТ – НОРВЕЛ ХОТЫН АЯЛАЛ"]);
  assert.ok(out.ask.options.every((o) => /дараагийн гаралт/.test(o.hint || "")), "each choice shows its next departure");
  const chosen = out.ask.options.find((o) => o.label === "ТУРШИЛТ – НОРВЕЛ ХОТЫН АЯЛАЛ")!;
  assert.equal(tripIdFromText(chosen.answer), "t-norvel");
  const next = think({ text: chosen.answer, trips: TRIPS, now: NOW });
  assert.equal(next.kind, "proposal");
  if (next.kind === "proposal") assert.deepEqual(next.proposal.actions[0], { action: "patch", trip_id: "t-norvel", fields: { has_food: false } });
});

test("no trip named at all: the assistant asks for the trip, offering the recently edited ones", async () => {
  const { think } = await import("../src/lib/assistantBrain");
  const out = think({ text: "цуцал", trips: TRIPS, now: NOW });
  assert.equal(out.kind, "ask");
  if (out.kind === "ask") {
    assert.equal(out.ask.id, "trip");
    assert.ok(out.ask.allow_custom);
    assert.ok(!out.ask.options.some((o) => o.label === GERMOL.route_name), "archived trips are not offered");
  }
});

test("a price change reaches the base fare and every dated price row", async () => {
  const { think } = await import("../src/lib/assistantBrain");
  const out = think({ text: "Вэлмор том хүн 5,390,000", trips: TRIPS, now: NOW });
  assert.equal(out.kind, "proposal");
  if (out.kind !== "proposal") return;
  const fields = out.proposal.actions[0].fields!;
  assert.equal(fields.adult_price, 5_390_000);
  const groups = (fields.extra as { price_groups: Array<Record<string, unknown>> }).price_groups;
  assert.deepEqual(groups.map((g) => g.adult_price), [5_390_000, 5_390_000]);
  assert.match(out.proposal.summary, /том хүн 5,290,000₮ → 5,390,000₮/);
});

test("a child fare given relative to the adult fare, and a blanket shift that leaves a free fare free", async () => {
  const { think } = await import("../src/lib/assistantBrain");
  const relative = think({ text: "«ТУРШИЛТ – НОРВЕЛ ХОТЫН АЯЛАЛ» хүүхэд 400k бага", trips: TRIPS, now: NOW });
  assert.equal(relative.kind, "proposal");
  if (relative.kind === "proposal") assert.deepEqual(relative.proposal.actions[0].fields, { child_price: 3_890_000 });
  const same = think({ text: "«ТУРШИЛТ – НОРВЕЛ ХОТЫН АЯЛАЛ» хүүхэд 300k бага", trips: TRIPS, now: NOW });
  assert.equal(same.kind, "note", "the child fare is already 300k below the adult fare");
  const free = trip({ id: "t-free", route_name: "СОЛТЕН АЯЛАЛ", adult_price: 1_000_000, child_price: 800_000, infant_price: 0 });
  const shift = think({ text: "Солтен бүх үнэ +100k", trips: [free], now: NOW });
  assert.equal(shift.kind, "proposal");
  if (shift.kind === "proposal") assert.deepEqual(shift.proposal.actions[0].fields, { adult_price: 1_100_000, child_price: 900_000 });
});

test("two child age tiers on a price row are not guessed: the row keeps its tiers and the admin is told", async () => {
  const { think } = await import("../src/lib/assistantBrain");
  const out = think({ text: "Вэлмор хүүхэд 4,000,000", trips: TRIPS, now: NOW });
  assert.equal(out.kind, "proposal");
  if (out.kind !== "proposal") return;
  const fields = out.proposal.actions[0].fields!;
  assert.equal(fields.child_price, 4_000_000, "the trip-level child fare follows the instruction");
  assert.equal(fields.extra, undefined, "the dated rows with two child tiers are left as they are");
  assert.ok(out.proposal.conflict_items?.some((item) => /насны ангилал/.test(item.text)), "and the admin is told why");
});

test("a price change with no amount asks for it, showing the current fares", async () => {
  const { think } = await import("../src/lib/assistantBrain");
  const out = think({ text: "«ТУРШИЛТ – НОРВЕЛ ХОТЫН АЯЛАЛ» үнийг өөрчил", trips: TRIPS, now: NOW });
  assert.equal(out.kind, "ask");
  if (out.kind === "ask") {
    assert.equal(out.ask.id, "amount");
    assert.match(out.ask.text, /4,290,000₮/);
    assert.ok(out.ask.allow_custom);
  }
});

test("cancel, archive, seats, meals, rename and schedule edits are exact patches of the one trip", async () => {
  const { think } = await import("../src/lib/assistantBrain");
  const cancel = think({ text: "«ТУРШИЛТ – НОРВЕЛ ХОТЫН АЯЛАЛ» цуцал", trips: TRIPS, now: NOW });
  assert.ok(cancel.kind === "proposal" && cancel.proposal.actions[0].action === "cancel");
  const archive = think({ text: "Вэлмор аяллыг устга", trips: TRIPS, now: NOW });
  assert.ok(archive.kind === "proposal" && archive.proposal.actions[0].action === "delete" && /архивлана/.test(archive.proposal.summary));
  const seats = think({ text: "Вэлмор үлдсэн суудал 5", trips: TRIPS, now: NOW });
  assert.ok(seats.kind === "proposal" && seats.proposal.actions[0].fields?.seats_left === 5);
  const food = think({ text: "Вэлмор хоолгүй", trips: TRIPS, now: NOW });
  assert.ok(food.kind === "proposal" && food.proposal.actions[0].fields?.has_food === false);
  const rename = think({ text: "«ВЭЛМОР АРЛЫН АЯЛАЛ» нэрийг «ВЭЛМОР АРЛЫН ШИНЭ ЖИЛИЙН АЯЛАЛ» болго", trips: TRIPS, now: NOW });
  assert.ok(rename.kind === "proposal");
  if (rename.kind === "proposal") {
    assert.equal(rename.proposal.actions[0].fields?.route_name, "ВЭЛМОР АРЛЫН ШИНЭ ЖИЛИЙН АЯЛАЛ");
    assert.deepEqual((rename.proposal.actions[0].fields?.extra as { aliases: string[] }).aliases, ["ВЭЛМОР АРЛЫН АЯЛАЛ"], "the old name stays searchable");
  }
  const add = think({ text: "Вэлмор 12/16 гаралт нэм", trips: TRIPS, now: NOW });
  assert.ok(add.kind === "proposal");
  if (add.kind === "proposal") {
    const fields = add.proposal.actions[0].fields!;
    assert.deepEqual(fields.departure_dates, ["2098-11-18", "2098-12-02", "2098-12-16"]);
    const groups = (fields.extra as { price_groups: Array<{ dates: string[] }> }).price_groups;
    assert.deepEqual(groups[1].dates, ["2098-12-02", "2098-12-16"], "the new day joins its nearest date's price row");
  }
  const remove = think({ text: "Вэлмор 11/18-г хас", trips: TRIPS, now: NOW });
  assert.ok(remove.kind === "proposal");
  if (remove.kind === "proposal") {
    const fields = remove.proposal.actions[0].fields!;
    assert.deepEqual(fields.departure_dates, ["2098-12-02"]);
    assert.equal((fields.extra as { price_groups: unknown[] }).price_groups.length, 1, "a row with no date left is dropped");
  }
  const already = think({ text: "Гэрмол аяллыг устга", trips: TRIPS, now: NOW });
  assert.equal(already.kind, "note");
});

test("what the brain does not understand goes to the model with the trips it concerns", async () => {
  const { think } = await import("../src/lib/assistantBrain");
  const out = think({ text: "Вэлмор аяллын хөтөлбөрийн 3 дахь өдрийг дахин бич", trips: TRIPS, now: NOW });
  assert.equal(out.kind, "defer");
  if (out.kind === "defer") assert.deepEqual(out.focus.map((t) => t.id), ["t-velmor"]);
});

test("a model action that only names its trip is bound in code, or turned into a question that a tap answers", async () => {
  const { bindActionTargets, applyTripChoice } = await import("../src/lib/assistantBrain");
  const clear: AIChangeProposal = { summary: "", needs_confirmation: false, important_reason: "", conflicts: [], conflict_items: [],
    actions: [{ action: "patch", match: { route_name: "Вэлмор арлын аялал" }, fields: { seats_left: 3 } }] };
  assert.deepEqual(bindActionTargets(clear, TRIPS, NOW), { bound: 1, asked: 0 });
  assert.deepEqual(clear.actions, [{ action: "patch", trip_id: "t-velmor", match: undefined, fields: { seats_left: 3 } }]);

  const vague: AIChangeProposal = { summary: "", needs_confirmation: false, important_reason: "", conflicts: ["«Норвел» нэртэй төстэй 2 аялал байна"],
    conflict_items: [{ text: "«Норвел» нэртэй төстэй 2 аялал байна", severity: "blocker" }],
    actions: [{ action: "patch", match: { route_name: "Норвел" }, fields: { seats_left: 3 } }] };
  assert.deepEqual(bindActionTargets(vague, TRIPS, NOW), { bound: 0, asked: 1 });
  assert.equal(vague.actions.length, 0, "the action waits inside the question");
  assert.equal(vague.questions?.length, 1);
  assert.equal(vague.conflict_items?.length, 0, "the validator's blocker is replaced by the question");
  const option = vague.questions![0].options.find((o) => o.label === "НОРВЕЛ – ШИНЭ ЖИЛИЙН АЯЛАЛ")!;
  assert.equal(applyTripChoice(option.answer, vague, TRIPS), true);
  assert.deepEqual(vague.actions, [{ action: "patch", trip_id: "t-norvel-ny", match: undefined, fields: { seats_left: 3 } }]);
  assert.equal(vague.questions, undefined);
});
