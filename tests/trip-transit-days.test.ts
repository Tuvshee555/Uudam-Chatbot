import assert from "node:assert/strict";
import test from "node:test";
import {
  STANDARD_DAYS, detectTransportType, durationForDays, isTransitDay, stripStandardTransitDays, withStandardTransitDays,
} from "../src/lib/tripTransitDays";

// A partner's program as its Word file writes it: begins and ends at the border town
// (invented destinations), flights inside the country.
const partnerDays = () => [
  { day: 1, title: "Эрээн – Норвел", description: "Эрээн авто вокзал дээр аялагчдыг тосно. Өдрийн хоол. Норвел хотоос 22:05 цагт нисээд 00:25 цагт бууна.", meals: { breakfast: false, lunch: true, dinner: false } },
  { day: 2, title: "Норвел хот", description: "Хотын төвийн үзвэрүүдээр аялна. Лумиа гүүр, хуучин хороолол.", hotel: "Норвел 4* буудал", meals: { breakfast: true, lunch: true, dinner: true } },
  { day: 3, title: "Норвел – Эрээн", description: "Өглөө нисээд 13:25 цагт Эрээнд ирнэ.", meals: { breakfast: true, lunch: false, dinner: false } },
];

test("a partner program that starts at the border gains the train day, the border crossing and the arrival day", () => {
  const { days, added } = withStandardTransitDays(partnerDays(), "land_flight");
  assert.equal(added, 2, "two days: the train out and the arrival morning");
  assert.equal(days.length, 5);
  assert.deepEqual([days[0].title, days[0].description], [STANDARD_DAYS.departure.title, STANDARD_DAYS.departure.description]);
  assert.equal(days[1].title, "ЗАМЫН ҮҮД – Эрээн – Норвел");
  assert.ok(days[1].description!.startsWith(STANDARD_DAYS.borderInbound), "the program's first day opens with the train arrival and the border");
  assert.match(days[1].description!, /Эрээн авто вокзал/, "the partner's own text is kept");
  assert.ok(days[3].description!.endsWith(STANDARD_DAYS.borderOutboundSameDay), "the day that reaches Erenhot crosses back the same day");
  assert.deepEqual([days[4].title, days[4].description], [STANDARD_DAYS.arrival.title, STANDARD_DAYS.arrival.description]);
  assert.deepEqual(days.map((day) => day.day), [1, 2, 3, 4, 5]);
  assert.deepEqual(durationForDays(days.length), { duration_days: 5, duration_nights: 4, duration_text: "5 өдөр 4 шөнө" });
  assert.deepEqual(days.filter(isTransitDay).map((day) => day.day), [1, 5]);
});

test("a program whose last night is spent at the border gets the border day of its own, breakfast only", () => {
  const program = partnerDays();
  program[2] = { day: 3, title: "Чөлөөт өдөр", description: "Дэлгүүр хэсэх чөлөөт өдөр.", meals: { breakfast: true, lunch: false, dinner: false } };
  const { days, added } = withStandardTransitDays(program, "land");
  assert.equal(added, 3);
  assert.deepEqual([days[4].title, days[4].meals], [STANDARD_DAYS.borderOutbound.title, { breakfast: true, lunch: false, dinner: false }]);
  assert.equal(days[5].title, STANDARD_DAYS.arrival.title);
});

test("rebuilding is idempotent, and another transport type replaces the generated days instead of stacking them", () => {
  const once = withStandardTransitDays(partnerDays(), "land_flight").days;
  const twice = withStandardTransitDays(once, "land_flight");
  assert.deepEqual(twice.days, once, "the generated days are replaced, never stacked");
  assert.equal(twice.added, 2, "and still counted as generated");
  assert.deepEqual(stripStandardTransitDays(once).map((day) => [day.title, day.description]), partnerDays().map((day) => [day.title, day.description]));
  const flight = withStandardTransitDays(once, "direct_flight");
  assert.equal(flight.days.length, 3, "no train days on a flight");
  assert.ok(flight.days[0].description!.startsWith(STANDARD_DAYS.flightDeparture));
  assert.ok(flight.days[2].description!.endsWith(STANDARD_DAYS.flightArrival));
  assert.equal(withStandardTransitDays(flight.days, "cruise").days.length, 5, "and back to the train for a cruise");
});

test("a program already written from Ulaanbaatar is left as it is", () => {
  const days = [
    { title: "УЛААНБААТАР – НОРВЕЛ", description: "Чингис Хаан олон улсын нисэх буудалд цуглаж 23:05 цагт хөөрнө." },
    { title: "НОРВЕЛ", description: "Хотын аялал." },
    { title: "НОРВЕЛ – УЛААНБААТАР", description: "Өглөө нисч Улаанбаатар хотод газардсанаар аялал өндөрлөнө." },
  ];
  const flight = withStandardTransitDays(days, "direct_flight");
  assert.equal(flight.added, 0);
  assert.deepEqual(flight.days.map((day) => day.description), days.map((day) => day.description));
});

