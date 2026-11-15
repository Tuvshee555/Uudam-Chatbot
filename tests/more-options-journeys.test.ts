import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { conversationGateHarness, type ModelOverride as BaseOverride } from "./helpers/conversationGateHarness";
import { day, textOf, trip } from "./helpers/understandingRoutingFixtures";

/**
 * Owner, 2026-11-14 (real chat "12.27нд шанхай аялал бна уу"): the bot said no trip that day and offered ONE
 * date of that city, 5 days earlier, while seven other trips left on the asked day. "Give this guy similar trips
 * or closer dates … more options should have been there." A consultant offers the city's dates on both sides of
 * the asked day AND the other trips leaving around then. Every town, trip, price and date below is invented.
 */
type ModelOverride = BaseOverride & { trips?: string[]; transport?: string | null };
const days = Array.from({ length: 5 }, (_, i) => day(i + 1, `ӨДӨР ${i + 1}`, `Хөтөлбөр ${i + 1} (invented).`));
const kind = (transport: string) => ({ extra: { transport_type: transport, aliases: [], itinerary_days: days } });
const catalogue = () => [
  // The asked city: two trips, neither leaves on 2/20; the nearest are 2/15 (before) and 3/10 (after).
  trip("dec", "УБ-ВЕЛМОРА хотын 2-р сарын аяллын хөтөлбөр", ["2098-02-15"], [2_990_000, 2_690_000, null], kind("direct_flight")),
  trip("jan", "УБ-ВЕЛМОРА хотын 3-р сарын аяллын хөтөлбөр", ["2098-03-10"], [2_890_000, 2_590_000, null], kind("direct_flight")),
  // Other trips leaving around 2/20.
  trip("isle", "МАРИНА АРЛЫН АЯЛАЛ", ["2098-02-21"], [3_100_000, 2_700_000, null], kind("direct_flight")),
  trip("ground", "ТОРВЕН – КЕЛДАР ГАЗРЫН АЯЛАЛ", ["2098-02-20"], [1_290_000, 990_000, null], kind("land")),
  trip("sea", "ЧЭВОН УСАН ОНГОЦНЫ АЯЛАЛ", ["2098-02-19"], [4_990_000, 4_490_000, null], kind("cruise")),
  // Too far from the asked day to be "around then".
  trip("far", "ЛУМИС ХОТЫН АЯЛАЛ", ["2098-03-02"], [1_590_000, 1_290_000, null], kind("direct_flight")),
];
const CITY = ["УБ-ВЕЛМОРА хотын 2-р сарын аяллын хөтөлбөр", "УБ-ВЕЛМОРА хотын 3-р сарын аяллын хөтөлбөр"];
const reading: ModelOverride = { place: "велмора", trips: ["T1", "T2"], certainty: "several", date: "2098-02-20", topics: ["dates"] };

test("no departure on the asked day: the city's dates on both sides AND other trips leaving around then", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(catalogue());
  try {
    let answered = 0;
    for (const [label, model] of [["model reads the city", reading], ["model unavailable", { unavailable: true } as ModelOverride]] as const) {
      const result = await harness.turn(`mo-${label}`, "2.20нд велмора аялал бна уу", model);
      const said = textOf(result.sends);
      if (!result.sends.length) { assert.ok(result.leads.length > 0, `${label}: silence without a staff lead`); continue; }
      answered += 1;
      assert.match(said, /Энэ чиглэлд 2 сарын 20-нд гарах аялал алга\./u, `${label}: "none in this direction", not "nothing leaves": ${said}`);
      assert.ok(said.includes(`• ${CITY[0]}: 2 сарын 15`), `${label}: the city's date before: ${said}`);
      assert.ok(said.includes(`• ${CITY[1]}: 3 сарын 10`), `${label}: and after: ${said}`);
      assert.match(said, /Тэр үеэр гарах өөр аяллууд:/u, `${label}: other trips around then: ${said}`);
      const others = said.slice(said.indexOf("Тэр үеэр гарах өөр аяллууд:")).split("\n").filter((line) => line.startsWith("•"));
      assert.equal(others[0], "• МАРИНА АРЛЫН АЯЛАЛ: 2 сарын 21", `${label}: the same kind (flight) first: ${said}`);
      assert.ok(others.some((line) => line.includes("ТОРВЕН – КЕЛДАР ГАЗРЫН АЯЛАЛ: 2 сарын 20")), `${label}: the trip leaving that very day: ${said}`);
      assert.ok(!said.includes("ЛУМИС"), `${label}: nothing ten days away in "around then": ${said}`);
    }
    assert.equal(answered, 2, "both readings answer (the model is not needed for this reply)");
  } finally {
    await harness.close();
  }
});

test("a number under that reply picks the row shown, including one of the other trips", async (context: TestContext) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(catalogue());
  try {
    const sender = "mo-pick";
    const list = await harness.turn(sender, "2.20нд велмора аялал бна уу", reading);
    const rows = textOf(list.sends).split("\n").filter((line) => line.startsWith("•"));
    assert.ok(rows.length >= 4, `several rows: ${textOf(list.sends)}`);
    const third = rows[2].slice(2, rows[2].indexOf(":"));
    const pick = await harness.turn(sender, "3", { unavailable: true });
    assert.ok(textOf(pick.sends).includes(third), `"3" is the third row shown (${third}): ${textOf(pick.sends)}`);
  } finally {
    await harness.close();
  }
});

test("'by land' keeps the other trips to land trips", async () => {
  const { buildNearestDatesReply } = await import("../src/lib/dateAlternatives");
  const { buildScopedNotScheduledReply } = await import("../src/lib/dateNotScheduled");
  const now = new Date("2098-02-01T04:00:00Z");
  const all = catalogue();
  const city = all.filter((t) => t.id === "dec" || t.id === "jan");
  const landOnly = buildScopedNotScheduledReply(city, "2 сарын 20-нд газраар", now, all) ?? "";
  assert.ok(!landOnly.includes("МАРИНА") && !landOnly.includes("ЧЭВОН"), `no flight or cruise for "газраар": ${landOnly}`);
  // Without the rest of the catalogue the reply is the city's dates alone, as before.
  const alone = buildNearestDatesReply(city, "2 сарын 20-нд", now) ?? "";
  assert.ok(!alone.includes("Тэр үеэр гарах өөр аяллууд:") && alone.startsWith("2 сарын 20-нд гарах аялал алга."), alone);
});
