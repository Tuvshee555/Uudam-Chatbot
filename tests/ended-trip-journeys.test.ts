import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { conversationGateHarness, type FixtureTrip, type ModelOverride } from "./helpers/conversationGateHarness";
import { textOf, trip } from "./helpers/understandingRoutingFixtures";

/**
 * Live 2026-11-22. A customer shared the Page's own post of a trip whose only departure had just passed, then
 * asked "is this trip on in February?" and named it twice. The bot never answered about that trip: silence for the
 * post (its selling words read as booking-term questions, its company phone numbers as the customer's phone), a
 * list of unrelated February trips, a Hainan date list, another Shanghai trip's "this trip is full" twice, and
 * "Энэ чиглэлд 2 сард гарах аялал алга" while a trip of that direction left in February.
 *
 * Owner's rule: answer about the trip the customer asks about first; an ended trip stays and the bot says its dates
 * have ended and that a group of ten or more can still go on a date they choose; other trips come last.
 * Every trip and place below is invented.
 */
const SLUG = "norvel-lunariya-haalga-shuud-nislegtei";
const ENDED_NAME = "НОРВЕЛ + ЛУНАРИЯ ХААЛГА шууд нислэгтэй аялал ( Калдара - Орвел )";
const POST = [
  "🏙️✨ НОРВЕЛ + ЛУНАРИЯ ХААЛГА + ОРВЕЛ ЕРТӨНЦ",
  "✈️ УЛААНБААТАРААС ШУУД НИСЛЭГТЭЙ!",
  "Нэг аяллаар Норвел хот, Калдарагийн уулс, Орвелийн ертөнцөөр аялах боломж! 🌏",
  "📅 ЯВАХ ОГНОО: 11-р сарын 19",
  "⏳ 8 өдөр, 7 шөнө",
  "💰 Том хүн — 3,111,000₮",
  "🏔️ Лунария хаалга — уулсын дундах байгалийн хаалга.",
  "🎡 Чөлөөт өдөр — хүсвэл Диснейлэнд зэрэг газруудаар өөрийн зардлаар.",
  "🔥 ЦӨӨН СУУДАЛ ҮЛДСЭН!",
  "📞 ЗАХИАЛГА, ЛАВЛАХ: 9117-2700 | 8913-6600",
  `🌐 Дэлгэрэнгүй хөтөлбөр, захиалга: https://uudamtravel.mn/mn/trips/${SLUG}`,
].join("\n");

function catalogue(ended: boolean): FixtureTrip[] {
  const norvel = { extra: { destinations: ["Норвел"], aliases: ["Norvel"] } };
  return [
    ended
      ? trip("e1", ENDED_NAME, ["2097-11-19"], [3_111_000, 2_811_000, 791_000], { status: "archived", extra: {
        archived_reason: "all_departure_dates_passed", destinations: ["Норвел", "Калдара"], aliases: ["Лунария хаалга", "Kaldara"],
        departure_dates_resolved: [{ ymd: "2097-11-19", text: "2097-11-19" }], website_slug: SLUG, website_published: false } })
      : trip("e1", ENDED_NAME, ["2098-01-21"], [3_111_000, 2_811_000, 791_000], { extra: {
        destinations: ["Норвел", "Калдара"], aliases: ["Лунария хаалга", "Kaldara"], website_slug: SLUG, website_published: true } }),
    // Every departure full on the website: the bot reads it as a sold-out trip.
    trip("n11", "УБ-Норвел хотын 11-р сарын аяллын хөтөлбөр", ["2097-11-12", "2097-11-26"], [2_491_000, 1_991_000, null], { extra: {
      ...norvel.extra, website_departure_availability: [{ date: "2097-11-12", status: "CANCELLED", seatsLeft: null }, { date: "2097-11-26", status: "SOLD_OUT", seatsLeft: null }] } }),
    trip("n12", "УБ-Норвел хотын 12-р сарын аяллын хөтөлбөр", ["2097-12-22"], [2_491_000, 1_991_000, null], norvel),
    trip("n123", "УБ-Норвел хотын 1,2,3-р сарын аяллын хөтөлбөр", ["2098-01-14", "2098-01-28", "2098-02-18", "2098-03-06"], [2_991_000, 2_491_000, null], norvel),
    trip("lun", "ЛУНАРИЯ ХААЛГАНЫ ГАЗАР НИСЛЭГ ХОСОЛСОН АЯЛАЛ ( Калдара - Орвел )", ["2097-12-01", "2097-12-15"], [2_251_000, 1_951_000, null],
      { extra: { destinations: ["Сандор", "Калдара"], aliases: ["Лунария хаалга", "Kaldara"] } }),
    // February trips of other directions: never offered before the customer's own direction.
    trip("vel", "ВЭЛМОР ДАЛАЙН ЭРГИЙН АЯЛАЛ", ["2098-02-01", "2098-02-08"], [4_191_000, 3_691_000, null], { extra: { destinations: ["Вэлмор"] } }),
    trip("san", "САНДРИЯ АРЛЫН АЯЛАЛ", ["2098-02-03", "2098-02-10"], [3_891_000, 3_391_000, null], { extra: { destinations: ["Сандрия"] } }),
  ];
}