test("the transport type is read from the program", () => {
  assert.deepEqual(detectTransportType({ title: "НОРВЕЛ ХОТЫН АЯЛАЛ", days: partnerDays() }), { transport: "land_flight", sure: true });
  assert.deepEqual(detectTransportType({ title: "НОРВЕЛ ХОТЫН АЯЛАЛ", days: [{ title: "Улаанбаатар – Норвел", description: "Чингис хаан олон улсын нисэх буудлаас оройн 17:55 цагт хөөрнө." }] }), { transport: "direct_flight", sure: true });
  assert.deepEqual(detectTransportType({ title: "НОРВЕЛ – ЛУМИА УСАН ОНГОЦНЫ АЯЛАЛ", days: partnerDays() }), { transport: "cruise", sure: true });
  assert.deepEqual(detectTransportType({ title: "Лумиа", days: [{ title: "Эрээн – Лумиа", description: "Эрээнээс автобусаар Лумиа хот руу явна." }, { title: "Лумиа", description: "Хотын аялал." }] }), { transport: "land", sure: true });
  assert.deepEqual(detectTransportType({ title: "Лумиа", transportType: "cruise", days: partnerDays() }), { transport: "cruise", sure: true }, "a stated type wins");
  assert.equal(detectTransportType({ title: "Лумиа", days: [{ title: "Лумиа", description: "Хотын аялал." }] }).sure, false, "nothing to go on: a guess the admin confirms");
});

test("the model's transport is a hint: a first day that plainly leaves Ulaanbaatar by air or by train decides", () => {
  const flyOut = [{ title: "УЛААНБААТАР – НОРВЕЛ", description: "Улаанбаатар – Норвел чиглэлийн шууд нислэгээр аяллаа эхлүүлнэ." }];
  assert.deepEqual(detectTransportType({ title: "НОРВЕЛ", days: flyOut, transportType: "land_flight" }), { transport: "direct_flight", sure: false });
  assert.deepEqual(detectTransportType({ title: "НОРВЕЛ", days: flyOut, transportType: "direct_flight" }), { transport: "direct_flight", sure: true });
  assert.deepEqual(detectTransportType({ title: "НОРВЕЛ", days: partnerDays(), transportType: "direct_flight" }), { transport: "land_flight", sure: false });
  // A first day that says nothing about how the trip leaves keeps the model's reading.
  assert.deepEqual(detectTransportType({ title: "НОРВЕЛ", days: [{ title: "НОРВЕЛ ХОТ", description: "Хотын аялал." }], transportType: "land_flight" }), { transport: "land_flight", sure: true });
});

test("the admin's transport choice beats the program reading, and the marker is never saved", async () => {
  assert.deepEqual(detectTransportType({ title: "НОРВЕЛ", days: partnerDays(), transportType: "direct_flight", chosen: true }), { transport: "direct_flight", sure: true });
  const { withoutReviewOnly } = await import("../src/lib/tripReview");
  const saved = withoutReviewOnly({ route_name: "НОРВЕЛ", extra: { transport_type: "direct_flight", transport_chosen: true } });
  assert.deepEqual(saved.extra, { transport_type: "direct_flight" });
});

test("a last day that crosses the border itself only gains its train; a bus home can be dropped for the train return", async () => {
  const { STANDARD_DAYS, stripStandardTransitDays, withStandardTransitDays, withoutBusReturn } = await import("../src/lib/tripTransitDays");
  const partner = [
    { day: 1, title: "Эрээн – Норвел", description: "Эрээн хотод аялагчдаа тосно. Эрээн → Норвел (4–5 цаг).", meals: { breakfast: null, lunch: null, dinner: true } },
    { day: 2, title: "Норвел – Эрээн", description: "Өглөөний цай. Норвел → Эрээн (4–5 цаг).", meals: { breakfast: true, lunch: null, dinner: true } },
    { day: 3, title: "Эрээн – Замын-Үүд", description: "Өглөөний цай\n13:00 – Замын-Үүд хил гарах\nАвтобусандаа сууж Улаанбаатар буцна", meals: { breakfast: true, lunch: null, dinner: null } },
  ];
  // As the file writes it, the trip "ends in Ulaanbaatar" by bus: only the departure day is added.
  const byBus = withStandardTransitDays(partner, "land");
  assert.equal(byBus.added, 1);
  assert.equal(byBus.days.length, 4);

  const byTrain = withStandardTransitDays(withoutBusReturn(partner), "land");
  assert.equal(byTrain.added, 2, "the train day out and the arrival morning");
  assert.equal(byTrain.days.length, 5);
  const border = byTrain.days[3];
  assert.equal(border.description, `Өглөөний цай\n13:00 – Замын-Үүд хил гарах\n${STANDARD_DAYS.trainHome}`, "the day keeps its own lines; no second border crossing is written");
  assert.doesNotMatch(String(border.description), /Автобусандаа|Эрээнд ирээд/);
  assert.equal(byTrain.days[4].description, STANDARD_DAYS.arrival.description);

  // Rebuilding starts from the program itself: the same days again, never a second train line.
  assert.deepEqual(withStandardTransitDays(byTrain.days, "land").days, byTrain.days);
  assert.equal(stripStandardTransitDays(byTrain.days).at(-1)?.description, "Өглөөний цай\n13:00 – Замын-Үүд хил гарах");
  // A last day that only reaches the border town still gets the whole standard ending.
  const reaches = withStandardTransitDays(partner.slice(0, 2), "land");
  assert.equal(reaches.days.at(-2)?.description, `Өглөөний цай. Норвел → Эрээн (4–5 цаг).\n${STANDARD_DAYS.borderOutboundSameDay}`);
  // No bus line, nothing changes; an arrival written by other means stays.
  const untouched = partner.slice(0, 2);
  assert.equal(withoutBusReturn(untouched), untouched);
  const flown = [{ day: 1, title: "Норвел – Улаанбаатар", description: "Норвелээс нисээд Улаанбаатарт 21:10 цагт ирснээр аялал өндөрлөнө." }];
  assert.deepEqual(withoutBusReturn(flown), flown);
});
