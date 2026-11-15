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