const readings: Array<[string, ModelOverride]> = [
  ["the model gives no help", {}],
  ["the model is unavailable", { unavailable: true }],
];
const OTHER_DIRECTIONS = /ВЭЛМОР|САНДРИЯ/u;
/** The reply's own lines: not blank, not the follow-up question or phone ask other features append (owner-requested). */
const ownLines = (said: string) => said.split("\n").filter((line) => line.trim() && !/(?:таалагдаж|сонирхож|тохирох) байна вэ|утасны дугаараа/iu.test(line)).length;

async function conversation(context: TestContext, ended: boolean) {
  const harness = await conversationGateHarness(context);
  context.mock.timers.setTime(Date.parse("2097-11-22T03:41:00Z"));
  harness.catalog(catalogue(ended));
  return harness;
}

test("an ended trip's shared post and every follow-up are answered about that trip, other trips last", async (outer) => {
  for (const [label, model] of readings) await outer.test(label, async (context) => {
    const harness = await conversation(context, true);
    const sender = `ended-${label}`;
    const say = async (text: string) => {
      const result = await harness.turn(sender, text, model, undefined, { platform: "facebook" });
      context.mock.timers.tick(30_000);
      return { ...result, said: textOf(result.sends) };
    };
    try {
      const post = await say(POST);
      assert.equal(post.sends.length, 1, `${label}: the shared post is answered, not silenced: ${post.said}`);
      assert.ok(post.said.startsWith(`${ENDED_NAME} — аялал дууссан.\n`), `${label}: ${post.said}`);
      assert.match(post.said, /10\+ хүнтэй байгууллага, групп бол өөрсдийн сонгосон өдрөөр явж болно/u);
      // Two open trips of the same direction, soonest first: the customer asked about one trip, not for a catalogue.
      for (const open of ["ЛУНАРИЯ ХААЛГАНЫ ГАЗАР", "УБ-Норвел хотын 12-р сарын"]) assert.ok(post.said.includes(open), `${label}: ${open}: ${post.said}`);
      assert.ok(!post.said.includes("УБ-Норвел хотын 1,2,3-р сарын"), `${label}: at most two: ${post.said}`);
      assert.ok(post.said.indexOf("10+ хүнтэй") < post.said.indexOf("Ижил чиглэлд нээлттэй:"), `${label}: the trip first, other trips last`);
      // As short as a consultant writes it (owner, 2026-11-22: "the bot sends too much").
      assert.ok(ownLines(post.said) <= 6, `${label}: short: ${post.said}`);
      assert.doesNotMatch(post.said, OTHER_DIRECTIONS);
      assert.doesNotMatch(post.said, /суудал дууссан/u, `${label}: never another trip's "full"`);
      assert.ok(!post.leads.some((lead) => lead.kind === "booking"), `${label}: the post's company numbers are not the customer's phone`);
      assert.ok(post.leads.some((lead) => lead.kind === "handoff" && lead.context.includes(ENDED_NAME)), `${label}: staff hear about the ended trip`);

      const february = await say("Энэ аялал 2098оны 2сард байгаа юу? Цагаан сарын үеэр");
      assert.ok(february.said.startsWith(`${ENDED_NAME} — аялал дууссан, 2 сард гарахгүй.\n`), `${label}: "this trip" is the ended trip: ${february.said}`);
      assert.match(february.said, /2 сард ижил чиглэлд:\n• УБ-Норвел хотын 1,2,3-р сарын аяллын хөтөлбөр — 2\/18/u, february.said);
      assert.ok(ownLines(february.said) <= 6, `${label}: short: ${february.said}`);
      assert.doesNotMatch(february.said, OTHER_DIRECTIONS, `${label}: no unrelated February list: ${february.said}`);

      const named = await say("Норвел калдара");
      assert.ok(named.said.startsWith(`${ENDED_NAME} — аялал дууссан`), `${label}: two words only the ended trip holds together name it: ${named.said}`);

      const again = await say("Норвел лунария хаалгын аялал");
      assert.ok(again.said.startsWith(`${ENDED_NAME} — аялал дууссан`), `${label}: ${again.said}`);
      assert.doesNotMatch(again.said, /11-р сарын аяллын хөтөлбөр — энэ аяллын/u, `${label}: not the full sibling's notice: ${again.said}`);

      const month = await say("2-р сарын");
      assert.match(month.said, /УБ-Норвел хотын 1,2,3-р сарын аяллын хөтөлбөр/u, `${label}: the open trip leaving in February: ${month.said}`);
      assert.match(month.said, /2 сарын 18/u);

      const byName = await say("Уб норвел хотын 2-р сарын аялал");
      assert.doesNotMatch(byName.said, /суудал дууссан/u, `${label}: the February trip, not the full November one: ${byName.said}`);
      assert.match(byName.said, /2 сарын 18/u, byName.said);
    } finally {
      await harness.close();
    }
  });
});

test("an open trip's shared post gets its card, and a month it does not run gets the same direction's trips first", async (outer) => {
  for (const [label, model] of readings) await outer.test(label, async (context) => {
    const harness = await conversation(context, false);
    const sender = `open-${label}`;
    const say = async (text: string) => {
      const result = await harness.turn(sender, text, model, undefined, { platform: "facebook" });
      context.mock.timers.tick(30_000);
      return { ...result, said: textOf(result.sends) };
    };
    try {
      const post = await say(POST);
      assert.ok(post.said.startsWith(`✈️ ${ENDED_NAME}`), `${label}: the shared post gets the trip's card: ${post.said}`);
      assert.match(post.said, /1\/21/u);
      assert.doesNotMatch(post.said, /^Утасны дугаараа бичнэ үү\.?$/mu, `${label}: a shared post is not a booking request`);
      assert.ok(!post.leads.some((lead) => lead.kind === "booking"), `${label}: no phone lead from the post's company numbers`);

      const february = await say("Энэ аялал 2098оны 2сард байгаа юу? Цагаан сарын үеэр");
      assert.ok(february.said.startsWith(`${ENDED_NAME} 2 сард гарахгүй.`), `${label}: about this trip first: ${february.said}`);
      assert.match(february.said, /1 сарын 21/u);
      assert.match(february.said, /2 сард ижил чиглэлд:\n• УБ-Норвел хотын 1,2,3-р сарын аяллын хөтөлбөр — 2\/18/u, february.said);
      assert.ok(ownLines(february.said) <= 7, `${label}: short: ${february.said}`);
      assert.doesNotMatch(february.said, /Энэ чиглэлд 2 сард гарах аялал алга/u, `${label}: a trip of this direction does leave then`);
      assert.doesNotMatch(february.said, OTHER_DIRECTIONS, `${label}: ${february.said}`);
    } finally {
      await harness.close();
    }
  });
});

test("an ended trip keeps its website page as an ended programme; an open or staff-archived trip does not", async () => {
  const { websiteEndedProgramme } = await import("../src/lib/endedTrip");
  const [ended] = catalogue(true);
  assert.deepEqual(websiteEndedProgramme(ended), {
    ended: true, departure_date: "2097 оны 11 сарын 19", adult_price: 3_111_000, child_price_min: 2_811_000, child_price_max: 2_811_000,
    group_note: "10+ хүнтэй байгууллага, групп бол өөрсдийн сонгосон өдрөөр явж болно.",
  });
  assert.equal(websiteEndedProgramme(catalogue(false)[0]), null, "a re-activated trip is an ordinary page again");
  assert.equal(websiteEndedProgramme({ ...ended, extra: { ...ended.extra, archived_reason: "owner_cancelled" } } as FixtureTrip), null, "staff archived it for a reason");
  assert.equal(websiteEndedProgramme({ ...ended, extra: { ...ended.extra, customer_visible: false } } as FixtureTrip), null, "a hidden trip stays hidden");
});
